import { describe, it, expect } from "vitest";
import { mean, slopePerDay, deltaVsWindow } from "../../src/lib/stats.js";

describe("mean", () => {
  it("ignores null/undefined", () => {
    expect(mean([1, 2, 3, null, undefined, 4])).toBe(2.5);
  });
  it("returns null for empty input", () => {
    expect(mean([])).toBeNull();
    expect(mean([null, null])).toBeNull();
  });
});

describe("slopePerDay", () => {
  it("returns positive slope for increasing series", () => {
    const points = [
      { t: new Date("2026-05-01").getTime(), v: 50 },
      { t: new Date("2026-05-02").getTime(), v: 52 },
      { t: new Date("2026-05-03").getTime(), v: 54 },
      { t: new Date("2026-05-04").getTime(), v: 56 },
    ];
    expect(slopePerDay(points)).toBeCloseTo(2, 5);
  });
  it("returns 0 for flat series", () => {
    const points = [
      { t: 0, v: 5 },
      { t: 86400000, v: 5 },
    ];
    expect(slopePerDay(points)).toBe(0);
  });
  it("returns null for fewer than 2 points", () => {
    expect(slopePerDay([{ t: 0, v: 1 }])).toBeNull();
  });
});

describe("deltaVsWindow", () => {
  it("compares latest value to mean of prior window", () => {
    expect(deltaVsWindow(60, [50, 55, 50])).toBeCloseTo(60 - (50 + 55 + 50) / 3, 5);
  });
});
