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
  it("shows a write preview's timestamps exactly as they will be sent, not in local time", () => {
    const previous = process.env.WHOOP_TIMEZONE;
    process.env.WHOOP_TIMEZONE = "America/Los_Angeles";
    try {
      const out = JSON.parse(jsonOut({
        preview: true,
        start: "2026-11-21T15:00:00.000Z",
        will_execute: { method: "POST", body: { start_time: "2026-11-21T15:00:00.000Z", nested: [{ end: "2026-11-21T15:30:00.000Z" }] } },
      }));
      // Outside the preview, times read in the member's zone...
      expect(out.start).toBe("2026-11-21T07:00:00-08:00");
      // ...inside it, they are the request's own bytes.
      expect(out.will_execute.body).toEqual({ start_time: "2026-11-21T15:00:00.000Z", nested: [{ end: "2026-11-21T15:30:00.000Z" }] });
    } finally {
      if (previous === undefined) delete process.env.WHOOP_TIMEZONE;
      else process.env.WHOOP_TIMEZONE = previous;
    }
  });
  it("can return a faithful body for whoop_raw", () => {
    expect(jsonOut({ a: null, b: 0.123456 }, { compact: false })).toBe('{"a":null,"b":0.123456}');
  });
});
