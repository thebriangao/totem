import { describe, expect, it } from "vitest";
import { canonicalUtc, jodaTimestamp } from "../../src/lib/dates.js";

describe("canonicalUtc", () => {
  it("converts any ISO offset to a canonical UTC wire timestamp", () => {
    expect(canonicalUtc("2026-08-23T13:02:00-04:00")).toBe("2026-08-23T17:02:00.000Z");
  });

  it("rejects invalid datetimes instead of producing an invalid wire value", () => {
    expect(() => canonicalUtc("not-a-date")).toThrow("Invalid timestamp");
  });
});

describe("jodaTimestamp", () => {
  it("keeps the wall clock and offset in Joda's yyyy-MM-dd'T'HH:mm:ss.SSSZ form", () => {
    expect(jodaTimestamp("2026-10-13T09:30:00+03:00")).toBe("2026-10-13T09:30:00.000+0300");
    expect(jodaTimestamp("2026-10-13T09:30:00.25-07:00")).toBe("2026-10-13T09:30:00.250-0700");
  });

  it("renders UTC as +0000", () => {
    expect(jodaTimestamp("2026-10-13T06:30:00Z")).toBe("2026-10-13T06:30:00.000+0000");
  });

  it("accepts an hour-only offset", () => {
    expect(jodaTimestamp("2026-10-13T09:30:00+03")).toBe("2026-10-13T09:30:00.000+0300");
  });

  it("rejects a datetime without an offset", () => {
    expect(() => jodaTimestamp("2026-10-13T09:30:00")).toThrow("Invalid timestamp");
  });
});
