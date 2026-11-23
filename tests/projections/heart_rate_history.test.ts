// Continuous heart rate (metrics-service) and the bulk day table (cycles/details).
// Both were first read live on the throwaway account on 2026-11-21.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hrPoints, hrWindow, latestHr } from "../../src/projections/v2/heart_rate.js";
import { projectHistory } from "../../src/projections/v2/history.js";
import { hrStepFor } from "../../src/lib/heart_rate.js";
import { DayRangeOut, HrWindowOut } from "../../src/schemas/v2/day.js";

const fx = (name: string): any => JSON.parse(readFileSync(new URL(`../fixtures/v2-core/${name}.json`, import.meta.url), "utf8"));

describe("heart-rate series", () => {
  // WHOOP's shape and timestamps from a live 60 s read; the bpm values are synthetic.
  const raw = fx("hr_60s");
  const START = Date.parse("2026-11-21T23:30:00.000Z");
  const END = Date.parse("2026-11-22T00:30:00.000Z");

  it("reads {time, data} samples in time order and drops zeros, junk and repeats", () => {
    const points = hrPoints({ values: [
      { time: 3000, data: 61 }, { time: 1000, data: 60 }, { time: 2000, data: 0 }, { time: 3000, data: 99 },
      { time: "4000", data: 70 }, { time: 5000, data: null }, { time: 6000, data: 62.6 }, null,
    ] });
    expect(points).toEqual([{ t: 1000, bpm: 60 }, { t: 3000, bpm: 61 }, { t: 6000, bpm: 63 }]);
    expect(hrPoints(null)).toEqual([]);
    expect(hrPoints({ values: "nope" })).toEqual([]);
  });

  it("splits the series into runs at the hole the strap left (live: 53 points, one 350 s gap)", () => {
    const points = hrPoints(raw);
    expect(points).toHaveLength(53);
    const out = HrWindowOut.parse(hrWindow(points, START, END, 60));
    expect(out).toMatchObject({ start: "2026-11-21T23:30:00.000Z", end: "2026-11-22T00:30:00.000Z", step_s: 60, n: 53 });
    expect(out.runs).toHaveLength(2);
    expect(out.runs.map((r) => r.bpm.length)).toEqual([15, 38]);
    // Run starts are the first sample's own time to the second, not the window's edge.
    expect(out.runs.map((r) => r.start)).toEqual(["2026-11-21T23:32:38.000Z", "2026-11-21T23:52:28.000Z"]);
    const all = out.runs.flatMap((r) => r.bpm);
    expect(out.min).toBe(Math.min(...all));
    expect(out.max).toBe(Math.max(...all));
    expect(out.avg).toBe(Math.round(all.reduce((a, b) => a + b, 0) / all.length));
    // bpm[i] really is run.start + i·step: the last sample of run 1 is 14 minutes in, then 350 s of nothing.
    // (WHOOP's sample clock drifts by a few milliseconds, so "evenly spaced" is to within that.)
    expect(Math.abs(points[14]!.t - points[0]!.t - 14 * 60_000)).toBeLessThan(50);
    expect(points[15]!.t - points[14]!.t).toBe(350_000);
  });

  it("reports an empty window as n:0 with null stats and no runs, not as zeros", () => {
    expect(hrWindow([], START, END, 600)).toEqual({
      start: "2026-11-21T23:30:00.000Z", end: "2026-11-22T00:30:00.000Z", step_s: 600, n: 0, min: null, max: null, avg: null, runs: [],
    });
    expect(latestHr([])).toBeNull();
  });

  it("takes the newest sample as the latest heart rate", () => {
    expect(latestHr(hrPoints(raw))).toEqual({ bpm: hrPoints(raw)[52]!.bpm, at: "2026-11-22T00:29:28.000Z" });
  });

  it("picks the finest step WHOOP accepts that keeps a window near 300 readings", () => {
    expect(hrStepFor(10 * 60_000)).toBe(6);
    expect(hrStepFor(30 * 60_000)).toBe(6);
    expect(hrStepFor(30 * 60_000 + 1)).toBe(60);
    expect(hrStepFor(5 * 3_600_000)).toBe(60);
    expect(hrStepFor(5 * 3_600_000 + 1)).toBe(600);
    expect(hrStepFor(48 * 3_600_000)).toBe(600);
  });
});

describe("day table from bulk cycle history", () => {
  // Three live cycles from the throwaway account: an open one, a full day with workouts, and a day with no data.
  const live = fx("cycles_details");

  it("makes one row per cycle day, oldest first, and leaves out columns nobody has a value for", () => {
    const out = projectHistory(live, "2026-11-20", "2026-11-22");
    expect(out.count).toBe(3);
    // No recovery or sleep on this account, so those columns are absent rather than rows of nulls.
    expect(out.columns).toEqual(["date", "strain", "kcal", "avg_hr", "max_hr", "workouts"]);
    expect(out.rows).toEqual([
      // The strap recorded nothing: WHOOP's zeros are "no data", not a 0-strain, 0-bpm day.
      ["2026-11-20", null, null, null, null, null],
      // scaled_strain 20.947…, 990.56 kJ / 4.184, and the two workouts kept in the fixture.
      ["2026-11-21", 20.9, 237, 89, 170, 2],
      ["2026-11-22", 2.9, 95, 86, 123, 0],
    ]);
    expect(out.pending).toEqual(["2026-11-22"]);
  });

  it("keeps only the asked days: WHOOP returns every cycle that overlaps the window", () => {
    const out = projectHistory(live, "2026-11-21", "2026-11-21");
    expect(out.rows.map((r) => r[0])).toEqual(["2026-11-21"]);
    expect(out.pending).toEqual([]);
    expect(projectHistory(live, "2026-10-01", "2026-10-31")).toEqual({ count: 0, columns: [], rows: [], pending: [] });
  });

  // Synthetic: this account has never slept. Field names and units follow three open-source
  // clients of the same endpoint (recovery_score 0–100, hrv_rmssd in seconds, durations in ms).
  const scored = (over: Record<string, unknown> = {}, sleepOver: Record<string, unknown> = {}) => ({ records: [{
    cycle: {
      days: "['2026-08-22','2026-08-23')", data_state: "complete", scaled_strain: 11.04, day_kilojoules: 9000.5,
      day_avg_heart_rate: 70, day_max_heart_rate: 150,
    },
    recovery: { recovery_score: 66, resting_heart_rate: 52, hrv_rmssd: 0.0731, spo2: 96.52, skin_temp_celsius: 33.44, ...over },
    sleeps: [
      { is_nap: true, during: "['2026-08-22T20:00:00.000Z','2026-08-22T20:30:00.000Z')", score: 10, quality_duration: 1_500_000, time_in_bed: 1_800_000 },
      {
        is_nap: false, during: "['2026-08-23T03:10:00.000Z','2026-08-23T11:00:00.000Z')", score: 92,
        quality_duration: 26_000_000, time_in_bed: 28_200_000, respiratory_rate: 15.93, ...sleepOver,
      },
    ],
    workouts: [{ activity_id: "w1" }],
  }] });

  it("maps recovery and the main sleep, converting HRV from seconds and sleep from milliseconds", () => {
    const out = DayRangeOut.parse({ start_date: "2026-08-22", end_date: "2026-08-22", warnings: [], ...projectHistory(scored(), "2026-08-22", "2026-08-22") });
    expect(out.columns).toEqual([
      "date", "recovery", "hrv_ms", "rhr", "sleep_perf", "sleep_h", "strain", "kcal", "avg_hr", "max_hr", "workouts", "rr", "spo2", "skin_temp_c",
    ]);
    // The nap is ignored: 26,000,000 ms asleep is 7.22 h; 9000.5 kJ is 2151 kcal.
    expect(out.rows).toEqual([["2026-08-22", 66, 73.1, 52, 92, 7.22, 11, 2151, 70, 150, 1, 15.9, 96.5, 33.4]]);
  });

  it("accepts HRV that is already in milliseconds", () => {
    const col = (raw: unknown, name: string) => {
      const out = projectHistory(raw, "2026-08-22", "2026-08-22");
      return out.rows[0]![out.columns.indexOf(name as never)];
    };
    expect(col(scored({ hrv_rmssd: undefined, hrv_rmssd_milli: 61.24 }), "hrv_ms")).toBe(61.2);
    expect(col(scored({ hrv_rmssd: 48 }), "hrv_ms")).toBe(48);
  });

  it("checks the sleep duration unit against the sleep's own span instead of trusting it", () => {
    const hours = (sleepOver: Record<string, unknown>) => {
      const out = projectHistory(scored({}, sleepOver), "2026-08-22", "2026-08-22");
      const i = out.columns.indexOf("sleep_h");
      return i < 0 ? null : out.rows[0]![i];
    };
    // Seconds instead of milliseconds: time_in_bed matches the 7 h 50 min span as seconds, so it is read as seconds.
    expect(hours({ quality_duration: 26_000, time_in_bed: 28_200 })).toBe(7.22);
    // A unit that matches neither is not reported at all.
    expect(hours({ quality_duration: 433, time_in_bed: 470 })).toBeNull();
    // With nothing to check against, milliseconds (what every known client reads).
    expect(hours({ time_in_bed: undefined })).toBe(7.22);
  });

  it("degrades to null on missing or malformed parts and skips records without a day", () => {
    const out = projectHistory({ records: [
      { cycle: { days: "garbage" } },
      null,
      { cycle: { days: "['2026-08-22','2026-08-23')", scaled_strain: 3.21, day_avg_heart_rate: 61 }, recovery: null, sleeps: null, workouts: "x" },
    ] }, "2026-08-01", "2026-08-31");
    expect(out).toEqual({ count: 1, columns: ["date", "strain", "avg_hr", "workouts"], rows: [["2026-08-22", 3.2, 61, 0]], pending: [] });
    expect(projectHistory(null, "2026-08-01", "2026-08-31").count).toBe(0);
  });
});
