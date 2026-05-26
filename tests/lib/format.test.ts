import { describe, it, expect } from "vitest";
import {
  kjToCal,
  metersToFeet,
  metersToCm,
  kgToLb,
  msToMinutes,
  secondsToMinutes,
} from "../../src/lib/format.js";

describe("format helpers", () => {
  it("kjToCal", () => {
    expect(kjToCal(4184)).toBe(1000);
    expect(kjToCal(2092)).toBe(500);
  });
  it("metersToFeet", () => {
    expect(metersToFeet(1.83)).toBeCloseTo(6.0, 1);
  });
  it("metersToCm", () => {
    expect(metersToCm(1.83)).toBe(183);
  });
  it("kgToLb", () => {
    expect(kgToLb(80)).toBeCloseTo(176.4, 1);
  });
  it("msToMinutes", () => {
    expect(msToMinutes(60000)).toBe(1);
    expect(msToMinutes(90000)).toBe(2);
  });
  it("secondsToMinutes", () => {
    expect(secondsToMinutes(120)).toBe(2);
  });
});
