import { describe, it, expect } from "vitest";
import { isUtcIso, toLocalIso, localizeTimestamps } from "../../src/lib/timezone.js";

describe("isUtcIso", () => {
  it("matches second-precision UTC ISO", () => {
    expect(isUtcIso("2026-05-25T22:30:00Z")).toBe(true);
  });

  it("matches millisecond-precision UTC ISO", () => {
    expect(isUtcIso("2026-05-25T22:30:00.123Z")).toBe(true);
  });

  it("rejects ISO with explicit offset", () => {
    expect(isUtcIso("2026-05-25T15:30:00-07:00")).toBe(false);
  });

  it("rejects date-only strings", () => {
    expect(isUtcIso("2026-05-25")).toBe(false);
  });

  it("rejects free-form strings", () => {
    expect(isUtcIso("Mon May 25 2026")).toBe(false);
    expect(isUtcIso("hello")).toBe(false);
    expect(isUtcIso("")).toBe(false);
  });
});

describe("toLocalIso", () => {
  it("converts UTC to America/Los_Angeles in PDT", () => {
    // May 25 2026 22:30 UTC = May 25 2026 15:30 PDT
    expect(toLocalIso("2026-05-25T22:30:00Z", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00-07:00");
  });

  it("converts UTC to America/Los_Angeles in PST", () => {
    // January 15 2026 22:30 UTC = January 15 2026 14:30 PST
    expect(toLocalIso("2026-01-15T22:30:00Z", "America/Los_Angeles"))
      .toBe("2026-01-15T14:30:00-08:00");
  });

  it("preserves millisecond precision", () => {
    expect(toLocalIso("2026-05-25T22:30:00.123Z", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00.123-07:00");
  });

  it("handles date rollover across midnight", () => {
    // May 26 04:00 UTC = May 25 21:00 PDT (previous day local)
    expect(toLocalIso("2026-05-26T04:00:00Z", "America/Los_Angeles"))
      .toBe("2026-05-25T21:00:00-07:00");
  });

  it("converts to UTC when target tz is UTC", () => {
    expect(toLocalIso("2026-05-25T22:30:00Z", "UTC"))
      .toBe("2026-05-25T22:30:00+00:00");
  });

  it("converts to Asia/Tokyo (positive offset)", () => {
    // May 25 22:30 UTC = May 26 07:30 JST
    expect(toLocalIso("2026-05-25T22:30:00Z", "Asia/Tokyo"))
      .toBe("2026-05-26T07:30:00+09:00");
  });

  it("returns input unchanged for non-UTC strings", () => {
    expect(toLocalIso("2026-05-25", "America/Los_Angeles")).toBe("2026-05-25");
    expect(toLocalIso("hello", "America/Los_Angeles")).toBe("hello");
    expect(toLocalIso("2026-05-25T15:30:00-07:00", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00-07:00");
  });
});

describe("localizeTimestamps", () => {
  it("walks nested objects and converts UTC strings", () => {
    const input = {
      date: "2026-05-25",
      sleep: {
        started_at: "2026-05-25T05:00:00Z",
        ended_at: "2026-05-25T13:30:00Z",
        score: 87,
      },
      workouts: [
        { id: "abc", start: "2026-05-25T22:00:00Z" },
        { id: "xyz", start: "2026-05-25T23:15:00Z" },
      ],
    };
    const result = localizeTimestamps(input, "America/Los_Angeles");
    expect(result).toEqual({
      date: "2026-05-25",
      sleep: {
        started_at: "2026-05-24T22:00:00-07:00",
        ended_at: "2026-05-25T06:30:00-07:00",
        score: 87,
      },
      workouts: [
        { id: "abc", start: "2026-05-25T15:00:00-07:00" },
        { id: "xyz", start: "2026-05-25T16:15:00-07:00" },
      ],
    });
  });

  it("leaves nulls, numbers, booleans unchanged", () => {
    expect(localizeTimestamps({ a: null, b: 42, c: true }, "America/Los_Angeles"))
      .toEqual({ a: null, b: 42, c: true });
  });

  it("leaves a top-level non-UTC string unchanged", () => {
    expect(localizeTimestamps("hello", "America/Los_Angeles")).toBe("hello");
  });

  it("converts a top-level UTC string", () => {
    expect(localizeTimestamps("2026-05-25T22:30:00Z", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00-07:00");
  });
});
