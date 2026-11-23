// whoop_activity_edit merge: PATCH cd/v1/activities/merge?startTime=&endTime= [ids].
// The fake follows what WHOOP did live on 2026-11-22: it keeps the earliest
// activity (id and type) over the query bounds, deletes the rest whatever order
// the ids come in, and answers 422 while an activity inside the bounds is pending.
import { describe, expect, it } from "vitest";
import { registerActivityEdit } from "../../src/tools/v2/activity_edit.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { activityRecord, cardioDetails, connect, fakeWhoop, homeWith, notFound, textOf, unrouted, type Call } from "./activity_test_utils.js";

const REC = (id: string): string => `/activities-service/v2/activities/${id}`;
const CARDIO_V1 = "/core-details-bff/v1/cardio-details";
const HOME = "/home-service/v1/home";
const MERGE = "/core-details-bff/v1/activities/merge";

interface Act { type: string; score_type: string; start: string; end: string }

function mergeWorld(acts: Record<string, Act>, opts: { pending?: boolean; stranger?: boolean } = {}) {
  const state = new Map(Object.entries(acts));
  const route = (c: Call): unknown => {
    const id = (c.path.startsWith("/activities-service/v2/activities/") ? c.path.split("/").pop() : (c.query.activityId as string | undefined)) ?? "";
    if (c.method === "GET" && (c.path === REC(id) || c.path === CARDIO_V1)) {
      const a = state.get(id);
      if (!a) throw notFound(c.path);
      return c.path === CARDIO_V1
        ? cardioDetails(a.type, a.start, a.end, a.score_type)
        : activityRecord({ id, type: a.type, score_type: a.score_type, during: `['${a.start}','${a.end}')` }, false);
    }
    if (c.method === "GET" && c.path === HOME) {
      const tiles = [...state].map(([tid, a]) => ({ id: tid, type: a.score_type, internal_name: a.type, start: a.start, end: a.end }));
      if (opts.stranger) tiles.push({ id: "x9", type: "CARDIO", internal_name: "yoga", start: "2026-11-21T14:05:30.000Z", end: "2026-11-21T14:06:30.000Z" });
      return homeWith(tiles);
    }
    if (c.method === "PATCH" && c.path === MERGE) {
      if (opts.pending) throw new WhoopApiError(422, MERGE, "Requested merge bounds includes a pending activity with id a2", "422");
      const ids = c.body as string[];
      const keep = [...ids].sort((x, y) => Date.parse(state.get(x)!.start) - Date.parse(state.get(y)!.start))[0]!;
      const k = state.get(keep)!;
      for (const other of ids) if (other !== keep) state.delete(other);
      const merged = { ...k, start: c.query.startTime as string, end: c.query.endTime as string };
      state.set(keep, merged);
      return activityRecord({ id: keep, type: merged.type, score_type: merged.score_type, during: `['${merged.start}','${merged.end}')`, version: 1 }, false);
    }
    return unrouted(c);
  };
  return { route, state };
}

const TWO: Record<string, Act> = {
  a1: { type: "running", score_type: "CARDIO", start: "2026-11-21T14:00:00.000Z", end: "2026-11-21T14:05:00.000Z" },
  a2: { type: "walking", score_type: "CARDIO", start: "2026-11-21T14:07:00.000Z", end: "2026-11-21T14:12:00.000Z" },
};

async function tool(route: (c: Call) => unknown) {
  const fake = fakeWhoop(route);
  const client = await connect((s) => registerActivityEdit(s, fake.whoop));
  return { ...fake, call: (args: Record<string, unknown>) => client.callTool({ name: "whoop_activity_edit", arguments: args }) };
}

describe("whoop_activity_edit merge", () => {
  it("previews the PATCH with the earliest first and sends nothing", async () => {
    const t = await tool(mergeWorld(TWO).route);
    const out = textOf(await t.call({ activity_id: "a2", merge: ["a1"] }));
    expect(t.writes()).toHaveLength(0);
    const exec = out.will_execute as { method: string; path: string; body_summary: Record<string, unknown> };
    expect(exec.method).toBe("PATCH");
    expect(exec.path).toBe(`${MERGE}?startTime=2026-11-21T14:00:00.000Z&endTime=2026-11-21T14:12:00.000Z`);
    expect(exec.body_summary.body).toEqual(["a1", "a2"]);
    expect((exec.body_summary.keep as { activity_id: string }).activity_id).toBe("a1");
    expect(exec.body_summary.will_delete).toEqual([expect.stringContaining("a2 walking")]);
    expect(JSON.stringify(exec.body_summary.warnings)).toContain("no undo");
  });

  it("merges, reports the survivor and the deleted ids, and verifies", async () => {
    const w = mergeWorld(TWO);
    const t = await tool(w.route);
    const out = textOf(await t.call({ activity_id: "a2", merge: ["a1"], confirm: true }));
    const patch = t.writes()[0]!;
    expect(patch).toMatchObject({ method: "PATCH", path: MERGE, query: { startTime: "2026-11-21T14:00:00.000Z", endTime: "2026-11-21T14:12:00.000Z" }, body: ["a1", "a2"] });
    expect(out).toMatchObject({ edited: true, activity_id: "a1", merged: ["a2"], verified: true });
    expect((out.after as { type: string }).type).toBe("running");
    expect([...w.state.keys()]).toEqual(["a1"]);
  });

  it("refuses when another activity sits inside the joint window", async () => {
    const t = await tool(mergeWorld(TWO, { stranger: true }).route);
    const res = await t.call({ activity_id: "a1", merge: ["a2"], confirm: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("x9");
    expect(t.writes()).toHaveLength(0);
  });

  it("refuses sleeps and naps", async () => {
    const t = await tool(mergeWorld({ ...TWO, n1: { type: "nap", score_type: "SLEEP", start: "2026-11-21T15:00:00.000Z", end: "2026-11-21T15:20:00.000Z" } }).route);
    const res = await t.call({ activity_id: "a1", merge: ["n1"], confirm: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("only merges workouts");
    expect(t.writes()).toHaveLength(0);
  });

  it("says to retry when WHOOP is still scoring one of them", async () => {
    const t = await tool(mergeWorld(TWO, { pending: true }).route);
    const res = await t.call({ activity_id: "a1", merge: ["a2"], confirm: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("still scoring");
  });

  it("can't be combined with other changes or a sleep_date", async () => {
    const t = await tool(unrouted);
    expect((await t.call({ activity_id: "a1", merge: ["a2"], start: "2026-11-21T13:00:00Z" })).isError).toBe(true);
    expect((await t.call({ sleep_date: "2026-11-21", merge: ["a2"] })).isError).toBe(true);
    expect((await t.call({ activity_id: "a1", merge: ["a1"] })).isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });
});
