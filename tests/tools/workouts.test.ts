// whoop_workouts: app-native list from home?date=, detail from cardio-details
// (+ recovery-details), developer list only behind WHOOP_DEV_V2_LISTS.
import { afterEach, describe, expect, it } from "vitest";
import { registerWorkouts } from "../../src/tools/v2/workouts.js";
import { activityRecord, badRequest, connect, fakeWhoop, homeWith, loadFixture, notFound, textOf, unrouted, type Call } from "./activity_test_utils.js";

const CAL = "/home-service/v1/calendar/overview";
const RECORD = (id: string): string => `/activities-service/v2/activities/${id}`;
const PENDING_400 = "Cannot view activity details for a pending activity";
const HOME = "/home-service/v1/home";
const CARDIO = "/core-details-bff/v1/cardio-details";
const RECOVERY = "/core-details-bff/v2/recovery-details";

afterEach(() => {
  delete process.env.WHOOP_DEV_V2_LISTS;
});

describe("whoop_workouts list", () => {
  it("walks home?date= only for calendar days with data and returns CARDIO + RECOVERY rows", async () => {
    const { whoop, calls } = fakeWhoop((c: Call) => {
      if (c.path === CAL) return loadFixture("activities/calendar_overview_2026-11.json");
      if (c.path === HOME) return loadFixture("activities/home_2026-11-21.json");
      return unrouted(c);
    });
    const client = await connect((s) => registerWorkouts(s, whoop));
    const out = textOf(await client.callTool({ name: "whoop_workouts", arguments: { start_date: "2026-11-18", end_date: "2026-11-21" } }));
    const homeDays = calls.filter((c) => c.path === HOME).map((c) => c.query.date).sort();
    expect(homeDays).toEqual(["2026-11-20", "2026-11-21"]); // 18 and 19 have no data
    expect(calls.filter((c) => c.path === CAL)).toHaveLength(1);
    // Columnar rows: the keys are stated once in `columns`, not per activity.
    expect(out.columns).toEqual(["activity_id", "type", "internal_name", "start", "min", "status", "strain"]);
    const rows = out.rows as Array<Array<string | number | null>>;
    expect(out).toMatchObject({ start_date: "2026-11-18", end_date: "2026-11-21", count: 16 });
    expect(rows).toHaveLength(16);
    expect(rows.every((r) => r[1] === "CARDIO" || r[1] === "RECOVERY")).toBe(true);
    // 16:24:37–16:27:03 is 2 whole minutes; local time with its offset.
    expect(rows.find((r) => r[2] === "boxing")).toEqual(["70ad76a1-1e3c-4c8e-a026-903ff3175783", "CARDIO", "boxing", expect.stringMatching(/^2026-11-2\dT\d\d:24:37[+-]\d\d:\d\d$/), 2, "COMPLETE", 4.6]);
    // A RECOVERY activity has no strain; an unscored CARDIO one has none yet.
    expect(rows.find((r) => r[2] === "sauna")!.slice(4)).toEqual([10, "COMPLETE", null]);
    expect(rows.find((r) => r[2] === "tennis")!.slice(4)).toEqual([5, "INCOMPLETE", null]);
    // Display names that say more than the internal name are stated once.
    expect(out.names).toEqual({ weightlifting_msk: "Strength Trainer", sauna: "Dry Sauna" });
    // Newest first, deduped across the two days' identical cards.
    expect(new Set(rows.map((r) => r[0])).size).toBe(rows.length);
    expect(rows[0]![2]).toBe("weightlifting_msk");
    expect(JSON.stringify(out).length).toBeLessThan(2100); // 16 rows; the keyed form was 3,382
  });

  it("filters by types and sport, and keeps a default list short", async () => {
    const { whoop } = fakeWhoop((c: Call) => {
      if (c.path === CAL) return loadFixture("activities/calendar_overview_2026-11.json");
      if (c.path === HOME) return loadFixture("activities/home_2026-11-21.json");
      return unrouted(c);
    });
    const client = await connect((s) => registerWorkouts(s, whoop));
    const sleeps = textOf(await client.callTool({ name: "whoop_workouts", arguments: { date: "2026-11-21", types: ["SLEEP"] } }));
    expect((sleeps.rows as unknown[][]).map((r) => r.slice(0, 2))).toEqual([["addd5396-b934-4ae8-ba4e-a511762a0d53", "SLEEP"]]);
    const golf = await client.callTool({ name: "whoop_workouts", arguments: { date: "2026-11-21", sport: "golf" } });
    expect((textOf(golf).rows as unknown[]).length).toBe(2);
    const all = await client.callTool({ name: "whoop_workouts", arguments: { date: "2026-11-21", limit: 3 } });
    expect(textOf(all)).toMatchObject({ count: 3, truncated: true });
    expect((all.content as Array<{ text: string }>)[0]!.text.length).toBeLessThan(600);
    // Nothing matched: no rows, so no column names or name map either.
    const none = textOf(await client.callTool({ name: "whoop_workouts", arguments: { date: "2026-11-21", sport: "curling" } }));
    expect(none).toEqual({ start_date: "2026-11-21", end_date: "2026-11-21", count: 0 });
  });

  it("checks every day when the calendar can't be read", async () => {
    const { whoop, calls } = fakeWhoop((c: Call) => {
      if (c.path === CAL) throw new Error("boom");
      if (c.path === HOME) return homeWith([]);
      return unrouted(c);
    });
    const client = await connect((s) => registerWorkouts(s, whoop));
    const out = textOf(await client.callTool({ name: "whoop_workouts", arguments: { start_date: "2026-11-01", end_date: "2026-11-03" } }));
    expect(calls.filter((c) => c.path === HOME)).toHaveLength(3);
    expect(String(out.warnings)).toContain("calendar");
  });

  it("refuses ranges over 31 days without touching WHOOP", async () => {
    const { whoop, calls } = fakeWhoop(unrouted);
    const client = await connect((s) => registerWorkouts(s, whoop));
    const r = await client.callTool({ name: "whoop_workouts", arguments: { start_date: "2026-09-01", end_date: "2026-11-01" } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("uses the developer list for long ranges only when WHOOP_DEV_V2_LISTS=1", async () => {
    process.env.WHOOP_DEV_V2_LISTS = "1";
    const { whoop, calls } = fakeWhoop((c: Call) => {
      if (c.path === "/developer/v2/activity/workout") return loadFixture("activities/developer_workouts.json");
      return unrouted(c);
    });
    const client = await connect((s) => registerWorkouts(s, whoop));
    const out = textOf(await client.callTool({ name: "whoop_workouts", arguments: { start_date: "2026-09-01", end_date: "2026-11-21" } }));
    expect(out.source).toBe("developer");
    expect(calls[0]!.query).toMatchObject({ limit: 25 });
    expect(String(out.warnings)).toContain("scored workouts only");
    // A short range stays app-native even with the flag on.
    const { whoop: w2, calls: c2 } = fakeWhoop((c: Call) => {
      if (c.path === CAL) return loadFixture("activities/calendar_overview_2026-11.json");
      if (c.path === HOME) return homeWith([]);
      return unrouted(c);
    });
    const client2 = await connect((s) => registerWorkouts(s, w2));
    await client2.callTool({ name: "whoop_workouts", arguments: { date: "2026-11-21" } });
    expect(c2.some((c) => c.path.startsWith("/developer/"))).toBe(false);
  });
});

describe("whoop_workouts detail", () => {
  it("reads cardio-details only for a CARDIO activity, HR series opt-in", async () => {
    const { whoop, calls } = fakeWhoop((c: Call) => (c.path === CARDIO ? loadFixture("cardio_details.json") : unrouted(c)));
    const client = await connect((s) => registerWorkouts(s, whoop));
    const summary = await client.callTool({ name: "whoop_workouts", arguments: { activity_id: "5364dc07" } });
    expect(calls).toEqual([expect.objectContaining({ path: CARDIO, query: { activityId: "5364dc07" } })]);
    expect(textOf(summary)).toMatchObject({ type: "CARDIO", strain: 17.7, avg_hr_bpm: 123 });
    expect(textOf(summary)).not.toHaveProperty("hr");
    expect((summary.content as Array<{ text: string }>)[0]!.text.length).toBeLessThan(1500);
    const full = textOf(await client.callTool({ name: "whoop_workouts", arguments: { activity_id: "5364dc07", include: ["hr"] } }));
    expect((full.hr as { bpm: number[] }).bpm.length).toBeLessThanOrEqual(120);
  });

  it("adds recovery-details for a RECOVERY activity", async () => {
    const { whoop, calls } = fakeWhoop((c: Call) => {
      if (c.path === CARDIO) return loadFixture("activities/cardio_details_pending_sauna.json");
      if (c.path === RECOVERY) return loadFixture("activities/recovery_details_sauna.json");
      return unrouted(c);
    });
    const client = await connect((s) => registerWorkouts(s, whoop));
    const out = textOf(await client.callTool({ name: "whoop_workouts", arguments: { activity_id: "6db1e439" } }));
    expect(calls.map((c) => c.path)).toEqual([CARDIO, RECOVERY]);
    expect(out).toMatchObject({ type: "RECOVERY", internal_name: "sauna", min_hr_bpm: 58, avg_hr_bpm: 71 });
  });

  it("returns a pending activity (strain ---) instead of erroring", async () => {
    const { whoop } = fakeWhoop((c: Call) => (c.path === CARDIO ? loadFixture("activities/cardio_details_pending_boxing.json") : unrouted(c)));
    const client = await connect((s) => registerWorkouts(s, whoop));
    const r = await client.callTool({ name: "whoop_workouts", arguments: { activity_id: "29792beb" } });
    expect(r.isError).not.toBe(true);
    expect(String(textOf(r).warnings)).toContain("Not scored yet");
  });

  it("points sleeps to whoop_sleep and maps a missing id", async () => {
    const pendingSleep = fakeWhoop((c: Call) => {
      if (c.path === CARDIO) throw badRequest(c.path, PENDING_400);
      if (c.path === RECORD("sleep-1")) return activityRecord({ id: "sleep-1", type: "nap", score_type: "SLEEP" }, false);
      return unrouted(c);
    });
    const c1 = await connect((s) => registerWorkouts(s, pendingSleep.whoop));
    const r1 = await c1.callTool({ name: "whoop_workouts", arguments: { activity_id: "sleep-1" } });
    expect(r1.isError).toBe(true);
    expect(JSON.stringify(r1.content)).toContain("whoop_sleep");
    const missing = fakeWhoop((c: Call) => { throw notFound(c.path); });
    const c2 = await connect((s) => registerWorkouts(s, missing.whoop));
    const r2 = await c2.callTool({ name: "whoop_workouts", arguments: { activity_id: "gone" } });
    expect(r2.isError).toBe(true);
    expect(JSON.stringify(r2.content)).toContain("No activity gone");
  });

  // Live 2026-11-21: seconds after whoop_activity_edit moved a walk, cardio-details answered
  // 400 "Cannot view activity details for a pending activity". That was reported as "a sleep
  // or nap ... use whoop_sleep", and whoop_sleep answers "a walking activity ... use whoop_workouts".
  it("answers a workout WHOOP is still processing from its record, never as a sleep", async () => {
    const { whoop, calls } = fakeWhoop((c: Call) => {
      if (c.path === CARDIO) throw badRequest(c.path, PENDING_400);
      if (c.path === RECORD("walk-1")) {
        return activityRecord({ id: "walk-1", type: "walking", translated_type: "Walking", version: 1, during: "['2026-11-21T14:10:00.000Z','2026-11-21T14:25:00.000Z')" }, false);
      }
      return unrouted(c);
    });
    const client = await connect((s) => registerWorkouts(s, whoop));
    const r = await client.callTool({ name: "whoop_workouts", arguments: { activity_id: "walk-1" } });
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(r.content)).not.toContain("whoop_sleep");
    const out = textOf(r);
    expect(out).toMatchObject({ type: "CARDIO", internal_name: "walking", sport_id: 63, duration_ms: 900_000 });
    expect(Date.parse(String(out.start))).toBe(Date.parse("2026-11-21T14:10:00.000Z"));
    expect(Date.parse(String(out.end))).toBe(Date.parse("2026-11-21T14:25:00.000Z"));
    // Nothing is invented for the scores it couldn't read.
    for (const k of ["strain", "calories", "avg_hr_bpm", "max_hr_bpm", "zones_min"]) expect(out).not.toHaveProperty(k);
    expect(String(out.warnings)).toContain("still processing");
    // The record is the fresh second read; the pending screen isn't retried.
    expect(calls.map((c) => [c.path, c.fresh])).toEqual([[CARDIO, false], [RECORD("walk-1"), true]]);
  });

  it("says the activity is still processing when even the record can't say what it is", async () => {
    const { whoop } = fakeWhoop((c: Call) => {
      if (c.path === CARDIO) throw badRequest(c.path, PENDING_400);
      throw new Error("record read failed");
    });
    const client = await connect((s) => registerWorkouts(s, whoop));
    const r = await client.callTool({ name: "whoop_workouts", arguments: { activity_id: "act-9" } });
    expect(r.isError).toBe(true);
    const out = textOf(r);
    expect(String(out.error)).toContain("still processing act-9");
    expect(String(out.error)).not.toContain("is a sleep");
    expect(String(out.hint)).toContain("Try again");
  });
});
