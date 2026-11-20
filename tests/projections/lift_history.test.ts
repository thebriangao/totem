import { describe, it, expect } from "vitest";
import { projectLiftHistory, hasLiftData } from "../../src/projections/lift_history.js";
import { registerLiftHistory } from "../../src/tools/v2/lift_history.js";
import { LiftHistoryOut } from "../../src/schemas/strength.js";

const lift = (exerciseId: string, sets = "7 Sets") => ({
  weightlifting_cardio_details: {
    weightlifting_exercises: {
      tonnage_units_display: "kg",
      exercise_summary_carousel: {
        items: [
          { exercise_id: null, title_display: "1 Exercises", subtitle_display: sets, tonnage_display: "500.0" },
          { exercise_id: exerciseId, title_display: "Bench Press - Barbell", subtitle_display: sets, tonnage_display: "500.0", volume_display: "10", achievement_icons: ["BADGE_GOLD"] },
        ],
      },
    },
  },
  strain_breakdown: { msk_percent_display: "26%" },
});
const noLift = { weightlifting_cardio_details: null, strain_breakdown: { msk_percent_display: "0%" } };
const rec = (id: string, sport: string) => ({ id, sport_name: sport, start: "2030-01-15T10:00:00.000Z", end: "2030-01-15T11:00:00.000Z", score: { strain: 10.0 } });

describe("hasLiftData", () => {
  it("is true only when the carousel has a real exercise", () => {
    expect(hasLiftData(lift("BENCHPRESS_BARBELL"))).toBe(true);
    expect(hasLiftData(noLift)).toBe(false);
    expect(hasLiftData({})).toBe(false);
    expect(hasLiftData({ weightlifting_cardio_details: { weightlifting_exercises: { exercise_summary_carousel: { items: [{ exercise_id: null }] } } } })).toBe(false);
  });
});

describe("projectLiftHistory", () => {
  it("includes lifts whatever the sport and drops activities without lift data", () => {
    const out = projectLiftHistory({
      workouts: { records: [rec("ff", "functional-fitness"), rec("run", "running"), rec("wl", "weightlifting_msk")] },
      details: [lift("BENCHPRESS_BARBELL"), noLift, lift("BACKSQUAT_BARBELL", "5 Sets")],
    });
    expect(LiftHistoryOut.parse(out)).toEqual(out);
    expect(out.map((w) => [w.activity_id, w.sport_name, w.set_count])).toEqual([
      ["ff", "functional-fitness", 7],
      ["wl", "weightlifting_msk", 5],
    ]);
    expect(out[0]!.exercises[0]!.achievements).toEqual(["BADGE_GOLD"]);
  });
});

describe("whoop_lift_history tool", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

  function setup(pages: Array<{ records: unknown[]; next_token: string | null }>, details: Record<string, unknown>) {
    const gets: Array<{ path: string; query: Record<string, unknown> }> = [];
    let page = 0;
    let handler: Handler | undefined;
    const client = {
      get: async (path: string, query: Record<string, unknown>) => {
        gets.push({ path, query });
        if (path.includes("activity/workout")) return pages[page++];
        return details[query.activityId as string] ?? {};
      },
    };
    const server = { tool: (_n: string, _d: string, _s: unknown, h: Handler) => { handler = h; } };
    registerLiftHistory(server as never, client as never);
    return { gets, run: (args: Record<string, unknown>) => handler!(args) };
  }

  it("pages the workout list and finds lifts on any sport", async () => {
    const { gets, run } = setup(
      [
        { records: [rec("a", "functional-fitness"), rec("b", "stretching")], next_token: "t1" },
        { records: [rec("c", "activity")], next_token: null },
      ],
      { a: lift("BENCHPRESS_BARBELL"), b: noLift, c: lift("DEADLIFT_BARBELL") },
    );
    const out = JSON.parse((await run({ limit: 10 })).content[0]!.text);
    expect(out.map((w: { activity_id: string }) => w.activity_id)).toEqual(["a", "c"]);
    const listCalls = gets.filter((g) => g.path.includes("activity/workout"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]!.query.nextToken).toBe("t1");
  });

  it("stops fetching details once limit lifts are found", async () => {
    const records = Array.from({ length: 20 }, (_, i) => rec(`w${i}`, "functional-fitness"));
    const details = Object.fromEntries(records.map((r) => [r.id, lift("BENCHPRESS_BARBELL")]));
    const { gets, run } = setup([{ records, next_token: null }], details);
    const out = JSON.parse((await run({ limit: 2 })).content[0]!.text);
    expect(out).toHaveLength(2);
    expect(gets.filter((g) => g.path.includes("cardio-details")).length).toBeLessThanOrEqual(6);
  });

  it("includes the whole end_date day in the workout window", async () => {
    const { gets, run } = setup([{ records: [], next_token: null }], {});
    await run({ limit: 5, end_date: "2030-01-15" });
    expect(gets[0]!.query.end).toBe("2030-01-15T23:59:59.999Z");
  });
});
