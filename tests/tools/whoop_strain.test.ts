import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerStrain } from "../../src/tools/v2/strain.js";
import { projectStrainV2 } from "../../src/projections/v2/strain.js";
import { StrainV2Out } from "../../src/schemas/v2/strain.js";
import { call, closeAll, connect, fx, pinToday, queryFor, routedGet, unpinToday } from "./reads_core_harness.js";

describe("whoop_strain projection", () => {
  it("reads score, target band (0–21) and contributors vs baseline in minutes", () => {
    const out = StrainV2Out.parse(projectStrainV2(fx("strain_dd_populated"), "2026-11-18"));
    expect(out).toMatchObject({ score: 11.2, calibrating: false, target: { value: 12.6, low: 11.1, high: 14.9 } });
    expect(out.zones_1_3_min).toEqual({ value: 65, baseline: 48, trend: "HIGHER_POSITIVE" });
    expect(out.zones_4_5_min.value).toBe(12);
    expect(out.strength_min).toEqual({ value: 0, baseline: 15, trend: "LOWER_NEGATIVE" });
    expect(out.steps).toEqual({ value: 9412, baseline: 8105, trend: "HIGHER_POSITIVE" });
    // workouts_count = CARDIO tiles (the deep dive lists no RECOVERY activities).
    expect(out.workouts_count).toBe(2);
    expect(out.activities.map((a) => [a.name, a.strain ?? null])).toEqual([["running", 8.4], ["walking", null]]);
  });

  it("has no target while calibrating and counts every CARDIO tile, pending included", () => {
    const out = projectStrainV2(fx("strain_dd_calibrating"), "2026-11-21");
    expect(out).toMatchObject({ score: 20.9, calibrating: true, target: null, calibration: { filled: 0, total: 4 } });
    expect(out.workouts_count).toBe(out.activities.length);
    expect(out.activities.some((a) => a.status === "PENDING")).toBe(true);
    expect(out.zones_1_3_min.value).toBe(1);
    expect(out.strength_min.value).toBe(2);
    expect(out.steps.value).toBe(597);
  });
});

describe("whoop_strain tool", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  it("reads the strain deep dive for today by default", async () => {
    const get = routedGet({ "/home-service/v1/deep-dive/strain": fx("strain_dd_populated") });
    const out = await call(await connect(registerStrain, get), "whoop_strain");
    expect(queryFor(get, "/home-service/v1/deep-dive/strain")).toEqual({ date: "2026-11-21" });
    expect(out.date).toBe("2026-11-21");
    expect(out.score).toBe(11.2);
  });
});
