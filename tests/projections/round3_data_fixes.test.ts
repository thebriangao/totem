// Round 3: regression tests for the data-extraction bugs found in the live-API
// audit (each tool returned HTTP 200 but with empty/null payloads). Every assert
// below would FAIL against the pre-fix projections.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectBehaviorImpactList } from "../../src/projections/behavior_impact.js";
import { projectBehaviorImpact } from "../../src/projections/behavior_impact.js";
import { projectWorkout } from "../../src/projections/workout.js";
import { BehaviorImpactListOut } from "../../src/schemas/journal.js";
import { BehaviorImpactOut } from "../../src/schemas/journal.js";
import { WorkoutOut } from "../../src/schemas/workouts.js";
import { LiftProgressionOut } from "../../src/schemas/strength.js";
const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("projectBehaviorImpactList — discovery list exposes the impact_uuids", () => {
  const out = projectBehaviorImpactList(load("behavior_impact_list.json"));

  it("parses schema", () => {
    expect(() => BehaviorImpactListOut.parse(out)).not.toThrow();
  });
  it("returns rows from both IMPACT_TILE and INSUFFICIENT_IMPACT_TILE", () => {
    expect(out.behaviors.length).toBe(5);
    expect(out.behaviors.filter((b) => b.has_sufficient_data).length).toBe(3);
  });
  it("surfaces impact_uuid + name + direction so the detail call is reachable", () => {
    const daylight = out.behaviors.find((b) => b.behavior_name === "Daylight Eating");
    expect(daylight?.impact_uuid).toBe("aa0a7709-8ac2-4f92-b17c-e9eb594d2a46");
    expect(daylight?.direction).toBe("positive");
    expect(daylight?.impact_display).toBe("+7%");
  });
  it("marks insufficient-data behaviors and maps direction", () => {
    const early = out.behaviors.find((b) => b.behavior_name === "Early Workout");
    expect(early?.direction).toBe("insufficient");
    expect(early?.has_sufficient_data).toBe(false);
  });
});

describe("projectBehaviorImpact — header + sections[].items[].impact_card", () => {
  const out = projectBehaviorImpact(load("behavior_impact_details.json"), "aa0a7709-8ac2-4f92-b17c-e9eb594d2a46");

  it("parses schema", () => {
    expect(() => BehaviorImpactOut.parse(out)).not.toThrow();
  });
  it("reads behavior name from header (was null pre-fix)", () => {
    expect(out.behavior_name).toBe("Daylight Eating");
  });
  it("extracts impact metrics from impact_card (was empty pre-fix)", () => {
    expect(out.metrics.length).toBeGreaterThan(0);
    const recovery = out.metrics.find((m) => m.metric === "RECOVERY IMPACT");
    expect(recovery?.delta_avg).toBe(7);
    expect(recovery?.delta_unit).toBe("%");
    expect(recovery?.direction).toBe("positive");
  });
});

describe("projectWorkout — HR curve from position_x (was always empty)", () => {
  const out = projectWorkout(load("cardio_details.json"), "5364dc07-c229-481f-b92f-0d7ee402fbbf");

  it("parses schema", () => {
    expect(() => WorkoutOut.parse(out)).not.toThrow();
  });
  it("populates a downsampled HR curve (was [] pre-fix)", () => {
    expect(out.hr_curve.length).toBeGreaterThan(0);
    expect(out.hr_curve.length).toBeLessThanOrEqual(120);
  });
  it("HR points carry plausible bpm and ISO timestamps inside the workout window", () => {
    expect(out.hr_curve.every((h) => h.bpm > 30 && h.bpm < 230)).toBe(true);
    const first = Date.parse(out.hr_curve[0]!.at);
    expect(first).toBeGreaterThanOrEqual(Date.parse(out.start!) - 1000);
    expect(first).toBeLessThanOrEqual(Date.parse(out.end!) + 1000);
  });
  it("times HR points from their clock labels, dropping the padded axis outside [start, end]", () => {
    // Axis spans 9:35 AM..12:38 PM local (UTC-7); the workout is 9:49 AM..12:24 PM.
    const ats = out.hr_curve.map((h) => Date.parse(h.at));
    expect(ats.every((t) => t >= Date.parse(out.start!) && t <= Date.parse(out.end!))).toBe(true);
    // First in-window label is "9:49 AM" (clamped to start); the downsampled tail
    // lands on "12:23 PM". The old linear mapping put the 9:35 AM point at start.
    expect(out.hr_curve[0]!.at).toBe(out.start);
    expect(out.hr_curve[0]!.bpm).toBe(116);
    expect(out.hr_curve.at(-1)!.at).toBe("2026-05-23T19:23:00.000Z");
  });
});

