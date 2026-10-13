import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectBodyMeasurements } from "../../src/projections/body_measurements.js";
import { BodyMeasurementsOut } from "../../src/schemas/body.js";

const load = (): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", "body_readings.json"), "utf8"));

describe("projectBodyMeasurements — /progression-service/v3/trends/WEIGHT/readings", () => {
  const out = projectBodyMeasurements(load());

  it("parses the output schema", () => {
    expect(() => BodyMeasurementsOut.parse(out)).not.toThrow();
  });

  it("flattens month sections into readings with body fat as a rounded percentage", () => {
    expect(out.readings).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", timestamp: "2026-10-04T11:10:00.000+03:00", weight_kg: 80.7, body_fat_percent: 18.5, lean_body_mass_kg: 65.77, source: "apple_health_kit" },
      { id: "00000000-0000-4000-8000-000000000002", timestamp: "2026-08-01T09:27:14.000+03:00", weight_kg: 77, body_fat_percent: null, lean_body_mass_kg: null, source: "manual" },
    ]);
  });

  it("surfaces next_token so a paged response is not silently truncated", () => {
    expect(out.next_token).toBe("page-2");
  });

  it("skips a reading without weight_details_screen.weight_kg rather than trusting content.weight's unit", () => {
    const raw = { sections: { records: [{ measurements: [{ content: { id: "x", weight: 170, weight_details_screen: { timestamp: "2026-10-04T11:10:00.000+03:00" } } }] }] } };
    expect(projectBodyMeasurements(raw).readings).toEqual([]);
  });

  it("returns an empty list when the shape is absent", () => {
    expect(projectBodyMeasurements({})).toEqual({ readings: [], next_token: null });
    expect(projectBodyMeasurements(null)).toEqual({ readings: [], next_token: null });
  });
});
