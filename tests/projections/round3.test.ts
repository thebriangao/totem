// Round 3 — final coverage against captured fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectLiftExercise } from "../../src/projections/lift_exercise.js";
import { projectProfile } from "../../src/projections/profile.js";

import { LiftExerciseOut } from "../../src/schemas/strength.js";
import { ProfileOut } from "../../src/schemas/profile.js";

const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("projectLiftExercise (captured)", () => {
  const info = load("exercise_info.json");
  const history = load("lift_exercise_history.json");
  const prs = load("lift_exercise_prs.json");
  const out = projectLiftExercise({ info, history, prs });

  it("parses schema", () => {
    expect(() => LiftExerciseOut.parse(out)).not.toThrow();
  });
  it("extracts exercise metadata", () => {
    expect(out.exercise.id).toBeTruthy();
    expect(out.exercise.name).toBeTruthy();
    expect(out.exercise.muscle_groups.length).toBeGreaterThan(0);
  });
  it("recent_sessions has at least one session with sets", () => {
    expect(out.recent_sessions.length).toBeGreaterThan(0);
    expect(out.recent_sessions[0]?.sets.length).toBeGreaterThan(0);
  });
  it("session top_set has reps + weight", () => {
    const s = out.recent_sessions[0]!;
    expect(s.top_set.reps).toBeGreaterThan(0);
    expect(s.top_set.weight).not.toBeNull();
  });
  it("personal_records has medal entries", () => {
    const withMedal = out.personal_records.find((s) => s.top_set.medal !== null);
    expect(withMedal).toBeDefined();
  });
});

describe("projectProfile (captured)", () => {
  const bootstrap = load("bootstrap.json");
  const out = projectProfile({
    bootstrap,
    hidden_body_comp: { is_hidden: false },
    hidden_healthspan: { is_hidden: true },
    stealth: { enabled: false },
  });

  it("parses schema", () => {
    expect(() => ProfileOut.parse(out)).not.toThrow();
  });
  it("extracts user_id + account_id + email + username", () => {
    expect(out.user_id).toBeGreaterThan(0);
    expect(out.account_id).toBeGreaterThan(0);
    expect(out.email).toContain("@");
    expect(out.username).toBeTruthy();
  });
  it("populates height in m/cm/ft from bootstrap", () => {
    expect(out.height.m).not.toBeNull();
    expect(out.height.cm).not.toBeNull();
    expect(out.height.ft).not.toBeNull();
  });
  it("populates weight in kg/lb", () => {
    expect(out.weight.kg).not.toBeNull();
    expect(out.weight.lb).not.toBeNull();
  });
  it("extracts bio_data max_hr + resting_hr", () => {
    expect(out.bio_data.max_hr_bpm).toBeGreaterThan(0);
    expect(out.bio_data.resting_hr_bpm).toBeGreaterThan(0);
  });
  it("merges hidden-metric + stealth state into privacy block", () => {
    expect(out.privacy.body_comp_hidden).toBe(false);
    expect(out.privacy.healthspan_hidden).toBe(true);
    expect(out.privacy.stealth_mode).toBe(false);
  });
});
