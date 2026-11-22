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
    // The 24 h graph runs 12:23 PM the day before to 12:18 PM: 49 half-hour buckets from noon on the 24th.
    expect(out.timeline).toMatchObject({ start: expect.stringMatching(/^2026-05-24T12:00:00[-+]\d{2}:\d{2}$/), step_min: 30 });
    expect(out.timeline!.levels).toHaveLength(49);
    expect(out.timeline!.levels.every((v) => v === null || (v >= 0 && v <= 3))).toBe(true);
  });

  it("reports calibration on a new account and has no band minutes yet", () => {
    const out = projectStressV2(fx("stress_calibrating"), "2026-11-21", true);
    expect(out).toMatchObject({ state: "CALIBRATING", level: 1.4, label: "MEDIUM", calibrating: true, calibration: { filled: 0, total: 4 } });
    expect(out.band_min).toBeNull();
    expect(out.timeline!.levels.length).toBeGreaterThan(0);
  });
});

describe("whoop_stress graph window and timeline dates", () => {
  beforeAll(pinToday); // America/Los_Angeles
  afterAll(unpinToday);

  type Pt = [clock: string, level: string];
  const graph = (pts: Pt[]) => ({
    graph: { plots: [{ type: "LINE_PLOT", plot: { segments: [{ points: pts.map(([t, v]) => ({ data_scrubber_details: { primary_contextual_display: t, value_display: v } })) }] } }] },
  });
  const at = (iso: string): number => Date.parse(iso);

  // Shaped like the live read of stress-bff/2026-11-22 taken at 20:45 PST on 2026-11-21: that
  // cycle day's samples were from 5:57–6:22 PM on the 21st, and stress_graph held only the later half.
  const split = {
    stress_state: "CALIBRATING",
    gauge: { gauge_score_display: "1.7", gauge_subtext_display: "MEDIUM" },
    previous_stress_graph: graph([["5:57 PM", "2.0"]]),
    stress_graph: graph([["6:02 PM", "0.8"], ["6:05 PM", "0.7"], ["6:20 PM", "1.4"], ["6:21 PM", "1.5"], ["6:22 PM", "1.7"]]),
    extended24_hour_graph: graph([
      ["5:57 PM", "2.0"], ["5:58 PM", "1.8"], ["5:59 PM", "1.5"], ["6:00 PM", "1.3"], ["6:01 PM", "1.1"],
      ["6:02 PM", "0.8"], ["6:05 PM", "0.7"], ["6:20 PM", "1.4"], ["6:21 PM", "1.5"], ["6:22 PM", "1.7"],
    ]),
  };

  it("takes min, peak and the timeline from the whole window, not only stress_graph's later half", () => {
    const out = projectStressV2(split, "2026-11-22", true, at("2026-11-22T04:45:00Z"));
    expect(out).toMatchObject({ min: 0.7, peak: 2 });
    expect(out.timeline!.levels).toEqual([1.8, 1.2]);
  });

  it("never dates the timeline in the future: the window began the day before", () => {
    const out = projectStressV2(split, "2026-11-22", true, at("2026-11-22T04:45:00Z"));
    expect(out.timeline!.start).toBe("2026-11-21T17:30:00-08:00");
  });

  it("starts today's 24 h window on yesterday's date", () => {
    const raw = { extended24_hour_graph: graph([["5:43 PM", "0.8"], ["11:59 PM", "0.5"], ["12:00 AM", "0.4"], ["5:28 PM", "0.9"]]) };
    const out = projectStressV2(raw, "2026-11-21", true, at("2026-11-22T01:30:00Z")); // 5:30 PM on the 21st
    expect(out.timeline!.start).toBe("2026-11-20T17:30:00-08:00");
    expect(out.timeline!.levels).toHaveLength(48);
  });

  it("past days: the date is the side of midnight that holds most of the window", () => {
    const now = at("2026-11-22T01:30:00Z");
    const lateBedtime = { extended24_hour_graph: graph([["12:30 AM", "0.5"], ["11:00 PM", "1.0"], ["12:45 AM", "1.2"]]) };
    expect(projectStressV2(lateBedtime, "2026-11-18", true, now).timeline!.start).toBe("2026-11-18T00:30:00-08:00");
    const eveningBefore = { extended24_hour_graph: graph([["11:00 PM", "0.5"], ["3:00 AM", "0.2"], ["10:00 PM", "1.0"]]) };
    expect(projectStressV2(eveningBefore, "2026-11-18", true, now).timeline!.start).toBe("2026-11-17T23:00:00-08:00");
  });

  it("falls back to stress_graph when the 24 h graph has no samples", () => {
    const raw = { extended24_hour_graph: { graph: { plots: [{ type: "EMPTY_PLOT", plot: {} }] } }, stress_graph: graph([["9:00 AM", "1.0"], ["9:10 AM", "2.0"]]) };
    const out = projectStressV2(raw, "2026-11-18", true, at("2026-11-22T01:30:00Z"));
    expect(out).toMatchObject({ min: 1, peak: 2, timeline: { start: "2026-11-18T09:00:00-08:00", levels: [1.5] } });
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
