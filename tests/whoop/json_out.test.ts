import { describe, expect, it } from "vitest";
import { compact, jsonOut } from "../../src/whoop/json_out.js";

describe("compact", () => {
  it("drops null, undefined, empty arrays and empty objects from object properties", () => {
    expect(compact({ a: 1, b: null, c: undefined, d: [], e: {}, f: { g: null }, h: false, i: 0, j: "" })).toEqual({ a: 1, h: false, i: 0, j: "" });
  });
  it("never drops array elements (position can matter)", () => {
    expect(compact({ points: [1, null, 3], rows: [{ a: null }, { a: 2 }] })).toEqual({ points: [1, null, 3], rows: [{}, { a: 2 }] });
  });
  it("rounds floats to 3 decimals and leaves integers alone", () => {
    expect(compact({ score: 0.8726999759674072, hrv: 55.1234567, n: 12, big: 1795305142486 })).toEqual({ score: 0.873, hrv: 55.123, n: 12, big: 1795305142486 });
  });
  it("drops a zero milliseconds part from ISO timestamps", () => {
    expect(compact({ start: "2026-11-21T06:10:00.000-08:00", end: "2026-11-21T14:10:00.000Z", exact: "2026-11-21T06:10:00.123-08:00" }))
      .toEqual({ start: "2026-11-21T06:10:00-08:00", end: "2026-11-21T14:10:00Z", exact: "2026-11-21T06:10:00.123-08:00" });
  });
  it("leaves a write preview's will_execute subtree untouched", () => {
    const preview = { preview: true, will_execute: { method: "PUT", path: "/x", body_summary: { city: null, weight: 80.123456, tags: [] } } };
    expect(compact(preview)).toEqual(preview);
  });
});

describe("jsonOut", () => {
  it("emits compact JSON without whitespace", () => {
    expect(jsonOut({ a: 1, b: null, c: [1.23456] })).toBe('{"a":1,"c":[1.235]}');
  });
  it("can return a faithful body for whoop_raw", () => {
    expect(jsonOut({ a: null, b: 0.123456 }, { compact: false })).toBe('{"a":null,"b":0.123456}');
  });
});
