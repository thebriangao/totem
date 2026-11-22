import { describe, it, expect } from "vitest";
import { asNumber, labelToNumber, extractSession } from "../../src/lib/walk.js";

// Number("") and Number("  ") are 0, so a blank cell used to come out as a
// measured zero (0 bpm, 0 kg) instead of "no value".
describe("asNumber", () => {
  it("reads numbers and numeric strings", () => {
    expect(asNumber(42)).toBe(42);
    expect(asNumber(0)).toBe(0);
    expect(asNumber("0")).toBe(0);
    expect(asNumber("14.7")).toBe(14.7);
    expect(asNumber("1,792")).toBe(1792);
    expect(asNumber("-3")).toBe(-3);
  });

  it("treats a blank string as missing, not zero", () => {
    expect(asNumber("")).toBeNull();
    expect(asNumber("   ")).toBeNull();
    expect(asNumber(",")).toBeNull();
  });

  it("returns null for anything that isn't a finite number", () => {
    expect(asNumber("--")).toBeNull();
    expect(asNumber("n/a")).toBeNull();
    expect(asNumber(null)).toBeNull();
    expect(asNumber(undefined)).toBeNull();
    expect(asNumber(true)).toBeNull();
    expect(asNumber(Number.NaN)).toBeNull();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("labelToNumber", () => {
  it("reads display labels", () => {
    expect(labelToNumber("78%")).toBe(78);
    expect(labelToNumber("4,880")).toBe(4880);
    expect(labelToNumber("0")).toBe(0);
    expect(labelToNumber("0%")).toBe(0);
  });

  it("treats an empty label as missing, not zero", () => {
    expect(labelToNumber("")).toBeNull();
    expect(labelToNumber(" ")).toBeNull();
    expect(labelToNumber("%")).toBeNull();
    expect(labelToNumber(null)).toBeNull();
  });

  it("leaves time labels and placeholders as null", () => {
    expect(labelToNumber("1:41")).toBeNull();
    expect(labelToNumber("--")).toBeNull();
  });
});

describe("extractSession", () => {
  it("reports a blank weight as null rather than 0", () => {
    const session = extractSession({
      content: {
        header_content: { record_date: "May 1", record_title: { value: "", unit: "lb" }, record_subtitle: { value: "8" } },
        expanded_content: [{
          type: "EXERCISE_BREAKDOWN",
          content: { rows: [{ items: [{ value: "8" }, { value: "", units: "lb" }] }] },
        }],
      },
    });
    expect(session?.top_set.weight).toBeNull();
    expect(session?.sets).toEqual([{ reps: 8, weight: null, units: "lb", time_seconds: null, medal: null }]);
  });
});
