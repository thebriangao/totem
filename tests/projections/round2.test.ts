// Round 2 verifications against captured fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectWorkout } from "../../src/projections/workout.js";
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

// Regression for issue #2: submitted journal entries came back as `behaviors: []`.
// The v3 drafts endpoint nests each logged behavior as
// { behavior_tracker:{id,...}, tracker_input:{behavior_tracker_id, answered_yes, ...} };
// the projection used to read behavior_tracker_id off the top level (always undefined),
// so every behavior was dropped. This fixture is the real populated shape.
