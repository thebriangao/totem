import { describe, expect, it } from "vitest";
import { projectWeightReadings, weightRows } from "../../src/projections/weight_readings.js";
import { buildMeasurementBody, jodaTimestamp, fatFractionToPercent, fatPercentToFraction } from "../../src/lib/weight_readings.js";
import { fx } from "../tools/health_plans_helpers.js";

describe("projectWeightReadings — WEIGHT/readings (throwaway account, 5 readings)", () => {
  const out = projectWeightReadings(fx("weight_readings.json"));

  it("flattens month sections newest first, kg on the wire, body fat fraction → percent", () => {
    expect(out.display_unit).toBe("lb");
    expect(out.readings.map((r) => r.timestamp)).toEqual([
      "2026-11-21T22:55:00.000Z", "2026-11-21T22:50:00.000Z", "2026-11-21T22:40:00.000Z",
      "2026-11-21T22:30:00.000Z", "2026-11-21T22:05:00.000Z",
    ]);
    expect(out.readings[3]).toMatchObject({ id: "3896c91e-f61d-45d0-8f6e-74cf9417a832", weight_kg: 83, body_fat_pct: 22, lean_kg: null, source: "manual", editable: true });
    expect(out.next_token).toBeNull();
  });

  it("never reads the ADD-sheet prefill (manual_measurement_updates holds lb under a _kg name)", () => {
    expect(out.readings).toHaveLength(5);
    expect(out.readings.some((r) => r.weight_kg === 78 && r.timestamp.startsWith("2026-11-21T18"))).toBe(false);
  });

  it("encodes compact columnar rows", () => {
    expect(weightRows(out.readings.slice(3, 4))).toEqual([["3896c91e-f61d-45d0-8f6e-74cf9417a832", "2026-11-21T22:30:00.000Z", 83, 22, null, "manual"]]);
  });

  it("marks integration readings (save_title null) not editable and keeps next_token", () => {
    const raw = { sections: { next_token: "eyJvIjoxMDB9", records: [{ measurements: [{ content: {
      id: "a", metric_unit: "kg", source: "apple_health_kit",
      weight_details_screen: { timestamp: "2026-10-04T08:10:00.000Z", weight_kg: 80.69999694824219, body_fat_percent: 0.18500000236350522, lean_body_mass_kg: 65.77050018310547, save_title: null, source: "apple_health_kit" },
    } }] }] } };
    const p = projectWeightReadings(raw);
    expect(p).toMatchObject({ display_unit: "kg", next_token: "eyJvIjoxMDB9" });
    expect(p.readings[0]).toMatchObject({ weight_kg: 80.7, body_fat_pct: 18.5, lean_kg: 65.7705, editable: false });
  });

  it("degrades to empty on an absent shape", () => {
    expect(projectWeightReadings(null)).toEqual({ display_unit: null, readings: [], next_token: null });
  });
});

describe("weight body builder (ported from PR #35)", () => {
  const ts = "2026-10-13T09:30:00+03:00";

  it("Joda timestamps keep wall clock and offset", () => {
    expect(jodaTimestamp("2026-10-13T09:30:00+03:00")).toBe("2026-10-13T09:30:00.000+0300");
    expect(jodaTimestamp("2026-10-13T09:30:00.25-07:00")).toBe("2026-10-13T09:30:00.250-0700");
    expect(jodaTimestamp("2026-10-13T06:30:00Z")).toBe("2026-10-13T06:30:00.000+0000");
    expect(() => jodaTimestamp("2026-10-13T09:30:00")).toThrow("Invalid timestamp");
  });

  it("body fat percent ↔ fraction", () => {
    expect(fatFractionToPercent(0.18500000236350522)).toBe(18.5);
    expect(fatPercentToFraction(18.5)).toBe(0.185);
  });

  it("sends weight alone with null body composition", () => {
    expect(buildMeasurementBody({ timestamp: ts, weight_kg: 80.5 })).toEqual({
      timestamp: "2026-10-13T09:30:00.000+0300", weight_kg: 80.5, body_fat_percent: null, lean_body_mass_kg: null,
    });
  });

  it("derives the missing one of body fat / lean so the Body Comp trend plots", () => {
    expect(buildMeasurementBody({ timestamp: ts, weight_kg: 80, lean_body_mass_kg: 64 }).body_fat_percent).toBeCloseTo(0.2, 10);
    expect(buildMeasurementBody({ timestamp: ts, weight_kg: 80, body_fat_percent: 18.5 }).lean_body_mass_kg).toBeCloseTo(65.2, 10);
  });

  it("keeps a profile weight to 5 decimals (107.95498 restores exactly)", () => {
    expect(buildMeasurementBody({ timestamp: ts, weight_kg: 107.95498 }).weight_kg).toBe(107.95498);
  });

  it("enforces WHOOP's 0 < kg <= 275 and sane composition", () => {
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 276 })).toThrow(/275/);
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 0 })).toThrow(/above 0/);
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 70, lean_body_mass_kg: 70 })).toThrow(/lean/i);
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 80, body_fat_percent: 18.5, lean_body_mass_kg: 70 })).toThrow(/disagree/i);
    expect(() => buildMeasurementBody({ timestamp: ts, weight_kg: 80, body_fat_percent: 150 })).toThrow(/percentage/);
  });
});
