// whoop_activity_log: v2 create by internal_name. The nap/sleep cases port PR #29's
// whoop_nap_create tests (@k-vasily), with the read-back moved to sleep-details.
import { describe, expect, it } from "vitest";
import { registerActivityLog } from "../../src/tools/v2/activity_log.js";
import {
  activityRecord, badRequest, cardioDetails, conflict, connect, fakeWhoop, notFound, sleepDetails, textOf, unrouted, type Call,
} from "./activity_test_utils.js";

const CREATE = "/core-details-bff/v2/create-activity";
const CARDIO = "/core-details-bff/v1/cardio-details";
const noSleep = { sleep: async () => {} };

async function logTool(route: (c: Call) => unknown) {
  const fake = fakeWhoop(route);
  const client = await connect((s) => registerActivityLog(s, fake.whoop, noSleep));
  return { ...fake, call: (args: Record<string, unknown>) => client.callTool({ name: "whoop_activity_log", arguments: args }) };
}

describe("whoop_activity_log validation (nothing sent)", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["sub-minute window", { type: "nap", start: "2026-09-07T12:00:00-04:00", end: "2026-09-07T12:00:30-04:00" }, "one minute"],
    ["end before start", { type: "tennis", start: "2026-09-07T12:00:00Z", end: "2026-09-07T11:00:00Z" }, "one minute"],
    ["future end", { type: "tennis", start: "2026-09-07T12:00:00Z", end: "2099-01-01T00:00:00Z" }, "future"],
    ["both type and sport_id", { type: "tennis", sport_id: 34, start: "2026-09-07T12:00:00Z", end: "2026-09-07T12:30:00Z" }, "exactly one"],
    ["neither type nor sport_id", { start: "2026-09-07T12:00:00Z", end: "2026-09-07T12:30:00Z" }, "exactly one"],
    ["retired sport id", { sport_id: 54, start: "2026-09-07T12:00:00Z", end: "2026-09-07T12:30:00Z" }, "Jogging"],
    ["unknown garment", { type: "tennis", garment_id: 99, start: "2026-09-07T12:00:00Z", end: "2026-09-07T12:30:00Z" }, "garment_id"],
  ];
  for (const [label, args, msg] of cases) {
    it(`rejects ${label}`, async () => {
      const t = await logTool((c) => {
        // The unknown-type path may re-fetch the live catalogs; nothing else.
        if (c.path === "/activities-service/v1/sports" || c.path === "/activities-service/v2/activity-types") return [];
        return unrouted(c);
      });
      const r = await t.call({ ...args, confirm: true });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain(msg);
      expect(t.writes()).toHaveLength(0);
    });
  }

  it("returns the 5 closest types for an unknown name (after a live catalog re-check)", async () => {
    const t = await logTool((c) => {
      if (c.path === "/activities-service/v1/sports" || c.path === "/activities-service/v2/activity-types") return [];
      return unrouted(c);
    });
    const r = await t.call({ type: "tenis", start: "2026-09-07T12:00:00Z", end: "2026-09-07T12:30:00Z", confirm: true });
    expect(r.isError).toBe(true);
    const body = textOf(r);
    expect(body.suggestions).toHaveLength(5);
    expect((body.suggestions as string[])[0]).toBe("tennis (Tennis)");
    expect(t.writes()).toHaveLength(0);
  });

  it("accepts a type WHOOP shipped after this build via the live catalog", async () => {
    const t = await logTool((c) => {
      if (c.path === "/activities-service/v1/sports") return [{ id: 999, name: "Zorbing", is_current: true }];
      if (c.path === "/activities-service/v2/activity-types") return [{ internal_name: "zorbing", display_name: "Zorbing", score_type: "CARDIO", category: "cardiovascular" }];
      return unrouted(c);
    });
    const r = await t.call({ type: "Zorbing", start: "2026-09-07T12:00:00Z", end: "2026-09-07T12:30:00Z" });
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(textOf(r))).toContain("\"activity_internal_name\":\"zorbing\"");
  });
});

describe("whoop_activity_log writes", () => {
  it("previews without mutating, then sends the v2 body with millisecond UTC timestamps", async () => {
    const t = await logTool((c) => {
      if (c.method === "POST" && c.path === CREATE) return activityRecord();
      if (c.path === CARDIO) return cardioDetails("tennis", "2026-11-21T16:40:00.000Z", "2026-11-21T16:45:00.000Z");
      return unrouted(c);
    });
    const args = { type: "Tennis", start: "2026-11-21T08:40:00-08:00", end: "2026-11-21T08:45:00-08:00" };
    const preview = textOf(await t.call(args));
    expect(preview).toMatchObject({ preview: true, will_execute: { method: "POST", path: CREATE } });
    expect(t.writes()).toHaveLength(0);

    const r = await t.call({ ...args, confirm: true });
    expect(r.isError).not.toBe(true);
    expect(t.writes()).toEqual([{
      method: "POST", path: CREATE, query: {},
      body: { activity_internal_name: "tennis", start_time: "2026-11-21T16:40:00.000Z", end_time: "2026-11-21T16:45:00.000Z", gps_enabled: false },
    }]);
    const readBack = t.calls.find((c) => c.method === "GET" && c.path === CARDIO)!;
    expect(readBack).toMatchObject({ query: { activityId: "act-1" }, fresh: true });
    expect(textOf(r)).toMatchObject({ created: true, activity_id: "act-1", type: "tennis", score_type: "CARDIO", version: 0, cycle_id_informational: 1974268448, verified: true });
  });

  it("maps a sport_id through the catalog and passes garment_id", async () => {
    const t = await logTool((c) => {
      if (c.method === "POST") return activityRecord({ type: "ski-erg", during: "['2026-11-21T16:00:00.000Z','2026-11-21T16:20:00.000Z')" });
      if (c.path === CARDIO) return cardioDetails("ski-erg", "2026-11-21T16:00:00.000Z", "2026-11-21T16:20:00.000Z");
      return unrouted(c);
    });
    await t.call({ sport_id: 339, garment_id: 1, start: "2026-11-21T16:00:00Z", end: "2026-11-21T16:20:00Z", confirm: true });
    expect(t.writes()[0]!.body).toMatchObject({ activity_internal_name: "ski-erg", garment_id: 1 });
  });

  it("logs a recovery type through the same create", async () => {
    const t = await logTool((c) => {
      if (c.method === "POST") return activityRecord({ type: "sauna", score_type: "RECOVERY", during: "['2026-11-21T15:00:00.000Z','2026-11-21T15:20:00.000Z')" });
      if (c.path === CARDIO) return cardioDetails("sauna", "2026-11-21T15:00:00.000Z", "2026-11-21T15:20:00.000Z", "RECOVERY");
      return unrouted(c);
    });
    const r = await t.call({ type: "sauna", start: "2026-11-21T15:00:00Z", end: "2026-11-21T15:20:00Z", confirm: true });
    expect(t.writes()[0]!.path).toBe(CREATE);
    expect(textOf(r)).toMatchObject({ score_type: "RECOVERY", verified: true });
  });

  it("logs a nap and reads it back via sleep-details, never cardio-details (PR #29 port)", async () => {
    const t = await logTool((c) => {
      if (c.method === "POST") return activityRecord({ id: "nap-1", type: "nap", score_type: "SLEEP", during: "['2026-09-07T16:00:00.000Z','2026-09-07T16:20:00.000Z')" });
      if (c.path === "/core-details-bff/v2/sleep-details/nap-1") return sleepDetails(true, "2026-09-07T16:00:00.000Z", "2026-09-07T16:20:00.000Z");
      if (c.path === CARDIO) throw badRequest(c.path, "Cannot view activity details for a pending activity");
      return unrouted(c);
    });
    const r = await t.call({ type: "nap", start: "2026-09-07T12:00:00-04:00", end: "2026-09-07T12:20:00-04:00", confirm: true });
    expect(t.writes()[0]!.body).toEqual({ activity_internal_name: "nap", start_time: "2026-09-07T16:00:00.000Z", end_time: "2026-09-07T16:20:00.000Z", gps_enabled: false });
    expect(t.calls.some((c) => c.path === CARDIO)).toBe(false);
    expect(textOf(r)).toMatchObject({ created: true, activity_id: "nap-1", type: "nap", score_type: "SLEEP", verified: true });
  });

  it("warns that a main sleep re-cuts the day's cycles, in the preview and the receipt", async () => {
    const t = await logTool((c) => {
      if (c.method === "POST") return activityRecord({ id: "sleep-1", type: "sleep", score_type: "SLEEP", during: "['2026-09-07T02:00:00.000Z','2026-09-07T03:00:00.000Z')" });
      if (c.path === "/core-details-bff/v2/sleep-details/sleep-1") return sleepDetails(false, "2026-09-07T02:00:00.000Z", "2026-09-07T03:00:00.000Z");
      return unrouted(c);
    });
    const args = { type: "sleep", start: "2026-09-07T02:00:00Z", end: "2026-09-07T03:00:00Z" };
    expect(JSON.stringify(textOf(await t.call(args)))).toContain("re-cuts the day's cycles");
    const r = textOf(await t.call({ ...args, confirm: true }));
    expect(r).toMatchObject({ type: "sleep", verified: true });
    expect(String(r.warnings)).toContain("re-cuts the day's cycles");
  });

  it("retries a sleep read-back that isn't readable yet", async () => {
    let reads = 0;
    const t = await logTool((c) => {
      if (c.method === "POST") return activityRecord({ id: "nap-2", type: "nap", score_type: "SLEEP", during: "['2026-09-07T16:00:00.000Z','2026-09-07T16:20:00.000Z')" });
      if (c.path === "/core-details-bff/v2/sleep-details/nap-2") {
        reads++;
        if (reads < 2) throw notFound(c.path);
        return sleepDetails(true, "2026-09-07T16:00:00.000Z", "2026-09-07T16:20:00.000Z");
      }
      return unrouted(c);
    });
    const r = textOf(await t.call({ type: "nap", start: "2026-09-07T16:00:00Z", end: "2026-09-07T16:20:00Z", confirm: true }));
    expect(reads).toBe(2);
    expect(r.verified).toBe(true);
  });

  it("reports verified:false when WHOOP files a requested main sleep as a nap", async () => {
    const t = await logTool((c) => {
      if (c.method === "POST") return activityRecord({ id: "s2", type: "sleep", score_type: "SLEEP", during: "['2026-09-07T02:00:00.000Z','2026-09-07T03:00:00.000Z')" });
      if (c.path === "/core-details-bff/v2/sleep-details/s2") return sleepDetails(true, "2026-09-07T02:00:00.000Z", "2026-09-07T03:00:00.000Z");
      return unrouted(c);
    });
    const r = textOf(await t.call({ type: "sleep", start: "2026-09-07T02:00:00Z", end: "2026-09-07T03:00:00Z", confirm: true }));
    expect(r.verified).toBe(false);
    expect(String(r.warnings)).toContain("as a nap");
  });

  it("reports verified:false when the read-back never finds it", async () => {
    const t = await logTool((c) => {
      if (c.method === "POST") return activityRecord();
      if (c.path === CARDIO) throw notFound(c.path);
      return unrouted(c);
    });
    const r = textOf(await t.call({ type: "tennis", start: "2026-11-21T16:40:00Z", end: "2026-11-21T16:45:00Z", confirm: true }));
    expect(r).toMatchObject({ created: true, verified: false });
  });

  it("surfaces WHOOP's 409 overlap list", async () => {
    const body = JSON.stringify({
      overlapping_activities: ["**Rowing** - 7:45 AM - 7:55 AM"],
      resolution: "Please go back and edit your activity or delete the overlapping activities to continue.",
      error_title: "OVERLAPPING ACTIVITIES",
    });
    const t = await logTool((c) => { if (c.method === "POST") throw conflict(c.path, body); return unrouted(c); });
    const r = await t.call({ type: "golf", start: "2026-11-21T15:50:00Z", end: "2026-11-21T16:00:00Z", confirm: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatchObject({ status: 409, overlapping_activities: ["Rowing 7:45 AM – 7:55 AM"] });
  });

  it("surfaces a structured WHOOP rejection", async () => {
    const t = await logTool((c) => { if (c.method === "POST") throw badRequest(c.path, "Activity start time must be before end time"); return unrouted(c); });
    const r = await t.call({ type: "tennis", start: "2026-11-21T15:50:00Z", end: "2026-11-21T16:00:00Z", confirm: true });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Activity start time must be before end time");
  });
});
