import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assessmentTimestamp, registerRecovery } from "../../src/tools/v2/recovery.js";
import { projectAssessment, projectHealthMonitor, projectRecoveryDeepDive } from "../../src/projections/v2/recovery.js";
import { RecoveryV2Out } from "../../src/schemas/v2/recovery.js";
import { call, closeAll, connect, err500, fx, paths, pinToday, queryFor, routedGet, unpinToday } from "./reads_core_harness.js";

const MONITOR = "/coaching-service/v1/health/bff/monitor";

describe("whoop_recovery projection", () => {
  it("reads score, state and contributors vs baseline on a calibrated account", () => {
    const out = projectRecoveryDeepDive(fx("recovery_dd_populated"), "2026-11-18");
    expect(out).toMatchObject({ score: 71, state: "GREEN", calibrating: false, calibration: null });
    expect(out.hrv_ms).toEqual({ value: 58, baseline: 54, trend: "HIGHER_POSITIVE" });
    expect(out.rhr_bpm).toEqual({ value: 52, baseline: 53, trend: "LOWER_POSITIVE" });
    expect(out.rr).toEqual({ value: 15.1, baseline: 15, trend: "EQUAL" });
    expect(out.sleep_perf_pct).toEqual({ value: 88, baseline: 79, trend: "HIGHER_POSITIVE" });
  });

  it("takes calibration progress from the STEPPER and leaves calibrating values null", () => {
    const out = projectRecoveryDeepDive(fx("recovery_dd_calibrating"), "2026-11-21");
    expect(out).toMatchObject({ score: null, state: null, calibrating: true, calibration: { filled: 0, total: 4 } });
    expect(out.hrv_ms).toEqual({ value: null, baseline: null, trend: null });
  });

  it("parses the health monitor into SpO2 and a skin-temperature deviation (new fields)", () => {
    expect(projectHealthMonitor(fx("monitor_populated"))).toMatchObject({
      spo2_pct: 96, skin_temp_dev_f: -0.3, rr: 15.1, rhr_bpm: 52, hrv_ms: 58, in_range: 5, with_values: 5,
      status: { BLOOD_OXYGEN: "POSITIVE_RANGE", SKIN_TEMPERATURE_FAHRENHEIT: "POSITIVE_RANGE" },
    });
    const cal = projectHealthMonitor(fx("monitor_calibrating"))!;
    expect(cal).toMatchObject({ spo2_pct: null, skin_temp_dev_f: null, with_values: 0, note: "Log 7 more sleeps to fully calibrate your ranges." });
  });

  it("parses assessment windows into inclusive {start, end} dates", () => {
    expect(projectAssessment(fx("pa_week"))).toEqual({
      needed: false, has_assessment: false, recoveries: 0, required: 7,
      expected: { start: "2026-11-09", end: "2026-11-15" }, next: { start: "2026-11-16", end: "2026-11-22" },
    });
    expect(projectAssessment(fx("pa_month"))?.expected).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(projectAssessment({ total_recoveries: 1000, required_recoveries: 14 })?.recoveries).toBeNull();
  });

  it("builds the assessment timestamp WHOOP accepts (UTC with ms, never a bare date)", () => {
    expect(assessmentTimestamp("2026-11-21", true, new Date("2026-11-21T20:00:00.000Z"))).toBe("2026-11-21T20:00:00.000Z");
  });
});

describe("whoop_recovery tool", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  it("adds today's health monitor and never calls /developer/v2/recovery", async () => {
    const get = routedGet({ "/home-service/v1/deep-dive/recovery": fx("recovery_dd_populated"), [MONITOR]: fx("monitor_populated") });
    const out = RecoveryV2Out.parse(await call(await connect(registerRecovery, get), "whoop_recovery"));
    expect(queryFor(get, "/home-service/v1/deep-dive/recovery")).toEqual({ date: "2026-11-21" });
    expect(out.monitor?.spo2_pct).toBe(96);
    expect(paths(get)).not.toContain("/developer/v2/recovery");
    expect(out.assessment).toBeUndefined();
  });

  it("skips the monitor for a past date (it only covers today's cycle)", async () => {
    const get = routedGet({ "/home-service/v1/deep-dive/recovery": fx("recovery_dd_populated") });
    const out = await call(await connect(registerRecovery, get), "whoop_recovery", { date: "2026-11-18" });
    expect(paths(get)).toEqual(["/home-service/v1/deep-dive/recovery"]);
    expect(out.monitor ?? null).toBeNull();
  });

  it("include assessment reads WEEK and MONTH with a timestamp path, tolerating a failure", async () => {
    const get = routedGet({
      "/home-service/v1/deep-dive/recovery": fx("recovery_dd_calibrating"),
      [MONITOR]: err500(MONITOR),
      "/coaching-service/v1/performance-assessment/WEEK/data/2026-11-21T20:00:00.000Z": fx("pa_week"),
      "/coaching-service/v1/performance-assessment/MONTH/data/2026-11-21T20:00:00.000Z": err500("month"),
    });
    const out = await call(await connect(registerRecovery, get), "whoop_recovery", { include: ["assessment"] });
    expect(out.assessment.week.required).toBe(7);
    expect(out.assessment.month ?? null).toBeNull();
    expect(out.calibration).toEqual({ filled: 0, total: 4 });
  });

  it("past-date assessments anchor on that day's local noon", async () => {
    const get = routedGet({
      "/home-service/v1/deep-dive/recovery": fx("recovery_dd_populated"),
      "/coaching-service/v1/performance-assessment/WEEK/data/2026-11-10T20:00:00.000Z": fx("pa_week"),
      "/coaching-service/v1/performance-assessment/MONTH/data/2026-11-10T20:00:00.000Z": fx("pa_month"),
    });
    const out = await call(await connect(registerRecovery, get), "whoop_recovery", { date: "2026-11-10", include: ["assessment"] });
    expect(out.assessment.month.required).toBe(14);
  });
});
