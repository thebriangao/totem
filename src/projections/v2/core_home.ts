// GET /home-service/v1/home?date= parsing shared by whoop_day, whoop_sleep and
// whoop_strain (SPEC.md §4.2). The activities card moves around (it sits inside
// DAY_ZERO_CARDS on a new account and in `activity_items_card` otherwise), so
// tiles are found by walking for objects that carry `activity_v2_id`.
import {
  byType, displayMinutes, displayNumber, findFirst, get, isNode, isoInstant, parseNumber, str, type Node,
} from "./core_common.js";

export type ActivityKind = "CARDIO" | "RECOVERY" | "SLEEP";

export interface ActivityTile {
  id: string;
  type: string;
  /** internal_name (the activity type writes take, e.g. "running", "weightlifting_msk", "nap"). */
  name: string | null;
  status: string | null;
  start: string | null;
  end: string | null;
  /** CARDIO strain (0–21) once scored; null while pending/incomplete. */
  strain: number | null;
  /** RECOVERY and SLEEP tiles show a duration; minutes, null for CARDIO or no data. */
  min: number | null;
}

/** Every ACTIVITY tile in a home or deep-dive payload, deduped by id, in time order. */
export function activityTiles(root: unknown): ActivityTile[] {
  const seen = new Map<string, ActivityTile>();
  for (const n of collectWithActivityId(root)) {
    const id = str(n.activity_v2_id);
    if (!id || seen.has(id)) continue;
    const type = str(n.type) ?? "UNKNOWN";
    const status = str(n.status);
    const complete = status === "COMPLETE";
    seen.set(id, {
      id,
      type,
      name: str(n.internal_name),
      status,
      start: isoInstant(get(n, "during", "lower_endpoint")),
      end: isoInstant(get(n, "during", "upper_endpoint")),
      strain: type === "CARDIO" && complete ? displayNumber(n.score_display) : null,
      min: type !== "CARDIO" && complete ? displayMinutes(n.score_display) : null,
    });
  }
  return [...seen.values()].sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
}

function collectWithActivityId(root: unknown): Node[] {
  const out: Node[] = [];
  const stack: unknown[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
    else if (isNode(cur)) {
      if (typeof cur.activity_v2_id === "string") out.push(cur);
      const vals = Object.values(cur);
      for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
    }
  }
  return out;
}

/** Compact activity row for outputs: CARDIO carries strain, others carry minutes. */
export function activityRow(t: ActivityTile): Record<string, unknown> {
  const row: Record<string, unknown> = { id: t.id, name: t.name, status: t.status, start: t.start, end: t.end };
  if (t.type === "CARDIO") row.strain = t.strain;
  else row.min = t.min;
  return row;
}

export interface CoachRecommendation {
  title: string | null;
  recommended_min: number | null;
  est_strain: number | null;
}

/** "Today's Activities" WHOOP coach recommendation cards (issue #4). */
export function coachRecommendations(root: unknown): CoachRecommendation[] {
  return byType(root, "COACH_ACTIVITY_TILE").map((n) => {
    const c = isNode(n.content) ? n.content : {};
    const minutes = str(c.subtitle)?.match(/(\d+)\s*min/i)?.[1];
    return {
      title: str(c.title),
      recommended_min: minutes ? Number(minutes) : null,
      est_strain: displayNumber(c.score_display),
    };
  });
}

export interface KeyStat { now: number | null; avg_30d: number | null; unit?: "min" }

/**
 * KEY_STATISTIC tiles keyed by `trend_key` (HRV, RHR, STEPS, CALORIES, HR_ZONES_1_3…),
 * never by title. Clock values ("0:09") become minutes.
 */
export function keyStats(root: unknown): Record<string, KeyStat> {
  const out: Record<string, KeyStat> = {};
  for (const n of byType(root, "KEY_STATISTIC")) {
    const c = isNode(n.content) ? n.content : null;
    const key = c ? str(c.trend_key) : null;
    if (!c || !key || out[key]) continue;
    const cur = c.current_value_display;
    const clock = typeof cur === "string" && /^\d+:\d{2}$/.test(cur.trim());
    const parse = clock ? displayMinutes : displayNumber;
    const stat: KeyStat = { now: parse(cur), avg_30d: parse(c.thirty_day_value_display) };
    if (clock) stat.unit = "min";
    out[key] = stat;
  }
  return out;
}

export interface Gauge { score: number | null; style: string | null }

/** SCORE_GAUGE_STICKY gauges: SLEEP_GAUGE_STICKY, RECOVERY_GAUGE_STICKY, STRAIN_GAUGE_STICKY. */
export function stickyGauge(home: unknown, id: string): Gauge {
  const g = findFirst(home, (n) => n.id === id && "score_display" in n);
  return { score: g ? parseNumber(g.score_display) : null, style: g ? str(g.progress_fill_style) : null };
}

export function recoveryStateFromStyle(style: string | null): "GREEN" | "YELLOW" | "RED" | null {
  if (style === "RECOVERY_HIGH") return "GREEN";
  if (style === "RECOVERY_MEDIUM") return "YELLOW";
  if (style === "RECOVERY_LOW") return "RED";
  return null;
}

export interface HomeCycle {
  /** Informational only: WHOOP re-cuts cycles when sleeps are written. Never cache or reuse it. */
  id: number | null;
  start: string | null;
  end: string | null;
  sleep_state: string | null;
  day_state: string | null;
  calibrating: boolean;
}

const unusual = (v: string | null, normal: string): string | null => (v === normal ? null : v);

export function homeCycle(home: unknown): HomeCycle {
  const meta = get(home, "metadata", "cycle_metadata");
  const id = get(meta, "cycle_id");
  return {
    id: typeof id === "number" && id > 0 ? id : null,
    start: isoInstant(get(meta, "during", "lower_endpoint")),
    end: isoInstant(get(meta, "during", "upper_endpoint")),
    // Only the unusual states are worth tokens: sleep "incomplete"/"pending", day ADD_SLEEP/PENDING.
    sleep_state: unusual(str(get(meta, "sleep_state")), "complete"),
    day_state: unusual(str(get(home, "metadata", "journal_metadata", "display_cycle_state")), "NORMAL"),
    // The recovery gauge's fill style. (CALIBRATION_TIMELINE counts 7 nights for
    // the health monitor and can outlive recovery's 4-night calibration.)
    calibrating: stickyGauge(home, "RECOVERY_GAUGE_STICKY").style === "CALIBRATING",
  };
}

/**
 * whoop_live_metadata.calories: the fallback when the CALORIES key stat is missing.
 * WHOOP sends 0 here for a day with no data (it sends 0 for every field), so 0 is
 * "nothing recorded", never a measured day.
 */
export function liveCalories(home: unknown): number | null {
  const v = get(home, "metadata", "whoop_live_metadata", "calories");
  return typeof v === "number" && v > 0 ? v : null;
}

export const kinds = (tiles: ActivityTile[], kind: ActivityKind): ActivityTile[] => tiles.filter((t) => t.type === kind);
