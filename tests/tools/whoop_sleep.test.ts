import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerSleep } from "../../src/tools/v2/sleep.js";
import {
  hypnogramRuns, projectLastNight, projectSleepDetails, projectSleepV2, type SleepInclude,
} from "../../src/projections/v2/sleep.js";
import { projectSleepNeedV2 } from "../../src/projections/v2/core_sleep_need.js";
import { SleepV2Out } from "../../src/schemas/v2/sleep.js";
import { call, closeAll, connect, err500, fx, paths, pinToday, queryFor, routedGet, unpinToday } from "./reads_core_harness.js";

const MAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const inc = (...xs: SleepInclude[]) => new Set<SleepInclude>(xs);

describe("whoop_sleep projection", () => {
  it("reads metrics, stage minutes/% and sleep HR from sleep-details (minutes throughout)", () => {
    const r = projectSleepDetails(fx("sleep_details_complete"), MAIN, false)!;
    expect(r).toMatchObject({
      id: MAIN, type: "sleep", scored: true, start: "2026-11-18T07:10:00.000Z", end: "2026-11-18T15:05:00.000Z",
      asleep_min: 437, in_bed_min: 475, efficiency_pct: 92, latency_min: 6, rr: 15.1, wake_per_hr: 1.6,
      disturbances: 12, restorative_min: 219,
      stages_min: { awake: 38, light: 219, sws: 105, rem: 114 },
      stages_pct: { awake: 8, light: 46, sws: 22, rem: 24 },
      hr: { avg: 54, min: 49 },
      coach_note: "You got 92% of the sleep you needed.",
    });
    expect(r.hypnogram).toBeUndefined();
  });

  // A real COMPLETE_NAP's HR line ran 6:17–8:34 PM around a 6:28–8:24 PM nap: 21 of its 138
  // points were awake padding, which lifted the average from 73 to 76 bpm.
  it("keeps the sleep HR to the sleep itself, without the graph's awake padding on either side", () => {
    const r = projectSleepDetails(fx("sleep_details_complete"), MAIN, false)!;
    // In the fixture: 88 before and 96 after the sleep; 58, 52, 49, 55 inside it.
    expect(r.hr).toEqual({ avg: 54, min: 49 });
    const noStages = fx("sleep_details_complete") as Record<string, any>;
    noStages.graph.plots = noStages.graph.plots.filter((p: any) => p.plot.id === "SLEEP_HEART_RATE");
    expect(projectSleepDetails(noStages, MAIN, false)!.hr).toEqual({ avg: 66, min: 49 });
  });

  it("encodes the hypnogram as [stage, minutes] runs from the start (opt-in)", () => {
    const r = projectSleepDetails(fx("sleep_details_complete"), MAIN, true)!;
    expect(r.hypnogram!.start).toBe("2026-11-18T07:10:00.000Z");
    expect(r.hypnogram!.runs).toEqual([
      ["LIGHT", 47.5], ["SWS", 71.3], ["LIGHT", 95], ["REM", 47.5], ["AWAKE", 23.7],
      ["SWS", 33.3], ["LIGHT", 76], ["REM", 66.5], ["AWAKE", 14.3],
    ]);
    const total = r.hypnogram!.runs.reduce((s, [, m]) => s + m, 0);
    expect(Math.round(total)).toBe(475);
  });

  it("merges adjacent runs of one stage and marks gaps as NO_DATA", () => {
    const zones = [
      { id: "LIGHT_SLEEP", bar_graph: { time_bound_ranges: [{ lower_endpoint: 0, upper_endpoint: 0.25 }, { lower_endpoint: 0.25, upper_endpoint: 0.5 }] } },
      { id: "REM_SLEEP", bar_graph: { time_bound_ranges: [{ lower_endpoint: 0.75, upper_endpoint: 1 }] } },
    ];
    expect(hypnogramRuns(zones, "2026-11-18T00:00:00.000Z", "2026-11-18T01:40:00.000Z")).toEqual([["LIGHT", 50], ["NO_DATA", 25], ["REM", 25]]);
  });

  it("leaves an unscored (INCOMPLETE) sleep without metrics or stages", () => {
    const r = projectSleepDetails(fx("sleep_details_incomplete"), "addd5396-b934-4ae8-ba4e-a511762a0d53", true)!;
    expect(r).toMatchObject({ type: "sleep", scored: false, asleep_min: null, rr: null, disturbances: null });
    expect(r.stages_min).toEqual({ awake: null, light: null, sws: null, rem: null });
    expect(r.hypnogram!.runs).toEqual([]);
    expect(projectSleepDetails(fx("sleep_details_incomplete_nap"), "x", false)!.type).toBe("nap");
  });

  it("falls back to the last-night WAKE EVENTS tile (PR #46) when TOTAL_WAKE_EVENTS is missing", () => {
    expect(projectLastNight(fx("lastnight_populated"))).toMatchObject({
      id: MAIN, hours_vs_needed_pct: 91, consistency_pct: 78, efficiency_pct: 92, wake_events: 11,
    });
    const details = fx("sleep_details_complete") as Record<string, any>;
    details.sleep_metric_breakdowns = details.sleep_metric_breakdowns.filter((m: any) => m.sleep_metric_type !== "TOTAL_WAKE_EVENTS");
    const out = projectSleepV2({ date: "2026-11-18", include: inc(), details, lastNight: fx("lastnight_populated"), home: fx("home_populated") });
    expect(out.sleep?.disturbances).toBe(11);
  });

  it("combines details, last night, home naps and need for a date", () => {
    const out = SleepV2Out.parse(projectSleepV2({
      date: "2026-11-18", include: inc("naps", "need"), details: fx("sleep_details_complete"),
      lastNight: fx("lastnight_populated"), home: fx("home_populated"), need: projectSleepNeedV2(fx("sleepneed")), baseline: 56.6,
    }));
    expect(out.sleep).toMatchObject({ id: MAIN, status: "COMPLETE", perf_pct: 88, hours_vs_needed_pct: 91, consistency_pct: 78 });
    expect(out.naps).toEqual([{ id: "aaaaaaaa-0000-4000-8000-000000000004", status: "COMPLETE", start: "2026-11-18T21:00:00.000Z", end: "2026-11-18T21:30:00.000Z", min: 25 }]);
    expect(out.need).toMatchObject({ total_min: 494, baseline_min: 493, strain_min: 2, naps_min: 0 });
    expect(out.hr_baseline_bpm).toBe(56.6);
  });

  it("keeps the window of a pending sleep whose details failed", () => {
    const out = projectSleepV2({ date: "2026-11-21", include: inc("naps"), details: null, lastNight: fx("lastnight_incomplete"), home: fx("home_day_zero_naps") });
    expect(out.sleep).toMatchObject({ id: "addd5396-b934-4ae8-ba4e-a511762a0d53", scored: false, start: "2026-11-21T10:30:00.000Z", end: "2026-11-21T13:30:00.000Z" });
    expect(out.naps?.map((n) => n.status)).toEqual(["INCOMPLETE", "PENDING"]);
  });

  it("takes scored and minutes asleep from the home tile when details are unavailable", () => {
    const out = projectSleepV2({ date: "2026-11-18", include: inc(), details: null, lastNight: fx("lastnight_populated"), home: fx("home_populated") });
    expect(out.sleep).toMatchObject({ id: MAIN, scored: true, status: "COMPLETE", asleep_min: 440, perf_pct: 88, efficiency_pct: 92, disturbances: 11 });
  });

  it("returns sleep: null when the date has no main sleep", () => {
    const out = projectSleepV2({ date: "2026-11-21", include: inc("naps"), details: null, lastNight: fx("lastnight_none"), home: fx("home_day_zero_naps") });
    expect(out.sleep).toBeNull();
    expect(out.naps).toHaveLength(2);
  });
});

describe("whoop_sleep tool", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  const routes = (over: Record<string, unknown> = {}) => ({
    "/home-service/v1/home": fx("home_populated"),
    "/home-service/v1/deep-dive/sleep/last-night": fx("lastnight_populated"),
    [`/core-details-bff/v2/sleep-details/${MAIN}`]: fx("sleep_details_complete"),
    "/coaching-service/v2/sleepneed": fx("sleepneed"),
    "/sleep-service/v1/heart-rate/baseline": 56.6,
    ...over,
  });

  it("today: home + last night + details + sleepneed + baseline, no developer endpoints", async () => {
    const get = routedGet(routes());
    const out = await call(await connect(registerSleep, get), "whoop_sleep");
    expect(queryFor(get, "/home-service/v1/deep-dive/sleep/last-night")).toEqual({ date: "2026-11-21" });
    expect(paths(get).some((p) => p.startsWith("/developer/"))).toBe(false);
    expect(out.sleep.id).toBe(MAIN);
    expect(out.need.total_min).toBe(494);
    expect(out.sleep.hypnogram).toBeUndefined();
  });

  it("sleepneed 500 (broken Smart Alarm prefs) degrades need to null", async () => {
    const get = routedGet(routes({ "/coaching-service/v2/sleepneed": err500("/coaching-service/v2/sleepneed") }));
    const out = await call(await connect(registerSleep, get), "whoop_sleep", { include: ["need", "hypnogram"] });
    expect(out.need ?? null).toBeNull();
    expect(out.sleep.hypnogram.runs.length).toBeGreaterThan(0);
  });

  it("past dates don't ask for tonight's sleep need", async () => {
    const get = routedGet(routes());
    await call(await connect(registerSleep, get), "whoop_sleep", { date: "2026-11-18" });
    expect(paths(get)).not.toContain("/coaching-service/v2/sleepneed");
  });

  it("activity_id reads one sleep or nap by id without the day context", async () => {
    const nap = "69552a7c-db0d-44a7-9621-42387dd38503";
    const get = routedGet({
      [`/core-details-bff/v2/sleep-details/${nap}`]: fx("sleep_details_incomplete_nap"),
      [`/activities-service/v2/activities/${nap}`]: { id: nap, score_type: "SLEEP", type: "nap", score_state: "incomplete" },
      "/sleep-service/v1/heart-rate/baseline": err500("baseline"),
    });
    const out = await call(await connect(registerSleep, get), "whoop_sleep", { activity_id: nap, include: ["naps", "need"] });
    expect(paths(get).sort()).toEqual([
      `/activities-service/v2/activities/${nap}`, `/core-details-bff/v2/sleep-details/${nap}`, "/sleep-service/v1/heart-rate/baseline",
    ]);
    expect(out.date ?? null).toBeNull();
    expect(out.sleep).toMatchObject({ id: nap, type: "nap", scored: false });
    expect(out.naps).toBeUndefined();
  });

  // Live 2026-11-21 (reads-review): GET sleep-details/{boxing id} answered 200 with title "SLEEP",
  // INCOMPLETE_ACTIVITY and the workout's window. Only the activity record tells it apart.
  const BOXING = "70ad76a1-1e3c-4c8e-a026-903ff3175783";
  const boxingAsSleep = {
    activity_display_type: "INCOMPLETE_ACTIVITY",
    sleep_details_labels: { screen_title_display: "SLEEP" },
    sleep_details_edit_components: { sleep_start_time: "2026-11-22T00:24:37.527Z", sleep_end_time: "2026-11-22T00:27:03.453Z", nap_to_sleep_available: false },
    sleep_metric_breakdowns: [],
  };

  it("refuses an activity_id that is a workout instead of reporting it as an unscored sleep", async () => {
    const get = routedGet({
      [`/core-details-bff/v2/sleep-details/${BOXING}`]: boxingAsSleep,
      [`/activities-service/v2/activities/${BOXING}`]: { id: BOXING, score_type: "CARDIO", type: "boxing", score_state: "complete" },
      "/sleep-service/v1/heart-rate/baseline": 56.6,
    });
    await expect(call(await connect(registerSleep, get), "whoop_sleep", { activity_id: BOXING }))
      .rejects.toThrow(/boxing activity, not a sleep or nap/);
  });

  it("still answers from sleep-details when the activity record cannot be read", async () => {
    const id = "c58031dc-36f0-472f-8d04-1acfd8ec7776";
    const get = routedGet({
      [`/core-details-bff/v2/sleep-details/${id}`]: fx("sleep_details_incomplete"),
      [`/activities-service/v2/activities/${id}`]: err500("record"),
      "/sleep-service/v1/heart-rate/baseline": 56.6,
    });
    const out = await call(await connect(registerSleep, get), "whoop_sleep", { activity_id: id });
    expect(out.sleep).toMatchObject({ id, type: "sleep", scored: false });
  });

  it("rejects a malformed activity_id before calling WHOOP", async () => {
    const get = routedGet(routes());
    await expect(call(await connect(registerSleep, get), "whoop_sleep", { activity_id: "../../x" })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
