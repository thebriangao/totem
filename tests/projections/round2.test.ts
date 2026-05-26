// Round 2 verifications against captured fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectWorkout } from "../../src/projections/workout.js";
import { projectLiftProgression } from "../../src/projections/lift_progression.js";
import { projectJournal } from "../../src/projections/journal.js";
import { projectLiftPrs } from "../../src/projections/lift_prs.js";

import { WorkoutOut } from "../../src/schemas/workouts.js";
import { LiftProgressionOut, LiftPrsOut } from "../../src/schemas/strength.js";
import { JournalOut } from "../../src/schemas/journal.js";

const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("projectWorkout (captured strength workout)", () => {
  const raw = load("cardio_details.json");
  const out = projectWorkout(raw, "5364dc07-c229-481f-b92f-0d7ee402fbbf");

  it("parses schema", () => {
    expect(() => WorkoutOut.parse(out)).not.toThrow();
  });
  it("extracts sport name STRENGTH TRAINER", () => {
    expect(out.sport_name).toBe("STRENGTH TRAINER");
  });
  it("extracts start + end timestamps", () => {
    expect(out.start).toBe("2026-05-23T16:49:15.964Z");
    expect(out.end).toBe("2026-05-23T19:24:54.924Z");
  });
  it("computes duration_ms from timestamps", () => {
    const expected = new Date("2026-05-23T19:24:54.924Z").getTime() - new Date("2026-05-23T16:49:15.964Z").getTime();
    expect(out.duration_ms).toBe(expected);
  });
  it("extracts activity strain (17.7)", () => {
    expect(out.strain).toBe(17.7);
  });
  it("extracts avg HR 123 + max HR 171", () => {
    expect(out.avg_hr_bpm).toBe(123);
    expect(out.max_hr_bpm).toBe(171);
  });
  it("extracts calories (701)", () => {
    expect(out.calories).toBe(701);
  });
  it("extracts HR zone durations", () => {
    expect(out.zone_durations.zone_0_ms).toBe(54 * 60 * 1000); // 0:54
    expect(out.zone_durations.zone_1_ms).toBe(81 * 60 * 1000); // 1:21
    expect(out.zone_durations.zone_2_ms).toBe(15 * 60 * 1000); // 0:15
    expect(out.zone_durations.zone_3_ms).toBe(4 * 60 * 1000);  // 0:04
    expect(out.zone_durations.zone_4_ms).toBe(0);              // 0:00
    expect(out.zone_durations.zone_5_ms).toBe(0);              // 0:00
  });
  it("detects strength workout flag", () => {
    expect(out.msk.is_strength_workout).toBe(true);
  });
  it("extracts MSK total volume in kg (converted from lbs tonnage 36720)", () => {
    expect(out.msk.total_volume_kg).toBeGreaterThan(16000);
    expect(out.msk.total_volume_kg).toBeLessThan(17000);
  });
  it("extracts MSK intensity (74%)", () => {
    expect(out.msk.intensity_pct).toBe(74);
  });
});

describe("projectLiftProgression (captured)", () => {
  const raw = load("lift_progression.json");
  const out = projectLiftProgression(raw, "BENCHPRESS_BARBELL", "2026-05-23");

  it("parses schema", () => {
    expect(() => LiftProgressionOut.parse(out)).not.toThrow();
  });
  it("emits at least one segment", () => {
    expect(out.segments.length).toBeGreaterThan(0);
  });
  it("first segment avg_volume = 8963 (from current_metric_value)", () => {
    expect(out.segments[0]?.avg_volume).toBe(8963);
  });
  it("first segment delta_pct = 4 (from metric_change)", () => {
    expect(out.segments[0]?.delta_pct).toBe(4);
  });
  it("first segment unit = lb", () => {
    expect(out.segments[0]?.unit).toBe("lb");
  });
});

describe("projectJournal (captured v3 draft)", () => {
  const raw = load("journal_draft.json");
  const out = projectJournal(raw, "2026-05-23");

  it("parses schema", () => {
    expect(() => JournalOut.parse(out)).not.toThrow();
  });
  it("extracts cycle_id", () => {
    expect(out.cycle_id).not.toBeNull();
  });
  it("behaviors array is well-formed (may be empty)", () => {
    expect(Array.isArray(out.behaviors)).toBe(true);
  });
});

describe("projectLiftPrs (captured)", () => {
  const raw = load("lift_prs.json");
  const out = projectLiftPrs(raw);

  it("parses schema", () => {
    expect(() => LiftPrsOut.parse(out)).not.toThrow();
  });
  it("has at least one PR tile", () => {
    expect(out.length).toBeGreaterThan(0);
  });
  it("BENCHPRESS_BARBELL PR is present with numeric value", () => {
    const bench = out.find((t) => t.exercise_id === "BENCHPRESS_BARBELL");
    expect(bench).toBeDefined();
    expect(bench?.pr_value).not.toBeNull();
    expect(bench?.muscle_groups).toContain("CHEST");
  });
});
