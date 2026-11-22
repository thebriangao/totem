// Projections and catalogs behind whoop_workouts / whoop_activity_* (v2).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVITY_TYPES, SPORTS, SPORTS_BY_ID, SPORTS_BY_NAME } from "../../src/data/sports.js";
import { GARMENTS_BY_ID } from "../../src/data/garments.js";
import { joinActivityCatalog, resolveActivityType, resolveGarment, suggestActivityTypes } from "../../src/lib/activity_types.js";
import { activityTiles, calendarDataDays, daySpan, enumerateDays, overlaps } from "../../src/lib/activity_list.js";
import { recordFromActivity, recordFromCardioDetails, recordFromSleepDetails } from "../../src/lib/activity_records.js";
import { gpsMetricMeters, hrSeries, projectActivityDetail, projectDeveloperWorkout, projectTile } from "../../src/projections/activities.js";
import { ActivityDetailOut, ActivityListItem } from "../../src/schemas/activities.js";

const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("activity catalog (src/data/sports.ts)", () => {
  it("has the 208 v2 types and 205 current sport ids", () => {
    expect(ACTIVITY_TYPES).toHaveLength(208);
    expect(SPORTS).toHaveLength(205);
  });
  it("adds 336–346 and drops the 9 retired ids", () => {
    for (let id = 336; id <= 346; id++) expect(SPORTS_BY_ID.has(id)).toBe(true);
    for (const id of [-1, 50, 54, 58, 67, 68, 69, 72, 116]) expect(SPORTS_BY_ID.has(id)).toBe(false);
    expect(SPORTS_BY_ID.get(339)).toMatchObject({ name: "Ski Erg", internal_name: "ski-erg", score_type: "CARDIO" });
  });
  it("keeps the v1 exports (id + name) working", () => {
    expect(SPORTS_BY_NAME.get("running")?.id).toBe(0);
    expect(SPORTS_BY_ID.get(45)?.name).toBe("Weightlifting");
  });
  it("carries score_type, category and msk_linkable", () => {
    expect(SPORTS_BY_ID.get(233)).toMatchObject({ internal_name: "sauna", score_type: "RECOVERY", category: "restorative" });
    expect(ACTIVITY_TYPES.filter((t) => t.msk_linkable).map((t) => t.internal_name).sort()).toEqual(
      ["barrys", "bodybuilding", "box-fitness", "f45-training", "functional-fitness", "hiit", "powerlifting", "weightlifting", "weightlifting_msk"]);
    expect(ACTIVITY_TYPES.filter((t) => t.sport_id === null).map((t) => t.internal_name).sort()).toEqual(["activity", "nap", "sleep"]);
  });
  it("keeps WHOOP's untrimmed internal names verbatim", () => {
    expect(ACTIVITY_TYPES.some((t) => t.internal_name === "cheeerleading ")).toBe(true);
  });
  it("has the garment catalog", () => {
    expect([...GARMENTS_BY_ID.keys()]).toEqual([1, 2, 3, 6, 7, 9, 10, 11, 12, 13, 14, 15]);
    expect(resolveGarment(1).ok).toBe(true);
    expect(resolveGarment(99)).toMatchObject({ ok: false });
  });
});

describe("resolveActivityType", () => {
  it("resolves internal names, display names, loose spellings and sport ids", () => {
    expect(resolveActivityType("ski-erg")).toMatchObject({ ok: true, type: { internal_name: "ski-erg" }, matched_by: "internal_name" });
    expect(resolveActivityType("Strength Trainer")).toMatchObject({ ok: true, type: { internal_name: "weightlifting_msk" } });
    expect(resolveActivityType("skierg")).toMatchObject({ ok: true, type: { internal_name: "ski-erg" } });
    expect(resolveActivityType("cheeerleading")).toMatchObject({ ok: true, type: { internal_name: "cheeerleading " } });
    expect(resolveActivityType(39)).toMatchObject({ ok: true, type: { internal_name: "boxing" }, matched_by: "sport_id" });
    expect(resolveActivityType("339")).toMatchObject({ ok: true, type: { internal_name: "ski-erg" } });
    expect(resolveActivityType("nap")).toMatchObject({ ok: true, type: { score_type: "SLEEP", sport_id: null } });
  });
  it("names retired sport ids and suggests replacements", () => {
    const r = resolveActivityType(54);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Jogging");
      expect(r.suggestions.length).toBeGreaterThan(0);
    }
  });
  it("returns the top-5 suggestions on a miss", () => {
    const r = resolveActivityType("weight lifting machine");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestions).toHaveLength(5);
    expect(suggestActivityTypes("bike")[0]).toMatch(/bike|cycling/i);
    expect(suggestActivityTypes("runing")[0]).toBe("running (Running)");
  });
  it("joins live catalogs the same way the bundle was generated", () => {
    const live = joinActivityCatalog(
      [{ id: 999, name: "Zorbing", activity_type_internal_name: null, is_current: true }, { id: 54, name: "Jogging", is_current: false }],
      [{ internal_name: "zorbing", display_name: "Zorbing", category: "cardiovascular", score_type: "CARDIO" }, { internal_name: "jogging", display_name: "Jogging", score_type: "CARDIO" }],
    );
    expect(live).toEqual([
      expect.objectContaining({ internal_name: "zorbing", sport_id: 999 }),
      expect.objectContaining({ internal_name: "jogging", sport_id: null }),
    ]);
  });
});

describe("home-card listing", () => {
  const home = load("activities/home_2026-11-21.json");
  const tiles = activityTiles(home, "2026-11-21");

  it("finds every ACTIVITY tile by activity_v2_id, index-free", () => {
    expect(tiles).toHaveLength(17);
    expect(tiles[0]).toMatchObject({
      activity_id: "addd5396-b934-4ae8-ba4e-a511762a0d53", score_type: "SLEEP", internal_name: "sleep",
      start: "2026-11-21T10:15:00.000Z", end: "2026-11-21T13:45:00.000Z", cycle_day: "2026-11-21",
    });
  });
  it("projects one short row per activity", () => {
    const rows = tiles.map(projectTile);
    for (const r of rows) expect(() => ActivityListItem.parse(r)).not.toThrow();
    const boxing = rows.find((r) => r.internal_name === "boxing")!;
    expect(boxing).toEqual({
      activity_id: "70ad76a1-1e3c-4c8e-a026-903ff3175783", type: "CARDIO", internal_name: "boxing",
      start: "2026-11-22T00:24:37Z", end: "2026-11-22T00:27:03Z", status: "COMPLETE", strain: 4.6,
    });
    // RECOVERY shows a duration, not a strain; INCOMPLETE cardio's "0.0" isn't a strain either.
    expect(rows.find((r) => r.internal_name === "sauna")).not.toHaveProperty("strain");
    expect(rows.find((r) => r.internal_name === "running")).not.toHaveProperty("strain");
    // The display name only appears when it says more than the internal name.
    expect(rows.find((r) => r.internal_name === "weightlifting_msk")?.name).toBe("Strength Trainer");
    expect(rows.find((r) => r.internal_name === "sauna")?.name).toBe("Dry Sauna");
    expect(boxing).not.toHaveProperty("name");
  });
  it("reads calendar days with data as full dates", () => {
    expect(calendarDataDays(load("activities/calendar_overview_2026-11.json"), "2026-11-01")).toEqual(
      ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-25"]);
  });
  it("enumerates inclusive day ranges", () => {
    expect(enumerateDays("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(daySpan("2026-11-01", "2026-12-01")).toBe(31);
  });
  it("treats windows as half-open", () => {
    expect(overlaps(0, 10, 10, 20)).toBe(false);
    expect(overlaps(0, 11, 10, 20)).toBe(true);
  });
});

describe("activity records", () => {
  it("parses the shared record and its pg range", () => {
    expect(recordFromActivity({ activity: { id: "a", type: "sauna", score_type: "RECOVERY", version: 2, during: "['2026-11-21T15:00:00.000Z','2026-11-21T15:20:00.000Z')", score_state: "pending" } }))
      .toEqual({ id: "a", type: "sauna", score_type: "RECOVERY", start: "2026-11-21T15:00:00.000Z", end: "2026-11-21T15:20:00.000Z", version: 2, score_state: "pending", source: "record" });
  });
  it("tells nap from sleep on sleep-details", () => {
    expect(recordFromSleepDetails({ sleep_details_edit_components: { sleep_start_time: "2026-11-21T08:30:00.000Z", sleep_end_time: "2026-11-21T09:00:00.000Z", nap_to_sleep_available: true } }, "n"))
      .toMatchObject({ type: "nap", score_type: "SLEEP", start: "2026-11-21T08:30:00.000Z" });
    expect(recordFromSleepDetails({ sleep_details_labels: { screen_title_display: "INCOMPLETE SLEEP" } }, "s").type).toBe("sleep");
  });
  it("reads type and window from cardio-details edit components", () => {
    expect(recordFromCardioDetails(load("activities/cardio_details_pending_sauna.json"), "x")).toMatchObject({
      type: "sauna", score_type: "RECOVERY", start: "2026-11-21T15:00:00.000Z", end: "2026-11-21T15:20:00.000Z",
    });
  });
});

describe("projectActivityDetail", () => {
  it("summarizes a pending recovery session with the recovery screen's HR", () => {
    const out = projectActivityDetail(load("activities/cardio_details_pending_sauna.json"), load("activities/recovery_details_sauna.json"), "6db1e439");
    expect(() => ActivityDetailOut.parse(out)).not.toThrow();
    expect(out).toMatchObject({
      type: "RECOVERY", internal_name: "sauna", sport_id: 233, name: "Dry Sauna", strain: null,
      min_hr_bpm: 58, avg_hr_bpm: 71, max_hr_bpm: 96, duration_ms: 20 * 60_000, warnings: [],
    });
    expect(out).not.toHaveProperty("hr");
  });
  it("flags an unscored cardio activity instead of erroring", () => {
    const out = projectActivityDetail(load("activities/cardio_details_pending_boxing.json"), null, "29792beb");
    expect(out.strain).toBeNull();
    expect(out.warnings[0]).toContain("Not scored yet");
  });
  it("keeps the default summary small and the HR series opt-in", () => {
    const raw = load("cardio_details.json");
    const summary = projectActivityDetail(raw, null, "5364dc07");
    expect(summary).toMatchObject({ type: "CARDIO", internal_name: "weightlifting_msk", strain: 17.7, avg_hr_bpm: 123, max_hr_bpm: 171 });
    // "h:mm" + ":ss" suffix: 0:54 :34 → 54.6 min.
    expect(summary.zones_min).toEqual([54.6, 81.5, 15.1, 4.5, 0, 0]);
    expect(summary.msk).toBeDefined();
    expect(JSON.stringify(summary).length).toBeLessThan(1500);
    const withHr = projectActivityDetail(raw, null, "5364dc07", { hr: true });
    expect(withHr.hr!.bpm.length).toBeGreaterThan(10);
    expect(withHr.hr!.bpm.length).toBeLessThanOrEqual(120);
    expect(withHr.hr!.step_s).toBeGreaterThan(0);
    expect(() => ActivityDetailOut.parse(withHr)).not.toThrow();
  });
  it("reads distance and elevation from map.gps_metrics, never the route", () => {
    const raw = {
      ...(load("activities/cardio_details_pending_boxing.json") as object),
      map: {
        gps_coordinates: [{ latitude: 1, longitude: 2 }],
        gps_metrics: [
          { unit_display: "mi", value_display: "3.10", value_title_display: "DISTANCE" },
          { unit_display: "mph", value_display: "6.2", value_title_display: "SPEED" },
          { unit_display: "ft", value_display: "120", value_title_display: "ELEV. GAIN" },
        ],
      },
    };
    expect(gpsMetricMeters(raw, /DISTANCE/i)).toBe(4989);
    const out = projectActivityDetail(raw, null, "x");
    expect(out).toMatchObject({ distance_m: 4989, elevation_gain_m: 37 });
    expect(JSON.stringify(out)).not.toContain("latitude");
  });
});

describe("hrSeries", () => {
  it("downsamples to at most 120 evenly spaced values", () => {
    const pts = Array.from({ length: 600 }, (_, i) => ({ at: new Date(Date.UTC(2026, 10, 21, 16, 0, i * 6)).toISOString(), bpm: 100 + (i % 10) }));
    const s = hrSeries(pts)!;
    expect(s.start).toBe("2026-11-21T16:00:00.000Z");
    expect(s.bpm).toHaveLength(120);
    expect(s.step_s).toBe(30); // ≈ 3570 s / 119
  });
  it("spreads minute-resolution points evenly instead of stair-stepping", () => {
    // Clock labels resolve to the minute: three points share 16:00, two share 16:01.
    const at = (m: number) => `2026-11-21T16:0${m}:00.000Z`;
    const s = hrSeries([{ at: at(0), bpm: 90 }, { at: at(0), bpm: 95 }, { at: at(0), bpm: 100 }, { at: at(1), bpm: 110 }, { at: at(1), bpm: 120 }])!;
    expect(s).toEqual({ start: at(0), step_s: 15, bpm: [90, 95, 100, 110, 120] });
    // All in one minute: the activity's duration sets the spacing.
    expect(hrSeries([{ at: at(0), bpm: 90 }, { at: at(0), bpm: 100 }], 40_000)).toMatchObject({ step_s: 40 });
    expect(hrSeries([{ at: at(0), bpm: 80 }])).toEqual({ start: at(0), step_s: 0, bpm: [80] });
    expect(hrSeries([])).toBeNull();
  });
});

describe("projectDeveloperWorkout (opt-in source)", () => {
  it("maps a scored developer record to a list row", () => {
    const raw = load("activities/developer_workouts.json") as { records: unknown[] };
    const row = projectDeveloperWorkout(raw.records[1])!;
    expect(row).toMatchObject({ activity_id: "e6220ee1-f0fa-4139-b3e0-98adcb1bd636", internal_name: "weightlifting_msk", status: "SCORED", strain: 20.9, type: "CARDIO" });
    expect(() => ActivityListItem.parse(row)).not.toThrow();
  });
});
