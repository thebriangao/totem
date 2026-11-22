// whoop_day range mode: GET /core-details-bff/v0/cycles/details → one row per cycle day.
//
// The response is {records: [{cycle, recovery, sleeps[], workouts[], v2_activities[]}]},
// newest first, for every cycle that overlaps the window (so cycles outside the
// asked dates come back too and are filtered here).
//
// Evidence: the cycle and workout parts were read live on the throwaway account
// (2026-11-21). That account has never slept, so `recovery` and `sleeps[]` are
// mapped from three independent open-source clients that agree on the fields:
// recovery_score 0–100, hrv_rmssd in SECONDS, sleep durations in milliseconds.
// Every field is optional here and a missing one is null, never a guess.
import { parsePgRange } from "../../lib/dates.js";

export const HISTORY_COLUMNS = [
  "date", "recovery", "hrv_ms", "rhr", "sleep_perf", "sleep_h", "strain", "kcal", "avg_hr", "max_hr", "workouts", "rr", "spo2",
  "skin_temp_c",
] as const;
export type HistoryColumn = (typeof HISTORY_COLUMNS)[number];
export type HistoryCell = string | number | null;

export interface HistoryTable {
  /** Days with a cycle in the range. */
  count: number;
  /** HISTORY_COLUMNS minus the ones with no value on any day. */
  columns: HistoryColumn[];
  /** Oldest first, one row per cycle day. */
  rows: HistoryCell[][];
  /** Days WHOOP is still scoring: their numbers are partial. */
  pending: string[];
}

const KJ_PER_KCAL = 4.184;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const round = (v: number | null, places = 0): number | null => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places);

function range(v: unknown): { start: string; end: string | null } | null {
  if (typeof v !== "string") return null;
  try {
    return parsePgRange(v);
  } catch {
    return null;
  }
}

/** `days` is "['2026-11-21','2026-11-22')"; the cycle's day is the lower bound. */
function cycleDay(cycle: Record<string, unknown>): string | null {
  const day = range(cycle.days)?.start.slice(0, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function durationMs(v: unknown): number | null {
  const r = range(v);
  if (!r?.end) return null;
  const ms = Date.parse(r.end) - Date.parse(r.start);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** The night's sleep: the longest one that is not a nap. */
function mainSleep(sleeps: unknown[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestMs = -1;
  for (const s of sleeps.map(rec)) {
    if (s.is_nap === true) continue;
    const ms = durationMs(s.during) ?? 0;
    if (ms > bestMs) [best, bestMs] = [s, ms];
  }
  return best;
}

/**
 * Hours asleep. `quality_duration` is milliseconds; `time_in_bed` is in the
 * same unit and must roughly equal the sleep's own start-to-end span, so a
 * payload that ever switched to seconds is caught instead of reported 1000× off.
 */
function hoursAsleep(sleep: Record<string, unknown>): number | null {
  const asleep = positive(sleep.quality_duration);
  if (asleep === null) return null;
  const span = durationMs(sleep.during);
  const inBed = positive(sleep.time_in_bed);
  let perHour = 3_600_000;
  if (span !== null && inBed !== null) {
    const asMs = inBed / span;
    if (asMs < 0.5 || asMs > 1.5) {
      const asSeconds = (inBed * 1000) / span;
      if (asSeconds < 0.5 || asSeconds > 1.5) return null;
      perHour = 3600;
    }
  }
  return round(asleep / perHour, 2);
}

/** WHOOP's private API reports HRV (RMSSD) in seconds: 0.0731 is 73.1 ms. */
function hrvMs(recovery: Record<string, unknown>): number | null {
  const milli = positive(recovery.hrv_rmssd_milli);
  if (milli !== null) return round(milli, 1);
  const v = positive(recovery.hrv_rmssd);
  return v === null ? null : round(v < 1 ? v * 1000 : v, 1);
}

function row(record: unknown): { day: string; pending: boolean; cells: Record<HistoryColumn, HistoryCell> } | null {
  const cycle = rec(rec(record).cycle);
  const day = cycleDay(cycle);
  if (!day) return null;
  const recovery = rec(rec(record).recovery);
  const sleep = mainSleep(arr(rec(record).sleeps));
  const avgHr = positive(cycle.day_avg_heart_rate);
  const maxHr = positive(cycle.day_max_heart_rate);
  const kj = positive(cycle.day_kilojoules);
  // A day the strap recorded nothing has 0 for strain, energy and both heart rates.
  const worn = avgHr !== null || maxHr !== null || kj !== null;
  const state = typeof cycle.data_state === "string" ? cycle.data_state.toLowerCase() : null;
  return {
    day,
    pending: state !== null && state !== "complete",
    cells: {
      date: day,
      recovery: round(num(recovery.recovery_score)),
      hrv_ms: hrvMs(recovery),
      rhr: round(positive(recovery.resting_heart_rate)),
      sleep_perf: sleep ? round(num(sleep.score)) : null,
      sleep_h: sleep ? hoursAsleep(sleep) : null,
      strain: worn ? round(num(cycle.scaled_strain), 1) : null,
      kcal: kj === null ? null : Math.round(kj / KJ_PER_KCAL),
      avg_hr: round(avgHr),
      max_hr: round(maxHr),
      workouts: worn || arr(rec(record).workouts).length > 0 ? arr(rec(record).workouts).length : null,
      rr: sleep ? round(positive(sleep.respiratory_rate), 1) : null,
      spo2: round(positive(recovery.spo2), 1),
      skin_temp_c: round(positive(recovery.skin_temp_celsius), 1),
    },
  };
}

/** Records → a columnar table for startDate..endDate (inclusive), oldest first. */
export function projectHistory(raw: unknown, startDate: string, endDate: string): HistoryTable {
  const kept = arr(rec(raw).records)
    .map(row)
    .filter((r): r is NonNullable<ReturnType<typeof row>> => r !== null && r.day >= startDate && r.day <= endDate)
    .sort((a, b) => a.day.localeCompare(b.day));
  const columns = HISTORY_COLUMNS.filter((c) => c === "date" || kept.some((r) => r.cells[c] !== null));
  return {
    count: kept.length,
    columns: kept.length > 0 ? columns : [],
    rows: kept.map((r) => columns.map((c) => r.cells[c])),
    pending: kept.filter((r) => r.pending).map((r) => r.day),
  };
}
