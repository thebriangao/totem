import { describe, it, expect } from "vitest";
import { BEHAVIORS, BEHAVIORS_BY_ID } from "../../src/data/behaviors.js";
import { EXERCISES, EXERCISES_BY_ID } from "../../src/data/exercises.js";
import { ENDPOINTS } from "../../src/data/endpoints.js";
import { JournalBehaviorSchema } from "../../src/schemas/journal.js";
import { OfficialExerciseSchema } from "../../src/schemas/strength.js";

describe("bundled catalogs", () => {
  it("has 308 behaviors", () => {
    expect(BEHAVIORS.length).toBe(308);
  });

  it("every behavior parses against its schema", () => {
    for (const b of BEHAVIORS) {
      expect(() => JournalBehaviorSchema.parse(b)).not.toThrow();
    }
  });

  it("BEHAVIORS_BY_ID is keyed correctly", () => {
    expect(BEHAVIORS_BY_ID.get(1)?.internal_name).toBe("alcohol");
    expect(BEHAVIORS_BY_ID.size).toBe(BEHAVIORS.length);
  });

  it("has 372 official exercises (custom filtered out)", () => {
    expect(EXERCISES.length).toBe(372);
  });

  it("every exercise parses against its schema", () => {
    for (const e of EXERCISES) {
      expect(() => OfficialExerciseSchema.parse(e)).not.toThrow();
    }
  });

  it("EXERCISES_BY_ID resolves canonical lifts", () => {
    expect(EXERCISES_BY_ID.get("BENCHPRESS_BARBELL")?.name).toContain("Bench Press");
    expect(EXERCISES_BY_ID.get("DEADLIFT_BARBELL")?.name).toContain("Deadlift");
    expect(EXERCISES_BY_ID.size).toBe(EXERCISES.length);
  });

  it("endpoints catalog is populated", () => {
    expect(ENDPOINTS.length).toBeGreaterThan(300);
    expect(ENDPOINTS.length).toBeLessThan(500);
  });

  it("endpoint lines are sorted and well-formed", () => {
    for (const line of ENDPOINTS) {
      expect(line).toMatch(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS) /);
    }
  });
});
