import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerStress } from "../../src/tools/v2/stress.js";
import { projectStressV2 } from "../../src/projections/v2/stress.js";
import { StressV2Out } from "../../src/schemas/v2/stress.js";
import { call, closeAll, connect, fx, oldFx, paths, pinToday, routedGet, unpinToday } from "./reads_core_harness.js";

describe("whoop_stress projection", () => {
  it("reads the headline, min/peak and minutes per band from a populated day", () => {
    const out = StressV2Out.parse(projectStressV2(oldFx("stress_bff"), "2026-05-25", false));
    expect(out).toMatchObject({
      state: "RELAXED", level: 0.3, label: "LOW", min: 0.2, peak: 2.2, calibrating: false,
      band_min: { low: 577, medium: 80, high: 5 },
    });
    expect(out.timeline).toBeUndefined();
  });

  it("encodes the opt-in timeline as fixed 30-minute buckets from a start", () => {
    const out = projectStressV2(oldFx("stress_bff"), "2026-05-25", true);
    expect(out.timeline).toMatchObject({ start: expect.stringMatching(/^2026-05-25T00:00:00[-+]\d{2}:\d{2}$/), step_min: 30 });
    // ~12:23 AM to 12:18 PM → 25 half-hour buckets, each a mean level (or null for no samples).
    expect(out.timeline!.levels).toHaveLength(25);
    expect(out.timeline!.levels.every((v) => v === null || (v >= 0 && v <= 3))).toBe(true);
  });

  it("reports calibration on a new account and has no band minutes yet", () => {
    const out = projectStressV2(fx("stress_calibrating"), "2026-11-21", true);
    expect(out).toMatchObject({ state: "CALIBRATING", level: 1.4, label: "MEDIUM", calibrating: true, calibration: { filled: 0, total: 4 } });
    expect(out.band_min).toBeNull();
    expect(out.timeline!.levels.length).toBeGreaterThan(0);
  });
});

describe("whoop_stress tool", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  it("puts the date in the path and keeps the timeline off by default", async () => {
    const get = routedGet({ "/health-service/v2/stress-bff/2026-11-21": fx("stress_calibrating") });
    const out = await call(await connect(registerStress, get), "whoop_stress");
    expect(paths(get)).toEqual(["/health-service/v2/stress-bff/2026-11-21"]);
    expect(out.timeline).toBeUndefined();
    const withTimeline = await call(await connect(registerStress, get), "whoop_stress", { include: ["timeline"] });
    expect(withTimeline.timeline.step_min).toBe(30);
  });
});
