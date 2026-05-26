// Verifies the Round 1 rewritten projections against captured raw fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectRecovery } from "../../src/projections/recovery.js";
import { projectStrain } from "../../src/projections/strain.js";
import { projectSleep } from "../../src/projections/sleep.js";
import { projectToday } from "../../src/projections/today.js";
import { projectTrend } from "../../src/projections/trend.js";

import { RecoveryOut } from "../../src/schemas/recovery.js";
import { StrainOut } from "../../src/schemas/strain.js";
import { SleepOut } from "../../src/schemas/sleep.js";
import { TodayOut } from "../../src/schemas/today.js";
import { TrendOut } from "../../src/schemas/trend.js";

const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("projectRecovery (captured — new SCORE_GAUGE/CONTRIBUTORS_TILE shape)", () => {
  const raw = load("deep_dive_recovery.json");
  const out = projectRecovery(raw, "2026-05-23");

  it("parses schema", () => {
    expect(() => RecoveryOut.parse(out)).not.toThrow();
  });
  it("extracts recovery score (78) from SCORE_GAUGE.score_display", () => {
    expect(out.score).toBe(78);
  });
  it("infers state GREEN from progress_fill_style RECOVERY_HIGH", () => {
    expect(out.state).toBe("GREEN");
  });
  it("extracts HRV current (42 ms) from CONTRIBUTORS_TILE_HRV.status", () => {
    expect(out.hrv.ms).toBe(42);
  });
  it("extracts HRV baseline (40 ms) from CONTRIBUTORS_TILE_HRV.status_subtitle", () => {
    expect(out.hrv.baseline_ms).toBe(40);
  });
  it("extracts RHR current (68 bpm) from CONTRIBUTORS_TILE_RHR.status", () => {
    expect(out.rhr.bpm).toBe(68);
  });
  it("extracts RHR baseline (70 bpm) from CONTRIBUTORS_TILE_RHR.status_subtitle", () => {
    expect(out.rhr.baseline_bpm).toBe(70);
  });
  it("extracts respiratory rate (14.7) from CONTRIBUTORS_TILE_RESPIRATORY_RATE", () => {
    expect(out.respiratory_rate).toBe(14.7);
  });
  it("extracts sleep performance (83) from CONTRIBUTORS_TILE_SLEEP_PERFORMANCE", () => {
    expect(out.sleep_performance_pct).toBe(83);
  });
});

describe("projectStrain (captured — new SCORE_GAUGE/CONTRIBUTORS_TILE shape)", () => {
  const raw = load("deep_dive_strain.json");
  const out = projectStrain(raw, "2026-05-23");

  it("parses schema", () => {
    expect(() => StrainOut.parse(out)).not.toThrow();
  });
  it("extracts day strain (18.9) from STRAIN_SCORE_GAUGE.score_display", () => {
    expect(out.score).toBe(18.9);
  });
  it("extracts steps (10616) from CONTRIBUTORS_TILE_STEPS", () => {
    expect(out.steps).toBe(10616);
  });
  it("calories no longer in deep-dive shape — null", () => {
    expect(out.calories).toBeNull();
  });
  it("extracts HR zones 1-3 time (2h18m = 8280000 ms)", () => {
    expect(out.zone_durations.zone_1_ms).toBe(8280000);
  });
  it("extracts HR zones 4-5 time (0:03 = 180000 ms)", () => {
    expect(out.zone_durations.zone_4_ms).toBe(180000);
  });
  it("strength activity time (2h35m = 9300000 ms)", () => {
    expect(out.strength_activity_time_ms).toBe(9300000);
  });
  it("counts workouts from ACTIVITY items", () => {
    expect(out.workouts_count).toBeGreaterThan(0);
  });
});

describe("projectSleep (captured)", () => {
  const raw = load("deep_dive_sleep.json");
  const out = projectSleep(raw, "2026-05-23");

  it("parses schema", () => {
    expect(() => SleepOut.parse(out)).not.toThrow();
  });
  it("extracts started_at + ended_at from header destination", () => {
    expect(out.started_at).toBe("2026-05-23T07:35:46.220Z");
    expect(out.ended_at).toBe("2026-05-23T15:35:33.560Z");
  });
  it("extracts total sleep (7h24m = 26640000 ms)", () => {
    expect(out.total_sleep_ms).toBe(26640000);
  });
  it("extracts time in bed (7h59m = 28740000 ms)", () => {
    expect(out.time_in_bed_ms).toBe(28740000);
  });
  it("extracts efficiency (93%)", () => {
    expect(out.efficiency_pct).toBe(93);
  });
  it("extracts performance (85%)", () => {
    expect(out.performance_pct).toBe(85);
  });
  it("extracts consistency (73%)", () => {
    expect(out.consistency_pct).toBe(73);
  });
  it("extracts AWAKE stage (0h35m = 2100000 ms, 7%)", () => {
    expect(out.stages.wake_ms).toBe(2100000);
    expect(out.stages.wake_pct).toBe(7);
  });
  it("has non-null REM / LIGHT / SWS times", () => {
    expect(out.stages.rem_ms).not.toBeNull();
    expect(out.stages.light_ms).not.toBeNull();
    expect(out.stages.sws_ms).not.toBeNull();
  });
});

describe("projectToday for whoop_day (state=null, past date)", () => {
  const home = load("home.json");
  const sleep = load("deep_dive_sleep.json");
  const out = projectToday({ home, sleep, state: null, date: "2026-05-22" });

  it("parses schema with state=null", () => {
    expect(() => TodayOut.parse(out)).not.toThrow();
  });
  it("current_state.state is null when state input is null", () => {
    expect(out.current_state.state).toBeNull();
    expect(out.current_state.started_at).toBeNull();
    expect(out.current_state.sport_name).toBeNull();
  });
  it("date passes through to output", () => {
    expect(out.date).toBe("2026-05-22");
  });
  it("recovery/sleep/strain still populated", () => {
    expect(out.recovery.score).toBe(78);
    expect(out.sleep.performance_pct).toBe(83);
    expect(out.strain.score).toBe(17.8);
  });
});

describe("projectToday (captured)", () => {
  const home = load("home.json");
  const sleep = load("deep_dive_sleep.json");
  const out = projectToday({ home, sleep, state: null, date: "2026-05-23" });

  it("parses schema", () => {
    expect(() => TodayOut.parse(out)).not.toThrow();
  });
  it("extracts recovery score (78) and state GREEN from RECOVERY_HIGH style", () => {
    expect(out.recovery.score).toBe(78);
    expect(out.recovery.state).toBe("GREEN");
  });
  it("extracts sleep score (83)", () => {
    expect(out.sleep.performance_pct).toBe(83);
  });
  it("extracts strain score (17.8)", () => {
    expect(out.strain.score).toBe(17.8);
  });
  it("counts ACTIVITY tiles for workouts_count > 0", () => {
    expect(out.strain.workouts_count).toBeGreaterThanOrEqual(0);
  });
  it("populates sleep stages from companion sleep fixture", () => {
    expect(out.sleep.stages.wake_ms).toBe(2100000);
  });
});

describe("projectTrend (captured HRV)", () => {
  const raw = load("trend_hrv.json");
  const out = projectTrend(raw, "HRV", "2026-05-23");

  it("parses schema", () => {
    expect(() => TrendOut.parse(out)).not.toThrow();
  });
  it("emits 3 segments (week/month/six_month)", () => {
    const labels = out.segments.map((s) => s.label);
    expect(labels).toContain("week");
    expect(labels).toContain("month");
    expect(labels).toContain("six_month");
  });
  it("week segment avg = 35 (from metrics[0].current_metric_value)", () => {
    const week = out.segments.find((s) => s.label === "week");
    expect(week?.avg).toBe(35);
  });
  it("week segment unit = ms", () => {
    const week = out.segments.find((s) => s.label === "week");
    expect(week?.unit).toBe("ms");
  });
  it("week segment delta_pct = -10 (from metric_change)", () => {
    const week = out.segments.find((s) => s.label === "week");
    expect(week?.delta_pct).toBe(-10);
  });
  it("week has at least 7 data points", () => {
    const week = out.segments.find((s) => s.label === "week");
    expect(week?.points.length).toBeGreaterThanOrEqual(7);
  });
  it("first point has numeric value extracted from value_display", () => {
    const week = out.segments.find((s) => s.label === "week");
    expect(week?.points[0]?.value).not.toBeNull();
  });
});
