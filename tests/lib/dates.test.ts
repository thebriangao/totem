import { describe, it, expect } from "vitest";
import { isoDay, parsePgRange, rangeFromDays } from "../../src/lib/dates.js";

describe("isoDay", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(isoDay(new Date("2026-05-23T12:00:00"))).toBe("2026-05-23");
  });
});

describe("parsePgRange", () => {
  it("parses a closed-end range", () => {
    expect(
      parsePgRange("['2026-05-23T07:35:46.220Z','2026-05-23T15:35:33.560Z')"),
    ).toEqual({
      start: "2026-05-23T07:35:46.220Z",
      end: "2026-05-23T15:35:33.560Z",
    });
  });
  it("parses an open-ended range (in-progress cycle)", () => {
    expect(parsePgRange("['2026-05-23T07:35:46.220Z',)")).toEqual({
      start: "2026-05-23T07:35:46.220Z",
      end: null,
    });
  });
  it("throws on invalid input", () => {
    expect(() => parsePgRange("not a range")).toThrow();
  });
});

describe("rangeFromDays", () => {
  it("returns a [now-days, now] range", () => {
    const now = new Date("2026-05-23T12:00:00Z");
    const r = rangeFromDays(7, now);
    expect(r.end).toBe("2026-05-23T12:00:00.000Z");
    expect(r.start).toBe("2026-05-16T12:00:00.000Z");
  });
});
