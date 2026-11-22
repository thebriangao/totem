import { describe, expect, it } from "vitest";
import { IMPERIAL, body, connect, fixture, notFound, routes } from "./lift_v2_harness.js";
import { registerLiftLibrary } from "../../src/tools/v2/lift_library.js";
import { WhoopServerError } from "../../src/whoop/errors.js";

describe("whoop_lift_library", () => {
  it("lists templates and WHOOP workouts as short rows (PR #42 fields), drafts hidden", async () => {
    const get = routes({ "/weightlifting-service/v3/workout-library": fixture("library") });
    const client = await connect(registerLiftLibrary, { get });
    const out = body(await client.callTool({ name: "whoop_lift_library", arguments: {} }));
    expect(out.my).toHaveLength(3);
    expect(out.my[0]).toEqual([18083648, "Nov 21, 2026"]);
    expect(out.whoop[0]).toEqual(["430069", "Virgil van Dijk's Pitch Power", 60]);
    expect(JSON.stringify(out).length).toBeLessThan(1500);
  });

  it("one template, weights labelled with the display unit", async () => {
    const get = routes({
      "/weightlifting-service/v2/workout-template/18085254": fixture("template"),
      "/users-service/v2/bootstrap": IMPERIAL,
    });
    const client = await connect(registerLiftLibrary, { get });
    const out = body(await client.callTool({ name: "whoop_lift_library", arguments: { template_key: 18085254 } }));
    expect(out.template).toMatchObject({ key: 18085254, unit: "lb", exercises: [{ id: "BENCHPRESS_BARBELL", sets: [[105, 3], [105, 3], [105, 3]] }] });
  });

  it("a prebuilt WHOOP workout; a missing template is a clear error", async () => {
    const get = routes({
      "/weightlifting-service/v2/prebuilt-workout-template/430069": fixture("prebuilt"),
      "/weightlifting-service/v2/workout-template/430069": notFound("/weightlifting-service/v2/workout-template/430069"),
      "/users-service/v2/bootstrap": IMPERIAL,
    });
    const client = await connect(registerLiftLibrary, { get });
    const out = body(await client.callTool({ name: "whoop_lift_library", arguments: { prebuilt_id: "430069" } }));
    expect(out.prebuilt).toMatchObject({ id: "430069", minutes: 60 });
    expect(out.prebuilt.exercises).toHaveLength(7);
    const miss = await client.callTool({ name: "whoop_lift_library", arguments: { template_key: 430069 } });
    expect(miss.isError).toBe(true);
    expect(body(miss).error).toMatch(/prebuilt_id/);
  });

  it("search: ≤10 {id, name} over the bundled catalog plus live customs, by name, muscle or equipment", async () => {
    const get = routes({ "/weightlifting-service/v2/exercise": fixture("catalog") });
    const client = await connect(registerLiftLibrary, { get });
    const bench = body(await client.callTool({ name: "whoop_lift_library", arguments: { search: "bench barbell" } }));
    expect(bench.search.matches).toContainEqual({ id: "BENCHPRESS_BARBELL", name: "Bench Press - Barbell" });
    expect(bench.search.matches.length).toBeLessThanOrEqual(10);
    expect(bench.my).toBeUndefined();
    const custom = body(await client.callTool({ name: "whoop_lift_library", arguments: { search: "probe custom" } }));
    expect(custom.search.matches[0].id).toBe("520AB719-E8B0-45CD-AE63-2F78A1877BDF");
    const legs = body(await client.callTool({ name: "whoop_lift_library", arguments: { search: "legs kettlebell" } }));
    expect(legs.search.matches.length).toBe(10);
    expect(legs.search.more).toBeGreaterThan(0);
  });

  it("search still works from the bundle when WHOOP is down", async () => {
    const get = routes({ "/weightlifting-service/v2/exercise": new WhoopServerError(503, "/x") });
    const client = await connect(registerLiftLibrary, { get });
    const out = body(await client.callTool({ name: "whoop_lift_library", arguments: { search: "deadlift" } }));
    expect(out.search.matches.map((m: { id: string }) => m.id)).toContain("DEADLIFT_BARBELL");
  });
});
