import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerDay } from "../../src/tools/v2/day.js";
import { projectDay, type DaySection } from "../../src/projections/v2/day.js";
import { projectSleepNeedV2 } from "../../src/projections/v2/core_sleep_need.js";
import { activityTiles, coachRecommendations, keyStats } from "../../src/projections/v2/core_home.js";
import { DayOut } from "../../src/schemas/v2/day.js";
import { call, closeAll, connect, err500, fx, paths, pinToday, queryFor, routedGet, unpinToday } from "./reads_core_harness.js";

const ALL = new Set<DaySection>(["scores", "sleep", "strain", "activities", "sleep_plan", "key_stats"]);
const DEFAULT = new Set<DaySection>(["scores", "sleep", "strain", "activities"]);
const MAIN_SLEEP = "aaaaaaaa-0000-4000-8000-000000000001";

describe("whoop_day projection", () => {
  const populated = (include: Set<DaySection>, isToday = true) => projectDay({
    date: "2026-11-18", isToday, include,
    home: fx("home_populated"), recovery: fx("recovery_dd_populated"), strain: fx("strain_dd_populated"),
    sleepDetails: fx("sleep_details_complete"), sleepNeed: projectSleepNeedV2(fx("sleepneed")), userState: fx("userstate"),
  });

  it("projects a scored day and validates against the schema", () => {
    const out = DayOut.parse(populated(ALL));
    expect(out.cycle).toMatchObject({ id: 1900000001, start: "2026-11-18T07:10:00.000Z", calibrating: false });
    // Normal states are dropped as noise; only unusual ones are kept.
    expect(out.cycle.sleep_state).toBeNull();
    expect(out.cycle.day_state).toBeNull();
    expect(out.scores).toEqual({ recovery: 71, recovery_state: "GREEN", hrv_ms: 58, rhr_bpm: 52, sleep_perf: 88, strain: 11.2 });
    expect(out.strain).toMatchObject({ calories: 2104, steps: 9412, target: 12.6, zones_1_3_min: 65, zones_4_5_min: 12, strength_min: 0 });
    expect(out.sleep).toMatchObject({
      id: MAIN_SLEEP, status: "COMPLETE", asleep_min: 437, in_bed_min: 475, efficiency_pct: 92, rr: 15.1,
      disturbances: 12, stages_min: { awake: 38, light: 219, sws: 105, rem: 114 }, naps: 1,
    });
    expect(out.sleep_plan).toMatchObject({ total_min: 494, debt_min: 0, in_bed_min: { peak: 553, perform: 471, get_by: 389 } });
    expect(out.key_stats?.HR_ZONES_1_3).toEqual({ now: 65, avg_30d: 48, unit: "min" });
    expect(out.key_stats?.WEIGHT).toEqual({ now: null, avg_30d: null });
  });

  it("counts CARDIO tiles only and lists the rest by type (issue #4)", () => {
    const out = populated(DEFAULT);
    expect(out.workouts_count).toBe(2);
    expect(out.activities!.cardio.map((a) => [a.name, a.status, a.strain])).toEqual([["running", "COMPLETE", 8.4], ["walking", "PENDING", null]]);
    expect(out.activities!.recovery).toEqual([expect.objectContaining({ name: "sauna", min: 20 })]);
    // The main sleep is the `sleep` section; only the nap stays in activities.sleep.
    expect(out.activities!.sleep.map((a) => a.name)).toEqual(["nap"]);
    expect(out.recommendations).toEqual([{ title: "WALKING", recommended_min: 25, est_strain: 5.5 }]);
  });

  it("keeps the main sleep tile in activities when the sleep section is not requested", () => {
    const out = populated(new Set<DaySection>(["activities"]));
    expect(out.activities!.sleep.map((a) => a.name)).toEqual(["sleep", "nap"]);
    expect(out.scores).toBeUndefined();
    expect(out.sleep).toBeUndefined();
  });

  it("puts the strain score in the strain section only when scores are not requested", () => {
    expect(populated(new Set<DaySection>(["strain"])).strain?.score).toBe(11.2);
    expect(populated(DEFAULT).strain?.score).toBeUndefined();
  });

  it("returns null sleep_plan and no live state for a past date", () => {
    const out = populated(ALL, false);
    expect(out.sleep_plan).toBeNull();
    expect(out.now).toBeNull();
  });

  it("reports a calibrating day-zero account without inventing scores", () => {
    const out = DayOut.parse(projectDay({
      date: "2026-11-21", isToday: true, include: ALL,
      home: fx("home_day_zero_sleep"), recovery: fx("recovery_dd_calibrating"), strain: fx("strain_dd_calibrating"),
      sleepDetails: fx("sleep_details_incomplete"), sleepNeed: null, userState: fx("userstate"),
    }));
    expect(out.cycle).toMatchObject({ id: 1974268448, calibrating: true, sleep_state: "incomplete" });
    expect(out.scores).toMatchObject({ recovery: null, recovery_state: null, hrv_ms: null, sleep_perf: null, strain: 20.9 });
    expect(out.strain?.calories).toBe(237);
    expect(out.strain?.target).toBeNull();
    // 15 CARDIO tiles; the 3 RECOVERY tiles and the SLEEP tile are not workouts.
    expect(out.workouts_count).toBe(15);
    expect(out.activities!.recovery).toHaveLength(3);
    expect(out.sleep).toMatchObject({ id: "ecb61ee9-3044-4fea-8e10-8e5706bf84a1", status: "INCOMPLETE", stages_min: null });
    expect(out.sleep_plan).toBeNull();
    expect(out.now).toEqual({ state: "idle", sport: null, since: null });
  });

  it("falls back to whoop_live_metadata calories when the CALORIES key stat is missing", () => {
    const home = fx("home_populated") as Record<string, any>;
    home.pillars[0].sections[1].items = home.pillars[0].sections[1].items.filter((i: any) => i.content.trend_key !== "CALORIES");
    const out = projectDay({ date: "2026-11-18", isToday: false, include: new Set<DaySection>(["strain"]), home });
    expect(out.strain?.calories).toBe(2104);
  });

  it("finds activity tiles wherever the card sits (day-zero cards vs activity_items_card)", () => {
    expect(activityTiles(fx("home_day_zero_naps")).filter((t) => t.name === "nap").map((t) => t.status)).toEqual(["INCOMPLETE", "PENDING"]);
    expect(activityTiles(fx("home_populated"))).toHaveLength(5);
    expect(coachRecommendations(fx("home_day_zero_sleep"))).toEqual([]);
    expect(Object.keys(keyStats(fx("home_day_zero_sleep")))).toEqual(["HRV", "SLEEP_PERFORMANCE", "STEPS", "CALORIES"]);
  });
});

describe("whoop_day tool", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  const routes = (over: Record<string, unknown> = {}) => ({
    "/home-service/v1/home": fx("home_populated"),
    "/home-service/v1/deep-dive/recovery": fx("recovery_dd_populated"),
    "/home-service/v1/deep-dive/strain": fx("strain_dd_populated"),
    "/activities-service/v1/user-state": fx("userstate"),
    [`/core-details-bff/v2/sleep-details/${MAIN_SLEEP}`]: fx("sleep_details_complete"),
    "/coaching-service/v2/sleepneed": fx("sleepneed"),
    ...over,
  });

  it("defaults to today and reads home, both deep dives, user-state and the main sleep's details", async () => {
    const get = routedGet(routes());
    const out = await call(await connect(registerDay, get), "whoop_day");
    expect(out.date).toBe("2026-11-21");
    expect(queryFor(get, "/home-service/v1/home")).toEqual({ date: "2026-11-21" });
    expect(paths(get).sort()).toEqual([
      "/activities-service/v1/user-state",
      `/core-details-bff/v2/sleep-details/${MAIN_SLEEP}`,
      "/home-service/v1/deep-dive/recovery",
      "/home-service/v1/deep-dive/strain",
      "/home-service/v1/home",
    ]);
    expect(paths(get)).not.toContain("/developer/v2/activity/sleep");
    expect(out.workouts_count).toBe(2);
  });

  it("degrades a 500 from sleepneed to a null sleep_plan instead of failing", async () => {
    const get = routedGet(routes({ "/coaching-service/v2/sleepneed": err500("/coaching-service/v2/sleepneed") }));
    const out = await call(await connect(registerDay, get), "whoop_day", { include: ["sleep_plan", "scores"] });
    expect(out.sleep_plan ?? null).toBeNull();
    expect(out.scores.recovery).toBe(71);
  });

  it("skips user-state and sleepneed for a past date and only fetches what include asks for", async () => {
    const get = routedGet(routes());
    await call(await connect(registerDay, get), "whoop_day", { date: "2026-11-18", include: ["sleep_plan", "key_stats"] });
    expect(paths(get)).toEqual(["/home-service/v1/home"]);
  });

  it("survives a failing deep dive but not a failing home read", async () => {
    const ok = routedGet(routes({ "/home-service/v1/deep-dive/recovery": err500("/home-service/v1/deep-dive/recovery") }));
    const out = await call(await connect(registerDay, ok), "whoop_day", { include: ["scores"] });
    expect(out.scores.recovery).toBe(71);
    expect(out.scores.hrv_ms).toBe(58); // falls back to the HRV key stat
    const bad = routedGet(routes({ "/home-service/v1/home": err500("/home-service/v1/home") }));
    await expect(call(await connect(registerDay, bad), "whoop_day")).rejects.toThrow(/500/);
  });

  it("rejects unknown include sections", async () => {
    const get = routedGet(routes());
    await expect(call(await connect(registerDay, get), "whoop_day", { include: ["hypnogram"] })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
