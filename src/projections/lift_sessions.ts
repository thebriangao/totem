// whoop_lift_sessions projections. Sessions are found the way the app finds them
// (SPEC.md D1): ACTIVITY items on GET /home-service/v1/home?date= (every sport,
// pending included), then GET /core-details-bff/v1/cardio-details?activityId= per
// activity. A session is any activity whose details carry exercise cards (PR #41's
// hasLiftData, @chaotix345: lifts can sit on any sport). Unscored sessions have
// `weightlifting_cardio_details: null`; their sets come from exercise_history.
import { get, parseNumber, str, walk, type Node } from "../whoop/bff.js";
import type { LiftSessionOutT, SessionExerciseOutT } from "../schemas/strength_v2.js";
import { clockSeconds, medal, weightUnit, type LiftCard, type MedalT } from "./lift_cards.js";

export interface HomeActivity {
  activity_id: string;
  internal_name: string | null;
  type: string | null;
  status: string | null;
  score_display: string | null;
  start: string | null;
  end: string | null;
  date: string;
}

/** One set as parsed, before compacting. */
export interface ParsedSet {
  weight: number | null;
  reps: number | null;
  time_seconds: number | null;
  pct_1rm: number | null;
  avg_hr: number | null;
  medal: MedalT | null;
}

export interface ParsedExercise {
  id: string;
  name: string | null;
  timed: boolean;
  sets: ParsedSet[];
  volume: number | null;
  medals: MedalT[];
}

export interface ParsedSession {
  exercises: ParsedExercise[];
  volume: number | null;
  unit: "kg" | "lb" | null;
}

/** WHOOP's "+0000" offsets → canonical ISO with milliseconds; null if unparseable. */
export function isoTimestamp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Every activity tile on a home screen (keyed on `activity_v2_id`, never on position). */
export function homeActivities(raw: unknown, date: string): HomeActivity[] {
  const seen = new Set<string>();
  const out: HomeActivity[] = [];
  for (const n of walk(raw)) {
    const id = n.activity_v2_id;
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    out.push({
      activity_id: id,
      internal_name: str(n.internal_name),
      type: str(n.type),
      status: str(n.status),
      score_display: str(n.score_display),
      start: isoTimestamp(get(n, "during", "lower_endpoint")),
      end: isoTimestamp(get(n, "during", "upper_endpoint")),
      date,
    });
  }
  return out;
}

function liftBlock(detail: unknown): Node | null {
  const w = get(detail, "weightlifting_cardio_details", "weightlifting_exercises");
  return typeof w === "object" && w !== null ? (w as Node) : null;
}

/** True when cardio-details carry Strength Trainer exercise cards, whatever the sport. */
export function hasLiftData(detail: unknown): boolean {
  const w = liftBlock(detail);
  if (!w) return false;
  const carousel = get(w, "exercise_summary_carousel", "items");
  const groups = get(w, "exercise_summary", "exercise_card_groups");
  const hasId = (xs: unknown) => Array.isArray(xs) && xs.some((x) => typeof get(x, "exercise_id") === "string");
  return hasId(carousel) || (Array.isArray(groups) && groups.some((g) => hasId(get(g, "cards"))));
}

function displayInt(v: unknown): number | null {
  const n = parseNumber(v);
  return n === null ? null : Math.round(n);
}

const medalsOf = (sets: ParsedSet[]): MedalT[] => sets.map((s) => s.medal).filter((m): m is MedalT => m !== null);

/** Scored session: per-set stat_rows from cardio-details (carousel totals as a fallback). */
export function parseCardioDetails(detail: unknown): ParsedSession {
  const w = liftBlock(detail);
  if (!w) return { exercises: [], volume: null, unit: null };
  const unit = weightUnit(w.tonnage_units_display);
  const groups = (get(w, "exercise_summary", "exercise_card_groups") ?? []) as unknown[];
  const cards = groups.flatMap((g) => (get(g, "cards") ?? []) as unknown[]).filter((c) => typeof get(c, "exercise_id") === "string");
  let exercises: ParsedExercise[];
  if (cards.length > 0) {
    exercises = cards.map((c) => {
      const timed = String(get(c, "volume_title_display") ?? "").toUpperCase() === "TIME";
      const sets = ((get(c, "stat_rows") ?? []) as unknown[]).map((r): ParsedSet => ({
        weight: parseNumber(get(r, "weight_display")),
        reps: timed ? null : displayInt(get(r, "volume_display")),
        time_seconds: timed ? clockSeconds(get(r, "volume_display")) : null,
        pct_1rm: parseNumber(get(r, "intensity_display")),
        avg_hr: displayInt(get(r, "avg_hr_display")),
        medal: medal(get(r, "achievement_icon")),
      }));
      return { id: get(c, "exercise_id") as string, name: str(get(c, "title_display")), timed, sets, volume: parseNumber(get(c, "bottom_stats", "tonnage_display")), medals: medalsOf(sets) };
    });
  } else {
    const items = ((get(w, "exercise_summary_carousel", "items") ?? []) as unknown[]).filter((it) => typeof get(it, "exercise_id") === "string");
    exercises = items.map((it) => {
      const icons = get(it, "achievement_icons");
      return {
        id: get(it, "exercise_id") as string,
        name: str(get(it, "title_display")),
        timed: /TIME/i.test(String(get(it, "volume_title_display") ?? "")),
        sets: [],
        volume: parseNumber(get(it, "tonnage_display")),
        medals: (Array.isArray(icons) ? icons : []).map(medal).filter((m): m is MedalT => m !== null),
      };
    });
  }
  const volume = parseNumber(get(w, "exercise_summary", "tonnage_display")) ?? parseNumber(get(w, "exercise_summary_carousel", "items", 0, "tonnage_display"));
  return { exercises, volume, unit };
}

/** Unscored session: exercise_history cards that point at it (no HR or %1RM there). */
export function parseHistoryCards(cards: Array<{ exercise_id: string; name: string | null; card: LiftCard }>): ParsedSession {
  let volume: number | null = null;
  let unit: "kg" | "lb" | null = null;
  const exercises = cards.map(({ exercise_id, name, card }): ParsedExercise => {
    const sets = card.sets.map((s): ParsedSet => ({ weight: s.weight, reps: s.reps === null ? null : Math.round(s.reps), time_seconds: s.time_seconds, pct_1rm: null, avg_hr: null, medal: s.medal }));
    if (card.total.volume !== null) volume = (volume ?? 0) + card.total.volume;
    unit = unit ?? card.total.unit ?? card.sets.find((s) => s.unit)?.unit ?? null;
    return { id: exercise_id, name, timed: card.sets.some((s) => s.time_seconds !== null), sets, volume: card.total.volume, medals: medalsOf(sets) };
  });
  return { exercises, volume, unit };
}

/** "3x5" when every set matches, else "5/5/3"; timed sets as seconds ("2x300s"). */
export function setScheme(values: Array<number | null>, suffix = ""): string {
  const vs = values.map((v) => (v === null ? "?" : String(v)));
  if (vs.length === 0) return "0";
  return vs.every((v) => v === vs[0]) ? `${vs.length}x${vs[0]}${suffix}` : vs.map((v) => v + suffix).join("/");
}

const MEDAL_RANK: Record<MedalT, number> = { GOLD: 3, SILVER: 2, BRONZE: 1 };

/** The best medal in a list (GOLD > SILVER > BRONZE). */
export function bestMedal(medals: MedalT[]): MedalT | null {
  return medals.reduce<MedalT | null>((best, m) => (!best || MEDAL_RANK[m] > MEDAL_RANK[best] ? m : best), null);
}

/** Compact one exercise: summary always, per-set rows only when asked. "--" rows (not performed) are dropped. */
export function compactExercise(ex: ParsedExercise, withRows: boolean): SessionExerciseOutT {
  const amount = (s: ParsedSet) => (ex.timed ? s.time_seconds : s.reps);
  const sets = ex.sets.filter((s) => amount(s) !== null || s.weight !== null);
  let top: number[] | null = null;
  if (!ex.timed) {
    for (const s of sets) {
      if (s.weight === null || s.reps === null) continue;
      if (!top || s.weight > top[0]! || (s.weight === top[0] && s.reps > top[1]!)) top = [s.weight, s.reps];
    }
    if (top && top[0] === 0) top = null; // bodyweight: the scheme says it all
  }
  const out: SessionExerciseOutT = {
    id: ex.id,
    sets: sets.length === 0 && ex.sets.length > 0 ? "skipped" : setScheme(sets.map(amount), ex.timed ? "s" : ""),
    top,
    volume: ex.volume,
    medal: bestMedal(ex.medals),
  };
  if (withRows) {
    const extra = sets.some((s) => s.pct_1rm !== null || s.avg_hr !== null);
    out.rows = sets.map((s) => (extra ? [s.weight, amount(s), s.pct_1rm, s.avg_hr] : [s.weight, amount(s)]));
  }
  return out;
}

function strainOf(activity: HomeActivity, detail: unknown): number | null {
  const fromDetail = parseNumber(get(detail, "horizontal_stat", "stat_main_value_display"));
  if (fromDetail !== null) return fromDetail;
  return activity.type === "CARDIO" && activity.score_display && !activity.score_display.includes(":") ? parseNumber(activity.score_display) : null;
}

/** Window and sport from cardio-details, for single-activity reads (no home tile). */
export function activityFromDetail(activityId: string, detail: unknown, fallbackDate: string): HomeActivity {
  const start = isoTimestamp(get(detail, "details_edit_components", "start_time_selector", "initial_time"));
  return {
    activity_id: activityId,
    internal_name: str(get(detail, "details_edit_components", "activity_type_internal_name")),
    type: str(get(detail, "details_edit_components", "single_score_type")),
    status: null,
    score_display: null,
    start,
    end: isoTimestamp(get(detail, "details_edit_components", "end_time_selector", "initial_time")),
    date: start ? start.slice(0, 10) : fallbackDate,
  };
}

export function buildSession(activity: HomeActivity, detail: unknown, parsed: ParsedSession, src: LiftSessionOutT["src"], withRows: boolean): LiftSessionOutT & { _unit: "kg" | "lb" | null } {
  return {
    id: activity.activity_id,
    sport: activity.internal_name ?? str(get(detail, "details_edit_components", "activity_type_internal_name")),
    start: activity.start,
    end: activity.end,
    strain: strainOf(activity, detail),
    src,
    volume: parsed.volume,
    msk_pct: parseNumber(get(detail, "strain_breakdown", "msk_percent_display")),
    unit: null,
    exercises: parsed.exercises.map((e) => compactExercise(e, withRows)),
    _unit: parsed.unit,
  };
}

/** State the weight unit once: the first known unit goes top-level; sessions that differ keep their own. */
export function hoistUnit(sessions: Array<LiftSessionOutT & { _unit: "kg" | "lb" | null }>): { unit: "kg" | "lb" | null; sessions: LiftSessionOutT[] } {
  const unit = sessions.find((s) => s._unit)?._unit ?? null;
  return {
    unit,
    sessions: sessions.map(({ _unit, ...s }) => ({ ...s, unit: _unit && _unit !== unit ? _unit : null })),
  };
}
