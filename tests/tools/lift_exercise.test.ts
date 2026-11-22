import { describe, expect, it } from "vitest";
import { body, connect, fixture, routes } from "./lift_v2_harness.js";
import { registerLiftExercise } from "../../src/tools/v2/lift_exercise.js";
import { WhoopServerError } from "../../src/whoop/errors.js";

const BENCH = "BENCHPRESS_BARBELL";

describe("whoop_lift_exercise", () => {
  it("default: metadata, history, records and 1RM with manual entry ids, weight unit once", async () => {
    const get = routes({
      [`/weightlifting-service/v1/exercise/${BENCH}`]: fixture("v1_exercise_bench"),
      [`/weightlifting-service/v3/exercise/${BENCH}/exercise_history`]: fixture("history_bench"),
      [`/weightlifting-service/v3/exercise/${BENCH}/personal_records`]: fixture("records_bench"),
      [`/weightlifting-service/v3/one-rep-max/${BENCH}`]: fixture("one_rep_max_card"),
      [`/weightlifting-service/v3/one-rep-max/${BENCH}/history`]: fixture("one_rep_max_history_manual"),
    });
    const client = await connect(registerLiftExercise, { get });
    const out = body(await client.callTool({ name: "whoop_lift_exercise", arguments: { exercise_id: BENCH } }));
    expect(out).toMatchObject({ mode: "exercise", unit: "lb", record_unit: "lb" });
    expect(out.exercise).toMatchObject({ id: BENCH, format: "WEIGHT", e1rm: true, custom: false });
    expect(out.exercise.instructions).toBeUndefined();
    expect(out.history.sessions).toEqual([{ date: "2026-11-21", activity_id: "1f27998b-95c6-4865-acdd-3d413063ce9b", sets: [[100, 5], [100, 5]], medal: "GOLD" }]);
    expect(out.records).toEqual([{ medal: "GOLD", date: "2026-11-21", value: 209 }, { medal: "SILVER", date: "2026-11-21", value: 209 }]);
    expect(out.one_rep_max).toMatchObject({ value: 111, source: "estimated", date: "2026-11-21" });
    expect(out.one_rep_max.history).toContainEqual(["2026-11-20", 150, "manual", "cc8e19b0-fc1a-4fe8-8cb4-e1174dc255f9"]);
    expect(JSON.stringify(out).length).toBeLessThan(1500);
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining("progression"), expect.anything());
  });

  it("resolves a name, falls back to the catalog row when v1 fails, and pages history by cursor", async () => {
    const get = routes({
      "/weightlifting-service/v2/exercise": fixture("catalog"),
      [`/weightlifting-service/v1/exercise/${BENCH}`]: new WhoopServerError(500, "/v1"),
      [`/weightlifting-service/v3/exercise/${BENCH}/exercise_history`]: fixture("history_bench"),
      [`/progression-service/v3/exercise/${BENCH}`]: fixture("progression_bench"),
    });
    const client = await connect(registerLiftExercise, { get });
    const out = body(await client.callTool({ name: "whoop_lift_exercise", arguments: { name: "bench press - barbell", include: ["history", "progression"], cursor: "2026-11-22T00:40:00.000Z", end_date: "2026-11-21" } }));
    expect(out.exercise).toMatchObject({ id: BENCH, name: "Bench Press - Barbell" });
    expect(out.warnings.join()).toMatch(/metadata from the catalog/);
    expect(get).toHaveBeenCalledWith(`/weightlifting-service/v3/exercise/${BENCH}/exercise_history`, { startDate: "2026-11-22T00:40:00.000Z" });
    expect(get).toHaveBeenCalledWith(`/progression-service/v3/exercise/${BENCH}`, { endDate: "2026-11-21" });
    expect(out.progression[0]).toMatchObject({ window: "M", value: 2094, unit: "lb" });
  });

  it("an unknown name returns suggestions", async () => {
    const get = routes({ "/weightlifting-service/v2/exercise": fixture("catalog") });
    const client = await connect(registerLiftExercise, { get });
    const result = await client.callTool({ name: "whoop_lift_exercise", arguments: { name: "bench" } });
    expect(result.isError).toBe(true);
    expect(body(result).suggestions[0]).toMatchObject({ exercise_id: expect.stringContaining("BENCH") });
  });

  it("no exercise: the PR list as compact rows, paged by offset", async () => {
    const pages = [fixture("prs_page0"), fixture("prs_page1"), fixture("prs_page2")];
    const get = routes({ "/weightlifting-service/v3/prs": (q) => pages[((q.offset as number | undefined) ?? 0) / 10] });
    const client = await connect(registerLiftExercise, { get });
    const out = body(await client.callTool({ name: "whoop_lift_exercise", arguments: {} }));
    expect(out.cols).toEqual(["id", "name", "value", "unit"]);
    expect(out.prs).toHaveLength(25);
    expect(out.next ?? null).toBeNull();
    expect(get.mock.calls.map((c) => c[1])).toEqual([{}, { offset: 10 }, { offset: 20 }]);

    const resumed = body(await client.callTool({ name: "whoop_lift_exercise", arguments: { cursor: "20" } }));
    expect(resumed.prs).toHaveLength(6);
  });

  it("a long PR list stops at 30 rows per call (about 1.7 KB) and hands back a cursor", async () => {
    const page = (offset: number) => ({
      tiles: Array.from({ length: 10 }, (_, i) => ({ exercise_id: `BENCHPRESS${offset + i}_BARBELL`, name: `Bench Press ${offset + i} - Barbell`, volume_input_value: "100", volume_input_units: "lbs" })),
      show_more: true,
      next_exercise_offset: offset + 10,
    });
    const get = routes({ "/weightlifting-service/v3/prs": (q) => page((q.offset as number | undefined) ?? 0) });
    const client = await connect(registerLiftExercise, { get });
    const result = await client.callTool({ name: "whoop_lift_exercise", arguments: {} });
    const out = body(result);
    expect(out.prs).toHaveLength(30);
    expect(out.next).toBe("30");
    expect(get).toHaveBeenCalledTimes(3);
    expect((result.content as Array<{ text: string }>)[0]!.text.length).toBeLessThan(2000);
  });
});
