// whoop_activity_edit: cardio-details PUT for CARDIO/RECOVERY and nap→sleep,
// sleep-details PUT for sleep windows, resolve_overlaps gated on exact ids, and the
// main-sleep demotion repair.
import { describe, expect, it } from "vitest";
import { registerActivityEdit } from "../../src/tools/v2/activity_edit.js";
import {
  activityRecord, cardioDetails, conflict, connect, fakeWhoop, homeWith, notFound, sleepDetails, textOf, unrouted, type Call,
} from "./activity_test_utils.js";

const REC = (id: string): string => `/activities-service/v2/activities/${id}`;
const CARDIO_V1 = "/core-details-bff/v1/cardio-details";
const CARDIO_V2 = "/core-details-bff/v2/cardio-details";
const SLEEP = (id: string): string => `/core-details-bff/v2/sleep-details/${id}`;
const HOME = "/home-service/v1/home";

async function editTool(route: (c: Call) => unknown) {
  const fake = fakeWhoop(route);
  const client = await connect((s) => registerActivityEdit(s, fake.whoop));
  return { ...fake, call: (args: Record<string, unknown>) => client.callTool({ name: "whoop_activity_edit", arguments: args }) };
}

/** A boxing activity whose server state follows the last PUT. */
function cardioWorld() {
  let state = { type: "boxing", score_type: "CARDIO", start: "2026-11-21T14:00:00.000Z", end: "2026-11-21T14:20:00.000Z", version: 1 };
  return {
    route: (c: Call): unknown => {
      if (c.method === "GET" && c.path === REC("a1")) {
        return activityRecord({ id: "a1", type: state.type, score_type: state.score_type, version: state.version, during: `['${state.start}','${state.end}')` }, false);
      }
      if (c.method === "GET" && c.path === CARDIO_V1) return cardioDetails(state.type, state.start, state.end, state.score_type);
      if (c.method === "PUT" && c.path === CARDIO_V2) {
        const b = c.body as Record<string, string>;
        const scoreType = b.activity_internal_name === "meditation" ? "RECOVERY" : "CARDIO";
        state = { type: b.activity_internal_name!, score_type: scoreType, start: b.start_time!, end: b.end_time!, version: state.version + 1 };
        return activityRecord({ id: "a1", type: state.type, score_type: scoreType, version: state.version, during: `['${state.start}','${state.end}')` });
      }
      if (c.path === HOME) return homeWith([]);
      return unrouted(c);
    },
  };
}

describe("whoop_activity_edit validation (nothing sent)", () => {
  it("needs exactly one target and something to change", async () => {
    const t = await editTool(unrouted);
    expect((await t.call({ start: "2026-11-21T14:00:00Z", confirm: true })).isError).toBe(true);
    expect((await t.call({ activity_id: "a1", sleep_date: "2026-11-21", start: "2026-11-21T14:00:00Z", confirm: true })).isError).toBe(true);
    expect((await t.call({ activity_id: "a1", confirm: true })).isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  it("refuses future times and unknown types before any write", async () => {
    const t = await editTool((c) => {
      if (c.path === "/activities-service/v1/sports" || c.path === "/activities-service/v2/activity-types") return [];
      return unrouted(c);
    });
    const future = await t.call({ activity_id: "a1", end: "2099-01-01T00:00:00Z", confirm: true });
    expect(JSON.stringify(future.content)).toContain("future");
    // An unknown edit type is a 500 on WHOOP's side, so it never reaches the PUT.
    const unknown = await t.call({ activity_id: "a1", type: "boxxing-ish", confirm: true });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown).suggestions).toHaveLength(5);
    expect(t.writes()).toHaveLength(0);
  });
});

describe("whoop_activity_edit on CARDIO / RECOVERY", () => {
  it("previews, then PUTs cardio-details with the full body and reads the result back", async () => {
    const w = cardioWorld();
    const t = await editTool(w.route);
    const preview = textOf(await t.call({ activity_id: "a1", start: "2026-11-21T14:01:00Z", end: "2026-11-21T14:21:00Z" }));
    expect(preview).toMatchObject({ preview: true, will_execute: { method: "PUT", path: `${CARDIO_V2}?activityId=a1` } });
    expect(t.writes()).toHaveLength(0);
    expect(t.calls.every((c) => c.fresh)).toBe(true); // pre-reads are never cached

    const r = await t.call({ activity_id: "a1", start: "2026-11-21T14:01:00Z", end: "2026-11-21T14:21:00Z", confirm: true });
    expect(t.writes()).toEqual([{
      method: "PUT", path: CARDIO_V2, query: { activityId: "a1" },
      body: { start_time: "2026-11-21T14:01:00.000Z", end_time: "2026-11-21T14:21:00.000Z", activity_internal_name: "boxing" },
    }]);
    expect(textOf(r)).toMatchObject({
      edited: true, activity_id: "a1", verified: true,
      before: { type: "boxing", score_type: "CARDIO" },
      after: { type: "boxing", score_type: "CARDIO", version: 2 },
    });
  });

  it("keeps an omitted bound and changes the type across CARDIO→RECOVERY", async () => {
    const w = cardioWorld();
    const t = await editTool(w.route);
    const r = textOf(await t.call({ activity_id: "a1", type: "Meditation", end: "2026-11-21T14:30:00Z", confirm: true }));
    expect(t.writes()[0]!.body).toEqual({ start_time: "2026-11-21T14:00:00.000Z", end_time: "2026-11-21T14:30:00.000Z", activity_internal_name: "meditation" });
    expect(r).toMatchObject({ verified: true, after: { type: "meditation", score_type: "RECOVERY" } });
  });

  it("returns no_change without writing when nothing differs", async () => {
    const t = await editTool(cardioWorld().route);
    const r = textOf(await t.call({ activity_id: "a1", start: "2026-11-21T06:00:00-08:00", confirm: true }));
    expect(r).toMatchObject({ edited: false, no_change: true });
    expect(t.writes()).toHaveLength(0);
  });

  it("refuses to turn a workout into a sleep, and delete_overlapping on workouts", async () => {
    const t = await editTool(cardioWorld().route);
    expect((await t.call({ activity_id: "a1", type: "nap", confirm: true })).isError).toBe(true);
    const r = await t.call({ activity_id: "a1", start: "2026-11-21T13:50:00Z", delete_overlapping: ["x"], confirm: true });
    expect(JSON.stringify(r.content)).toContain("only applies to sleep");
    expect(t.writes()).toHaveLength(0);
  });

  it("maps the empty edit 409 to an overlap error listing what the home card shows", async () => {
    const t = await editTool((c) => {
      if (c.method === "GET" && c.path === REC("a1")) return activityRecord({ id: "a1", type: "boxing", during: "['2026-11-21T14:00:00.000Z','2026-11-21T14:20:00.000Z')" }, false);
      if (c.method === "PUT") throw conflict(c.path, "Client exception, status code: 409, from client: ApiActivityClient, with response body: ");
      if (c.path === HOME) return homeWith([{ id: "row-1", type: "CARDIO", internal_name: "rowing", start: "2026-11-21T15:45:00.000Z", end: "2026-11-21T15:55:00.000Z" }]);
      return unrouted(c);
    });
    const r = await t.call({ activity_id: "a1", start: "2026-11-21T15:40:00Z", end: "2026-11-21T15:50:00Z", confirm: true });
    expect(r.isError).toBe(true);
    expect(textOf(r).overlapping_activities).toEqual(["row-1 rowing 2026-11-21T15:45:00.000Z – 2026-11-21T15:55:00.000Z"]);
  });

  it("maps a missing activity", async () => {
    const t = await editTool((c) => { throw notFound(c.path); });
    const r = await t.call({ activity_id: "gone", start: "2026-11-21T14:00:00Z", confirm: true });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("doesn't exist");
    expect(t.writes()).toHaveLength(0);
  });
});

/** A sleep/nap world: `sleeps` maps id → {nap, start, end}; PUT sleep-details can demote once. */
function sleepWorld(opts: { demoteOnce?: boolean; others?: Array<{ id: string; type: string; internal_name: string; start: string; end: string }> } = {}) {
  const sleeps = new Map<string, { nap: boolean; start: string; end: string }>([
    ["s1", { nap: false, start: "2026-11-21T10:30:00.000Z", end: "2026-11-21T13:30:00.000Z" }],
    ["n1", { nap: true, start: "2026-11-21T08:30:00.000Z", end: "2026-11-21T09:00:00.000Z" }],
  ]);
  let demote = opts.demoteOnce ?? false;
  const others = opts.others ?? [];
  const deleted = new Set<string>();
  const rec = (id: string, version = 1) => {
    const s = sleeps.get(id)!;
    return activityRecord({ id, type: s.nap ? "nap" : "sleep", score_type: "SLEEP", version, during: `['${s.start}','${s.end}')` }, false);
  };
  return {
    sleeps,
    route: (c: Call): unknown => {
      const m = c.path.match(/^\/activities-service\/v2\/activities\/(.+)$/);
      if (c.method === "GET" && m && sleeps.has(m[1]!)) return rec(m[1]!);
      const sd = c.path.match(/^\/core-details-bff\/v2\/sleep-details\/(.+)$/);
      if (c.method === "GET" && sd) {
        if (deleted.has(sd[1]!)) throw notFound(c.path);
        const s = sleeps.get(sd[1]!);
        if (!s) throw notFound(c.path);
        return sleepDetails(s.nap, s.start, s.end);
      }
      if (c.method === "GET" && c.path === CARDIO_V1) {
        const id = c.query.activityId as string;
        if (deleted.has(id)) throw notFound(c.path);
        const o = others.find((x) => x.id === id);
        if (o) return cardioDetails(o.internal_name, o.start, o.end, o.type);
        throw notFound(c.path);
      }
      if (c.method === "PUT" && sd) {
        const b = c.body as Record<string, unknown>;
        const s = sleeps.get(sd[1]!)!;
        s.start = b.start_time as string;
        s.end = b.end_time as string;
        if (b.resolve_overlaps === true) for (const o of others) deleted.add(o.id);
        if (demote && !s.nap) { s.nap = true; demote = false; }
        return rec(sd[1]!, 2);
      }
      if (c.method === "PUT" && c.path === CARDIO_V2) {
        const b = c.body as Record<string, string>;
        const id = c.query.activityId as string;
        const s = sleeps.get(id)!;
        s.start = b.start_time!;
        s.end = b.end_time!;
        if (b.activity_internal_name === "sleep") s.nap = false;
        return { activity: rec(id, 3), strength_trainer_linkable: false };
      }
      if (c.method === "GET" && c.path === "/home-service/v1/deep-dive/sleep/last-night") {
        return { header_section: { destination: { screen: "ACTIVITY_EDIT", parameters: { activity_id: "s1", start_time: sleeps.get("s1")!.start, end_time: sleeps.get("s1")!.end } } } };
      }
      if (c.method === "GET" && c.path === HOME) return homeWith(others.filter((o) => !deleted.has(o.id)));
      return unrouted(c);
    },
  };
}

describe("whoop_activity_edit on sleeps and naps", () => {
  it("edits a main sleep window by sleep_date through sleep-details", async () => {
    const w = sleepWorld();
    const t = await editTool(w.route);
    const r = textOf(await t.call({ sleep_date: "2026-11-21", start: "2026-11-21T10:15:00Z", confirm: true }));
    expect(t.calls[0]).toMatchObject({ path: "/home-service/v1/deep-dive/sleep/last-night", query: { date: "2026-11-21" }, fresh: true });
    expect(t.writes()).toEqual([{ method: "PUT", path: SLEEP("s1"), query: {}, body: { start_time: "2026-11-21T10:15:00.000Z", end_time: "2026-11-21T13:30:00.000Z" } }]);
    expect(r).toMatchObject({ edited: true, activity_id: "s1", verified: true, after: { type: "sleep" } });
    expect(r).not.toHaveProperty("repaired");
  });

  it("repairs a main sleep that WHOOP demoted to a nap, once", async () => {
    const w = sleepWorld({ demoteOnce: true });
    const t = await editTool(w.route);
    const r = textOf(await t.call({ activity_id: "s1", start: "2026-11-21T10:15:00Z", end: "2026-11-21T13:45:00Z", confirm: true }));
    expect(t.writes().map((c) => c.path)).toEqual([SLEEP("s1"), CARDIO_V2]);
    expect(t.writes()[1]).toMatchObject({ query: { activityId: "s1" }, body: { activity_internal_name: "sleep", start_time: "2026-11-21T10:15:00.000Z", end_time: "2026-11-21T13:45:00.000Z" } });
    expect(r).toMatchObject({ repaired: true, verified: true, after: { type: "sleep", version: 3 } });
  });

  it("converts a nap to a main sleep through cardio-details, with the re-cycle warning", async () => {
    const w = sleepWorld();
    const t = await editTool(w.route);
    const preview = textOf(await t.call({ activity_id: "n1", type: "sleep" }));
    expect(JSON.stringify(preview)).toContain("re-cuts the day's cycles");
    const r = textOf(await t.call({ activity_id: "n1", type: "sleep", confirm: true }));
    expect(t.writes()).toEqual([{
      method: "PUT", path: CARDIO_V2, query: { activityId: "n1" },
      body: { start_time: "2026-11-21T08:30:00.000Z", end_time: "2026-11-21T09:00:00.000Z", activity_internal_name: "sleep" },
    }]);
    expect(r).toMatchObject({ verified: true, before: { type: "nap" }, after: { type: "sleep" } });
  });

  it("refuses sleep→nap (WHOOP silently ignores it)", async () => {
    const t = await editTool(sleepWorld().route);
    const r = await t.call({ activity_id: "s1", type: "nap", confirm: true });
    expect(r.isError).toBe(true);
    expect(t.writes()).toHaveLength(0);
  });

  const nap = { id: "n9", type: "SLEEP", internal_name: "nap", start: "2026-11-21T09:30:00.000Z", end: "2026-11-21T10:00:00.000Z" };

  it("lists overlaps in the preview and sends no resolve_overlaps without delete_overlapping", async () => {
    const w = sleepWorld({ others: [nap] });
    const t = await editTool(w.route);
    const preview = textOf(await t.call({ activity_id: "s1", start: "2026-11-21T09:00:00Z" }));
    const summary = (preview.will_execute as { body_summary: Record<string, unknown> }).body_summary;
    expect(summary.overlapping).toEqual([expect.stringContaining("n9 nap")]);
    expect(summary.will_delete).toEqual([]);
    expect(String(summary.warnings)).toContain("DELETES");
    await t.call({ activity_id: "s1", start: "2026-11-21T09:00:00Z", confirm: true });
    expect(t.writes()[0]!.body).not.toHaveProperty("resolve_overlaps");
  });

  it("refuses delete_overlapping that doesn't match exactly what would be deleted", async () => {
    const w = sleepWorld({ others: [nap] });
    const t = await editTool(w.route);
    const r = await t.call({ activity_id: "s1", start: "2026-11-21T09:00:00Z", delete_overlapping: ["someone-else"], confirm: true });
    expect(r.isError).toBe(true);
    expect(textOf(r).would_delete).toEqual([expect.stringContaining("n9")]);
    expect(t.writes()).toHaveLength(0);
    const none = await t.call({ activity_id: "s1", start: "2026-11-21T10:20:00Z", delete_overlapping: ["n9"], confirm: true });
    expect(JSON.stringify(none.content)).toContain("Nothing overlaps");
    expect(t.writes()).toHaveLength(0);
  });

  it("sends resolve_overlaps for an exact id list and verifies the deletions", async () => {
    const w = sleepWorld({ others: [nap] });
    const t = await editTool(w.route);
    const r = textOf(await t.call({ activity_id: "s1", start: "2026-11-21T09:00:00Z", delete_overlapping: ["n9"], confirm: true }));
    expect(t.writes()).toEqual([{ method: "PUT", path: SLEEP("s1"), query: {}, body: { start_time: "2026-11-21T09:00:00.000Z", end_time: "2026-11-21T13:30:00.000Z", resolve_overlaps: true } }]);
    expect(r).toMatchObject({ verified: true, deleted_overlapping: ["n9"] });
  });

  it("maps the structured sleep 409", async () => {
    const body = JSON.stringify({ overlapping_activities: ["**Sleep** - 2:15 AM - 5:45 AM"], message: "You've selected **1:30 AM to 2:30 AM**…" });
    const w = sleepWorld();
    const t = await editTool((c) => {
      if (c.method === "PUT") throw conflict(c.path, body);
      return w.route(c);
    });
    const r = await t.call({ activity_id: "n1", start: "2026-11-21T09:30:00Z", end: "2026-11-21T10:30:00Z", confirm: true });
    expect(textOf(r)).toMatchObject({ status: 409, overlapping_activities: ["Sleep 2:15 AM – 5:45 AM"] });
  });
});
