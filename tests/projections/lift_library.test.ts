import { describe, it, expect } from "vitest";
import { projectLibraryList } from "../../src/projections/lift_library.js";
import { LiftLibraryOut } from "../../src/schemas/strength.js";

describe("projectLibraryList", () => {
  it("reads My Workouts by workout_template_key and Whoop workouts by title", () => {
    const out = projectLibraryList({
      my_workouts_list: [
        { workout_template_key: 1001, name: "Push Day", source: "USER", created_at: "2030-01-02T10:00:00.000Z", is_draft: false },
        { workout_template_key: 1002, name: "Leg Day", source: "AI", created_at: "2030-01-01T09:00:00.000Z" },
      ],
      whoop_workouts_list: [{ id: "900001", title: "Sample Strength Session", paragraph: "45 min" }],
    });
    expect(LiftLibraryOut.parse(out)).toEqual(out);
    if (out.mode !== "list") throw new Error("expected list");
    expect(out.my_workouts.map((w) => [w.template_id, w.name, w.source])).toEqual([
      [1001, "Push Day", "USER"],
      [1002, "Leg Day", "AI"],
    ]);
    expect(out.my_workouts[0]!.created_at).toBe("2030-01-02T10:00:00.000Z");
    expect(out.whoop_workouts).toEqual([{ template_id: 900001, name: "Sample Strength Session", exercise_count: 0 }]);
  });
});
