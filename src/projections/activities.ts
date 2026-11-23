// Pure projections for whoop_workouts: home-card tiles and developer records into
// short list rows, and cardio-details (+ recovery-details) into one activity's
// summary, with the HR series only on request.
import { get, parseNumber, str } from "../whoop/bff.js";
import { asArray, isObject } from "../lib/walk.js";
import { typeForInternalName } from "../lib/activity_types.js";
import { toUtc } from "../lib/activity_records.js";
import type { ActivityTile } from "../lib/activity_list.js";
import { projectWorkout } from "./workout.js";
import { WORKOUT_COLUMNS, type ActivityDetailOutT, type ActivityListItemT, type WorkoutRowT } from "../schemas/activities.js";

const norm = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The display name, only when it adds something over the internal name. */
function extraName(display: string | null | undefined, internal: string | null): { name?: string } {
  return display && norm(display) !== norm(internal) ? { name: display } : {};
}

/** List rows carry whole seconds: the milliseconds are noise to a reader. */
function toSecond(iso: string | null): string | null {
  return iso ? iso.replace(/\.\d{3}Z$/, "Z") : null;
}

/** Strain from a display string; "---"/"--" (unscored) → null. */
function strainOf(display: string | null): number | null {
  if (!display || !/\d/.test(display) || display.includes(":")) return null;
  return parseNumber(display);
}

export function projectTile(t: ActivityTile): ActivityListItemT {
  const catalog = typeForInternalName(t.internal_name);
  // score_display is the strain only for CARDIO; RECOVERY and SLEEP show h:mm.
  const strain = t.score_type === "CARDIO" && t.status === "COMPLETE" ? strainOf(t.score_display) : null;
  return {
    activity_id: t.activity_id,
    type: t.score_type ?? catalog?.score_type ?? null,
    internal_name: t.internal_name,
    ...extraName(catalog?.name ?? t.title, t.internal_name),
    start: toSecond(t.start),
    end: toSecond(t.end),
    status: t.status,
    ...(strain !== null ? { strain } : {}),
  };
}

/** One `/developer/v2/activity/workout` record (opt-in source; scored workouts only). */
export function projectDeveloperWorkout(raw: unknown): ActivityListItemT | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const internal = str(raw.sport_name);
  const catalog = typeForInternalName(internal);
  const strain = get(raw, "score", "strain");
  return {
    activity_id: id,
    type: catalog?.score_type ?? null,
    internal_name: internal,
    ...extraName(catalog?.name, internal),
    start: toSecond(toUtc(raw.start)),
    end: toSecond(toUtc(raw.end)),
    status: str(raw.score_state),
    ...(typeof strain === "number" ? { strain: Math.round(strain * 10) / 10 } : {}),
  };
}

/**
 * List items as columnar rows (WORKOUT_COLUMNS order): about 110 characters an
 * activity instead of 200. Display names that add something are stated once in
 * `names`, keyed by internal_name; an activity with no internal name shows its
 * display name in that column.
 */
export function workoutRows(items: ActivityListItemT[]): { columns: Array<(typeof WORKOUT_COLUMNS)[number]>; rows: WorkoutRowT[]; names: Record<string, string> } {
  const names: Record<string, string> = {};
  const rows = items.map((a): WorkoutRowT => {
    if (a.name && a.internal_name) names[a.internal_name] = a.name;
    const min = a.start && a.end ? Math.round((Date.parse(a.end) - Date.parse(a.start)) / 60_000) : null;
    return [a.activity_id, a.type, a.internal_name ?? a.name ?? null, a.start, min, a.status, a.strain ?? null];
  });
  return { columns: rows.length > 0 ? [...WORKOUT_COLUMNS] : [], rows, names };
}

const DISTANCE_TO_M: Record<string, number> = { mi: 1609.344, km: 1000, m: 1, yd: 0.9144, ft: 0.3048 };

/**
 * `map.gps_metrics[]` → meters. Only the summary metrics are read; the route
 * (`gps_coordinates`) is location data and never leaves this function.
 */
export function gpsMetricMeters(cardio: unknown, title: RegExp): number | null {
  for (const m of asArray(get(cardio, "map", "gps_metrics"))) {
    if (!title.test(str(get(m, "value_title_display")) ?? "")) continue;
    const value = parseNumber(get(m, "value_display"));
    const factor = DISTANCE_TO_M[(str(get(m, "unit_display")) ?? "").toLowerCase()];
    if (value === null || factor === undefined) return null;
    return Math.round(value * factor);
  }
  return null;
}

function tileStat(root: unknown, icon: string): number | null {
  for (const t of asArray(get(root, "key_metric_carousel", "key_metric_tile"))) {
    if (str(get(t, "key_metric_tile_icon")) === icon) return parseNumber(get(t, "key_metric_tile_stat_value_display"));
  }
  return null;
}

const ZONE_INDEX: Record<string, number> = { RESTORATIVE: 0, VERY_LIGHT: 1, LIGHT: 2, MODERATE: 3, HARD: 4, MAX: 5 };

/**
 * Minutes (1 decimal) in HR zones 0–5. Each tile shows "h:mm" plus a ":ss"
 * suffix; reading only "h:mm" rounds a short workout's zones to zero.
 */
export function zoneMinutes(cardio: unknown): number[] | null {
  const out: Array<number | null> = [null, null, null, null, null, null];
  for (const z of asArray(get(cardio, "bar_graph_container", "heart_rate_zones"))) {
    const i = ZONE_INDEX[str(get(z, "id")) ?? ""];
    const hm = (str(get(z, "bar_graph_tile_time_display")) ?? "").match(/^(\d+):(\d{2})$/);
    if (i === undefined || !hm) continue;
    const ss = (str(get(z, "bar_graph_tile_time_suffix_display")) ?? "").match(/^:(\d{2})$/);
    const seconds = Number(hm[1]) * 3600 + Number(hm[2]) * 60 + (ss ? Number(ss[1]) : 0);
    out[i] = Math.round(seconds / 6) / 10;
  }
  return out.some((v) => v !== null) ? out.map((v) => v ?? 0) : null;
}

const MAX_HR_POINTS = 120;

/**
 * HR points as `{start, step_s, bpm[]}`, at most 120 values. WHOOP samples HR
 * evenly, but the points' clock labels only resolve to the minute, so the values
 * keep their order and are spread evenly from the first to the last point
 * (`fallbackSpanMs`, the activity's duration, when those share one minute).
 */
export function hrSeries(points: ReadonlyArray<{ at: string; bpm: number }>, fallbackSpanMs: number | null = null): { start: string; step_s: number; bpm: number[] } | null {
  const timed = points.map((p) => ({ t: Date.parse(p.at), bpm: p.bpm })).filter((p) => Number.isFinite(p.t));
  if (!timed.length) return null;
  const picked = timed.length > MAX_HR_POINTS
    ? Array.from({ length: MAX_HR_POINTS }, (_, i) => timed[Math.floor((i * timed.length) / MAX_HR_POINTS)]!)
    : timed;
  const first = Math.min(...picked.map((p) => p.t));
  const last = Math.max(...picked.map((p) => p.t));
  const spanMs = last > first ? last - first : (fallbackSpanMs ?? 0);
  const step = picked.length > 1 ? Math.max(1, Math.round(spanMs / 1000 / (picked.length - 1))) : 0;
  return { start: new Date(first).toISOString(), step_s: step, bpm: picked.map((p) => Math.round(p.bpm)) };
}

/**
 * Summary for a CARDIO or RECOVERY activity. `cardio` is GET cd/v1/cardio-details;
 * `recovery` is GET cd/v2/recovery-details for RECOVERY activities (or null).
 */
export function projectActivityDetail(cardio: unknown, recovery: unknown, activityId: string, opts: { hr?: boolean } = {}): ActivityDetailOutT {
  const base = projectWorkout(cardio, activityId);
  const edit = get(cardio, "details_edit_components") ?? get(recovery, "details_edit_components");
  const internal = str(get(edit, "activity_type_internal_name"));
  const catalog = typeForInternalName(internal);
  const scoreType = str(get(edit, "single_score_type")) ?? catalog?.score_type ?? null;
  const isRecovery = scoreType === "RECOVERY";
  const strain = isRecovery ? null : strainOf(str(get(cardio, "horizontal_stat", "stat_main_value_display")));
  const warnings: string[] = [];
  if (!isRecovery && strain === null) {
    warnings.push("Not scored yet (\"---\"): WHOOP scores it from strap data in the window; with none it never scores.");
  }
  // Recovery sessions: MIN/AVG/MAX HR from the recovery screen when present.
  const recMin = recovery ? tileStat(recovery, "RHR") : null;
  const recAvg = recovery ? tileStat(recovery, "HEART_RATE") : null;
  const recMax = recovery ? tileStat(recovery, "MAX_HEART_RATE") : null;
  const linkable = get(cardio, "link_workout_option_enabled");
  const isStrength = base.msk.is_strength_workout || catalog?.msk_linkable === true;
  const elevation = gpsMetricMeters(cardio, /ELEV/i);
  const hr = opts.hr ? hrSeries(base.hr_curve, base.duration_ms) : null;
  // No strap data in the window: WHOOP shows 0 bpm, 0 kcal and all-zero zones.
  // Those are "no data", not measurements, so they're left out.
  const positive = (v: number | null | undefined): number | null => (typeof v === "number" && v > 0 ? v : null);
  const avgHr = positive(recAvg ?? base.avg_hr_bpm);
  const maxHr = positive(recMax ?? base.max_hr_bpm);
  const minHr = positive(recMin);
  const hasHr = avgHr !== null || maxHr !== null;
  const zones = zoneMinutes(cardio);
  return {
    type: scoreType,
    internal_name: internal,
    sport_id: catalog?.sport_id ?? null,
    ...extraName(catalog?.name ?? base.sport_name, internal),
    start: base.start,
    end: base.end,
    duration_ms: base.duration_ms,
    strain,
    calories: hasHr ? base.calories : positive(base.calories),
    avg_hr_bpm: avgHr,
    max_hr_bpm: maxHr,
    ...(minHr !== null ? { min_hr_bpm: minHr } : {}),
    zones_min: zones && zones.some((z) => z > 0) ? zones : null,
    distance_m: gpsMetricMeters(cardio, /DISTANCE/i),
    ...(elevation !== null ? { elevation_gain_m: elevation } : {}),
    ...(isStrength ? { msk: { total_volume_kg: base.msk.total_volume_kg, intensity_pct: base.msk.intensity_pct } } : {}),
    strength_trainer_linkable: typeof linkable === "boolean" ? linkable : null,
    ...(hr ? { hr } : {}),
    warnings,
  };
}
