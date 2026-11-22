import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fixture } from "../tools/lift_v2_harness.js";
import { clockSeconds, displayDate, parseLiftCards } from "../../src/projections/lift_cards.js";
import {
  buildSession,
  compactExercise,
  hasLiftData,
  hoistUnit,
  homeActivities,
  isoTimestamp,
  parseCardioDetails,
  parseHistoryCards,
  setScheme,
} from "../../src/projections/lift_sessions.js";
import {
  exerciseMeta,
  historySession,
  oneRepMaxCard,
  oneRepMaxEntries,
  oneRepMaxRows,
  prRows,
  progressionRows,
} from "../../src/projections/lift_exercise_v2.js";
import { libraryRows, prebuiltDetail, templateDetail } from "../../src/projections/lift_library_v2.js";
import { LiftSessionOut } from "../../src/schemas/strength_v2.js";

const repoFixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

describe("lift card parsing (exercise_history / personal_records)", () => {
  it("parses display helpers", () => {
    expect(clockSeconds("5:00")).toBe(300);
    expect(clockSeconds("1:02:03")).toBe(3723);
    expect(clockSeconds("--")).toBeNull();
    expect(displayDate("November 21, 2026")).toBe("2026-11-21");
    expect(displayDate("· Nov 2, 2026")).toBe("2026-11-02");
    expect(displayDate("yesterday")).toBeNull();
  });

  it("reads a weight card: sets, medal, total, activity button (unperformed sets are absent)", () => {
    const { cards, next_cursor } = parseLiftCards(fixture("history_bench"));
    expect(next_cursor).toBeNull();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      date: "2026-11-21",
      activity_id: "1f27998b-95c6-4865-acdd-3d413063ce9b",
      medal: "GOLD",
      record: { value: 100, unit: "lb" },
      total: { reps: 10, volume: 1000, unit: "lb" },
    });
    expect(cards[0]!.sets).toEqual([
      { reps: 5, time_seconds: null, weight: 100, unit: "lb", medal: "SILVER" },
      { reps: 5, time_seconds: null, weight: 100, unit: "lb", medal: "GOLD" },
    ]);
  });

  it("reads timed cards as seconds", () => {
    const { cards } = parseLiftCards(fixture("history_airbike"));
    expect(cards).toHaveLength(3);
    expect(cards[2]).toMatchObject({ medal: "GOLD", record: { value: 300, unit: "s" }, total: { time_seconds: 300, reps: null } });
    expect(cards[2]!.sets[0]).toMatchObject({ time_seconds: 300, reps: null, weight: 0 });
  });
});

describe("lift sessions projection", () => {
  it("finds activity tiles on home by activity_v2_id and normalises +0000 times", () => {
    const acts = homeActivities(repoFixture("home"), "2026-05-23");
    const lift = acts.find((a) => a.internal_name === "weightlifting_msk")!;
    expect(lift).toMatchObject({ activity_id: "5364dc07-c229-481f-b92f-0d7ee402fbbf", type: "CARDIO", start: "2026-05-23T16:49:15.964Z", end: "2026-05-23T19:24:54.924Z" });
    expect(isoTimestamp("2026-05-23T07:35:46.220+0000")).toBe("2026-05-23T07:35:46.220Z");
  });

  it("parses a scored session's per-set stat rows", () => {
    const detail = repoFixture("cardio_details");
    expect(hasLiftData(detail)).toBe(true);
    expect(hasLiftData(fixture("cardio_details_pending_lift"))).toBe(false);
    const parsed = parseCardioDetails(detail);
    expect(parsed.unit).toBe("lb");
    expect(parsed.volume).toBe(36720);
    const leg = parsed.exercises.find((e) => e.id === "LEGPRESS_PULLEYMACHINE")!;
    expect(leg.sets).toHaveLength(5);
    expect(leg.sets[1]).toEqual({ weight: 180, reps: 10, time_seconds: null, pct_1rm: null, avg_hr: 139, medal: null });
    expect(leg.medals).toEqual(["BRONZE", "SILVER"]);
  });

  it("compacts exercises: scheme, top set, rows only on request", () => {
    const leg = parseCardioDetails(repoFixture("cardio_details")).exercises.find((e) => e.id === "LEGPRESS_PULLEYMACHINE")!;
    const summary = compactExercise(leg, false);
    expect(summary).toEqual({ id: "LEGPRESS_PULLEYMACHINE", sets: "5x10", top: [200, 10], volume: 9600, medal: "SILVER" });
    const withRows = compactExercise(leg, true);
    expect(withRows.rows![1]).toEqual([180, 10, null, 139]);
    expect(setScheme([5, 5, 3])).toBe("5/5/3");
    // "--" rows are sets WHOOP marks not performed
    const skipped = { ...leg, sets: [{ weight: null, reps: null, time_seconds: null, pct_1rm: null, avg_hr: null, medal: null }] };
    expect(compactExercise(skipped, true)).toMatchObject({ sets: "skipped", rows: [] });
    expect(setScheme([300, 300], "s")).toBe("2x300s");
  });

  it("builds a session row and states the unit once", () => {
    const detail = repoFixture("cardio_details");
    const activity = homeActivities(repoFixture("home"), "2026-05-23").find((a) => a.internal_name === "weightlifting_msk")!;
    const session = buildSession(activity, detail, parseCardioDetails(detail), "details", false);
    const { unit, sessions } = hoistUnit([session]);
    expect(unit).toBe("lb");
    expect(() => LiftSessionOut.parse(sessions[0])).not.toThrow();
    expect(sessions[0]).toMatchObject({ id: activity.activity_id, sport: "weightlifting_msk", strain: 17.7, src: "details", msk_pct: 74, unit: null });
    expect(JSON.stringify(sessions[0]).length).toBeLessThan(1500);
  });

  it("builds an unscored session from history cards", () => {
    const { cards } = parseLiftCards(fixture("history_bench"));
    const parsed = parseHistoryCards([{ exercise_id: "BENCHPRESS_BARBELL", name: "Bench Press - Barbell", card: cards[0]! }]);
    expect(parsed).toMatchObject({ volume: 1000, unit: "lb" });
    expect(compactExercise(parsed.exercises[0]!, true)).toMatchObject({ sets: "2x5", top: [100, 5], rows: [[100, 5], [100, 5]], medal: "GOLD" });
  });
});

describe("lift exercise projection", () => {
  it("projects v1 metadata, including a deleted unlinked custom", () => {
    expect(exerciseMeta(fixture("v1_exercise_bench"))).toMatchObject({ id: "BENCHPRESS_BARBELL", custom: false, format: "WEIGHT", e1rm: true, linked: null });
    expect(exerciseMeta(fixture("v1_exercise_custom_deleted"))).toMatchObject({ custom: true, deleted: true, trackable: false, e1rm: false });
    expect(exerciseMeta(fixture("v1_exercise_bench")).instructions).toBeUndefined();
    expect(exerciseMeta(fixture("v1_exercise_bench"), true).instructions!.length).toBeGreaterThan(0);
  });

  it("PR rows: deduped, deleted customs dropped, time in seconds, no fake dates or medals", () => {
    const pages = [fixture("prs_page0"), fixture("prs_page1"), fixture("prs_page0"), fixture("prs_page2")];
    const rows = prRows(pages);
    expect(rows).toHaveLength(25); // 26 tiles, 1 deleted custom, page0 repeated
    expect(rows[0]).toEqual(["BENCHPRESS_BARBELL", "Bench Press - Barbell", 209, "lb"]);
    expect(rows.find((r) => r[0] === "ASSAULT_AIRBIKE")).toEqual(["ASSAULT_AIRBIKE", "Assault Bike", 300, "s"]);
    expect(rows.find((r) => r[0] === "OVERHANDGRIPPULLUPS")![3]).toBe("reps");
    expect(rows.some((r) => String(r[0]).startsWith("520AB719"))).toBe(false);
  });

  it("reads the 1RM card and manual entry ids from history", () => {
    expect(oneRepMaxCard(fixture("one_rep_max_card"))).toEqual({ value: 111, unit: "lb", source: "estimated", date: "2026-11-21" });
    const entries = oneRepMaxEntries(fixture("one_rep_max_history_manual"));
    expect(entries).toContainEqual({ key: "MANUAL-2026-11-20", source: "manual", date: "2026-11-20", value: 150, entry_id: "cc8e19b0-fc1a-4fe8-8cb4-e1174dc255f9" });
    expect(entries).toContainEqual({ key: "ESTIMATED-2026-11-21", source: "estimated", date: "2026-11-21", value: 150, entry_id: null });
    expect(oneRepMaxRows(entries)).toContainEqual(["2026-11-20", 150, "manual", "cc8e19b0-fc1a-4fe8-8cb4-e1174dc255f9"]);
    expect(oneRepMaxEntries(fixture("one_rep_max_history_after_delete")).some((e) => e.source === "manual")).toBe(false);
  });

  it("progression rows per window", () => {
    expect(progressionRows(fixture("progression_bench"))).toEqual([
      { window: "M", metric: "AVG VOLUME LOAD", value: 2094, prev: null, change: null, unit: "lb" },
      { window: "6M", metric: "AVG VOLUME LOAD", value: 2094, prev: null, change: null, unit: "lb" },
    ]);
  });

  it("history sessions as compact set rows", () => {
    const card = parseLiftCards(fixture("history_custom_reps")).cards[0]!;
    expect(historySession(card)).toEqual({ date: "2026-11-21", activity_id: "1f27998b-95c6-4865-acdd-3d413063ce9b", sets: [[50, 8], [50, 8]], medal: null });
  });
});

describe("lift library projection", () => {
  it("lists templates as short rows and hides AI drafts", () => {
    const { my, whoop } = libraryRows(fixture("library"));
    expect(my).toEqual([[18083648, "Nov 21, 2026"], [18083683, "Nov 21, 2026"], [18083998, "Nov 21, 2026"]]);
    expect(whoop[0]).toEqual(["430069", "Virgil van Dijk's Pitch Power", 60]);
  });

  it("template and prebuilt detail", () => {
    expect(templateDetail(fixture("template"), "lb")).toEqual({
      key: 18085254, name: "probe-strength T1 edited", source: "USER", unit: "lb",
      exercises: [{ id: "BENCHPRESS_BARBELL", name: "Bench Press - Barbell", sets: [[105, 3], [105, 3], [105, 3]] }],
    });
    const p = prebuiltDetail(fixture("prebuilt"), "430069");
    expect(p).toMatchObject({ id: "430069", minutes: 60 });
    expect(p.exercises[0]).toEqual({ id: "BULGARIANSQUATLEFT_DUMBBELL", name: "Split Squat - Rear Foot Elevated - L - Dumbbell", sets: "3x8" });
  });
});
