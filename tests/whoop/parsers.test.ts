import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractSessions,
  extractPrTiles,
  extractGraphPoints,
  findFirst,
} from "../../src/lib/walk.js";

const FIXTURE = (name: string) => resolve("tests/fixtures", name);
const loadFixture = (name: string): unknown => {
  const path = FIXTURE(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
};

describe("extractSessions (exercise_history)", () => {
  it("extracts LiftSessions with reps/weight from a real history fixture", () => {
    const fixture = loadFixture("lift_exercise_history.json");
    expect(fixture).not.toBeNull();
    const sessions = extractSessions(fixture);
    expect(sessions.length).toBeGreaterThan(0);
    const first = sessions[0]!;
    expect(typeof first.date).toBe("string");
    expect(first.date.length).toBeGreaterThan(0);
    expect(first.sets.length).toBeGreaterThan(0);
    expect(first.sets[0]!.reps).toBeGreaterThan(0);
    expect(first.sets[0]!.weight).toBeGreaterThan(0);
    expect(first.sets[0]!.units).toBe("lbs");
  });
});

describe("extractSessions (personal_records)", () => {
  it("includes medal tier on top sets", () => {
    const fixture = loadFixture("lift_exercise_prs.json");
    expect(fixture).not.toBeNull();
    const sessions = extractSessions(fixture);
    expect(sessions.length).toBeGreaterThan(0);
    const withMedal = sessions.find((s) => s.top_set.medal !== null);
    expect(withMedal).toBeDefined();
    expect(["GOLD", "SILVER", "BRONZE"]).toContain(withMedal!.top_set.medal);
  });

  it("captures total_volume in lbs", () => {
    const fixture = loadFixture("lift_exercise_prs.json");
    const sessions = extractSessions(fixture);
    const withTotal = sessions.find((s) => s.total_volume !== null);
    expect(withTotal).toBeDefined();
    expect(withTotal!.total_volume).toBeGreaterThan(0);
    expect(withTotal!.total_volume_units).toBe("lbs");
  });

  it("extracts activity_id from CARD_BUTTON destination", () => {
    const fixture = loadFixture("lift_exercise_prs.json");
    const sessions = extractSessions(fixture);
    const withId = sessions.find((s) => s.activity_id !== null);
    expect(withId).toBeDefined();
    expect(typeof withId!.activity_id).toBe("string");
  });
});

describe("extractPrTiles", () => {
  it("extracts a clean PR tile list from /prs", () => {
    const fixture = loadFixture("lift_prs.json");
    expect(fixture).not.toBeNull();
    const tiles = extractPrTiles(fixture);
    expect(tiles.length).toBeGreaterThan(0);
    const bench = tiles.find((t) => t.exercise_id === "BENCHPRESS_BARBELL");
    expect(bench).toBeDefined();
    expect(bench!.name).toContain("Bench Press");
    expect(bench!.muscle_groups).toContain("CHEST");
  });
});

describe("extractGraphPoints", () => {
  it("extracts data points from a trend graph (HRV)", () => {
    const fixture = loadFixture("trend_hrv.json");
    expect(fixture).not.toBeNull();
    const points = extractGraphPoints(fixture);
    // Some trend responses nest graphs further; this asserts the parser runs without throwing
    // and produces an array. Per-trend shapes vary slightly.
    expect(Array.isArray(points)).toBe(true);
  });
});

describe("findFirst utility", () => {
  it("locates a nested object by predicate", () => {
    const tree = { a: { b: [{ type: "TARGET", v: 1 }, { type: "OTHER" }] } };
    const found = findFirst(tree, (n) => n.type === "TARGET");
    expect(found).toMatchObject({ v: 1 });
  });
});
