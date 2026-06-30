// Round 3: regression tests for the data-extraction bugs found in the live-API
// audit (each tool returned HTTP 200 but with empty/null payloads). Every assert
// below would FAIL against the pre-fix projections.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectTrend } from "../../src/projections/trend.js";
import { projectCycle } from "../../src/projections/cycle.js";
import { projectBehaviorImpactList } from "../../src/projections/behavior_impact.js";
import { projectStress } from "../../src/projections/stress.js";
import { projectBehaviorImpact } from "../../src/projections/behavior_impact.js";
import { projectWorkout } from "../../src/projections/workout.js";
import { projectLiftProgression } from "../../src/projections/lift_progression.js";
import { projectRecovery } from "../../src/projections/recovery.js";
import { projectPerformanceAssessment } from "../../src/projections/performance_assessment.js";

import { TrendOut } from "../../src/schemas/trend.js";
import { CycleOut } from "../../src/schemas/womens_health.js";
import { BehaviorImpactListOut } from "../../src/schemas/journal.js";
import { StressOut } from "../../src/schemas/stress.js";
import { BehaviorImpactOut } from "../../src/schemas/journal.js";
import { WorkoutOut } from "../../src/schemas/workouts.js";
import { LiftProgressionOut } from "../../src/schemas/strength.js";
import { RecoveryOut } from "../../src/schemas/recovery.js";
import { PerformanceAssessmentOut } from "../../src/schemas/performance.js";

const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("projectTrend — time/duration metrics (bar_groups + timeLabelToMs)", () => {
  const out = projectTrend(load("trend_time_in_bed.json"), "TIME_IN_BED", "2026-05-30");
  const points = out.segments.flatMap((s) => s.points);

  it("parses schema", () => {
    expect(() => TrendOut.parse(out)).not.toThrow();
  });
  it("populates numeric value for a duration metric (was null pre-fix)", () => {
    // "11:14" → (11*3600 + 14*60) * 1000 ms
    const sun = points.find((p) => p.date === "SUN, MAY 24");
    expect(sun?.value).toBe((11 * 3600 + 14 * 60) * 1000);
    expect(sun?.value_display).toBe("11:14");
  });
  it("populates per-point date from bar data_scrubber_details (was empty pre-fix)", () => {
    expect(points.every((p) => p.date !== "")).toBe(true);
  });
  it("computes segment min/max from the parsed points", () => {
    expect(out.segments[0]?.min).not.toBeNull();
    expect(out.segments[0]?.max).not.toBeNull();
  });
});

describe("projectBehaviorImpactList — discovery list exposes the impact_uuids", () => {
  const out = projectBehaviorImpactList(load("behavior_impact_list.json"));

  it("parses schema", () => {
    expect(() => BehaviorImpactListOut.parse(out)).not.toThrow();
  });
  it("returns rows from both IMPACT_TILE and INSUFFICIENT_IMPACT_TILE", () => {
    expect(out.behaviors.length).toBe(5);
    expect(out.behaviors.filter((b) => b.has_sufficient_data).length).toBe(3);
  });
  it("surfaces impact_uuid + name + direction so the detail call is reachable", () => {
    const daylight = out.behaviors.find((b) => b.behavior_name === "Daylight Eating");
    expect(daylight?.impact_uuid).toBe("aa0a7709-8ac2-4f92-b17c-e9eb594d2a46");
    expect(daylight?.direction).toBe("positive");
    expect(daylight?.impact_display).toBe("+7%");
  });
  it("marks insufficient-data behaviors and maps direction", () => {
    const early = out.behaviors.find((b) => b.behavior_name === "Early Workout");
    expect(early?.direction).toBe("insufficient");
    expect(early?.has_sufficient_data).toBe(false);
  });
});

describe("projectCycle — tiles[] BFF (HEADER_TILE / CALENDAR_TILE / TYPICAL_CYCLE_TILE)", () => {
  // date earlier than the calendar's phase markers so predictions resolve.
  const out = projectCycle(load("cycle_insights.json"), "2026-05-15");

  it("parses schema", () => {
    expect(() => CycleOut.parse(out)).not.toThrow();
  });
  it("reads phase from HEADER_TILE.subtitle_display (was null pre-fix)", () => {
    expect(out.phase).toBe("Luteal Phase");
  });
  it("parses cycle_day from HEADER_TILE.title_display 'Cycle Day 11' (was null pre-fix)", () => {
    expect(out.cycle_day).toBe(11);
  });
  it("reads cycle_length from TYPICAL_CYCLE_TILE stats", () => {
    expect(out.cycle_length).toBe(28);
  });
  it("derives next period + ovulation from the calendar first-day-of-phase markers", () => {
    expect(out.next_period_predicted_date).toBe("2026-05-21");
    expect(out.ovulation_predicted_date).toBe("2026-05-18");
  });
});

describe("projectStress — gauge + stress_graph (stress_state is a string, not a timeline)", () => {
  const out = projectStress(load("stress_bff.json"), "2026-05-23");

  it("parses schema", () => {
    expect(() => StressOut.parse(out)).not.toThrow();
  });
  it("reads current level from the gauge (was null pre-fix)", () => {
    expect(out.current_level).toBe(0.3);
  });
  it("derives peak/min from the intraday graph points", () => {
    expect(out.peak_level).toBe(2.2);
    expect(out.min_level).toBe(0.2);
  });
  it("builds a downsampled timeline with ISO timestamps (was empty pre-fix)", () => {
    expect(out.timeline.length).toBeGreaterThan(0);
    expect(out.timeline.length).toBeLessThanOrEqual(49);
    expect(out.timeline[0]?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("projectBehaviorImpact — header + sections[].items[].impact_card", () => {
  const out = projectBehaviorImpact(load("behavior_impact_details.json"), "aa0a7709-8ac2-4f92-b17c-e9eb594d2a46");

  it("parses schema", () => {
    expect(() => BehaviorImpactOut.parse(out)).not.toThrow();
  });
  it("reads behavior name from header (was null pre-fix)", () => {
    expect(out.behavior_name).toBe("Daylight Eating");
  });
  it("extracts impact metrics from impact_card (was empty pre-fix)", () => {
    expect(out.metrics.length).toBeGreaterThan(0);
    const recovery = out.metrics.find((m) => m.metric === "RECOVERY IMPACT");
    expect(recovery?.delta_avg).toBe(7);
    expect(recovery?.delta_unit).toBe("%");
    expect(recovery?.direction).toBe("positive");
  });
});

describe("projectWorkout — HR curve from position_x (was always empty)", () => {
  const out = projectWorkout(load("cardio_details.json"), "5364dc07-c229-481f-b92f-0d7ee402fbbf");

  it("parses schema", () => {
    expect(() => WorkoutOut.parse(out)).not.toThrow();
  });
  it("populates a downsampled HR curve (was [] pre-fix)", () => {
    expect(out.hr_curve.length).toBeGreaterThan(0);
    expect(out.hr_curve.length).toBeLessThanOrEqual(120);
  });
  it("HR points carry plausible bpm and ISO timestamps inside the workout window", () => {
    expect(out.hr_curve.every((h) => h.bpm > 30 && h.bpm < 230)).toBe(true);
    const first = Date.parse(out.hr_curve[0]!.at);
    expect(first).toBeGreaterThanOrEqual(Date.parse(out.start!) - 1000);
    expect(first).toBeLessThanOrEqual(Date.parse(out.end!) + 1000);
  });
});

describe("projectLiftProgression — labels from element_names (positional was wrong)", () => {
  const out = projectLiftProgression(load("lift_progression.json"), "BENCHPRESS_BARBELL", "2026-05-23");

  it("parses schema", () => {
    expect(() => LiftProgressionOut.parse(out)).not.toThrow();
  });
  it("labels segments month/six_month (not week/month) when there's no weekly window", () => {
    expect(out.segments.map((s) => s.label)).toEqual(["month", "six_month"]);
  });
  it("populates per-point volume from bar data (was null pre-fix)", () => {
    expect(out.segments.flatMap((s) => s.points).some((p) => p.volume !== null)).toBe(true);
  });
});

describe("projectRecovery — SpO2 + skin temp from /developer/v2/recovery", () => {
  const out = projectRecovery(load("deep_dive_recovery.json"), "2026-05-23", load("recovery_v2.json"));

  it("parses schema", () => {
    expect(() => RecoveryOut.parse(out)).not.toThrow();
  });
  it("surfaces SpO2 from the v2 record (was null pre-fix)", () => {
    expect(out.spo2_pct).not.toBeNull();
    expect(out.spo2_pct!).toBeGreaterThan(80);
    expect(out.spo2_pct!).toBeLessThanOrEqual(100);
  });
  it("surfaces skin temperature from the v2 record (was null pre-fix)", () => {
    expect(out.skin_temp_c).toBe(33.7);
  });
});


describe("projectPerformanceAssessment - 1000 sentinel for recovery counts -> null", () => {
  const raw = {
    is_assessment_needed: true,
    has_assessment: false,
    total_recoveries: 1000,
    required_recoveries: 14,
    recoveries_before_recent_cutoff: 1000,
    expected_assessment_during: "['2026-05-01','2026-06-01')",
    next_assessment_during: "['2026-06-01','2026-07-01')",
  };
  const out = projectPerformanceAssessment(raw, "MONTH");

  it("parses schema", () => {
    expect(() => PerformanceAssessmentOut.parse(out)).not.toThrow();
  });
  it("nulls the 1000 sentinel rather than reporting a fake count", () => {
    expect(out.total_recoveries).toBeNull();
    expect(out.recoveries_before_recent_cutoff).toBeNull();
  });
  it("keeps real counts intact", () => {
    expect(out.required_recoveries).toBe(14);
  });
});
