// whoop_day (replaces whoop_today, whoop_day, whoop_daily_brief). App-native
// sources only (D1): home?date= for the cycle, scores, key stats, activities and
// coach tiles; the recovery and strain deep dives; the main sleep's
// sleep-details; sleepneed (today, may 500 → null); user-state (today).
import {
  activityColumns, activityRow, activityTiles, coachRecommendations, homeCycle, keyStats, kinds, liveCalories, recoveryStateFromStyle,
  stickyGauge, type ActivityRow, type CoachRecommendation, type HomeCycle, type KeyStat,
} from "./core_home.js";
import { projectRecoveryDeepDive } from "./recovery.js";
import { mainSleepTile, napsFromTiles, projectSleepDetails } from "./sleep.js";
import { projectStrainV2 } from "./strain.js";
import type { SleepNeed } from "./core_sleep_need.js";
import { projectNow } from "./now.js";
import type { HrWindow } from "./heart_rate.js";

export const DAY_SECTIONS = ["scores", "sleep", "strain", "activities", "sleep_plan", "key_stats", "hr"] as const;
export type DaySection = (typeof DAY_SECTIONS)[number];

export interface DayInput {
  date: string;
  isToday: boolean;
  include: ReadonlySet<DaySection>;
  home: unknown;
  recovery?: unknown | undefined;
  strain?: unknown;
  sleepDetails?: unknown;
  /** undefined = not requested; null = requested but unavailable. */
  sleepNeed?: SleepNeed | null | undefined;
  userState?: unknown;
}

type StageMap = { awake: number | null; light: number | null; sws: number | null; rem: number | null };

export interface DayV2 {
  date: string;
  cycle: HomeCycle;
  scores?: {
    recovery: number | null;
    recovery_state: "GREEN" | "YELLOW" | "RED" | null;
    hrv_ms: number | null;
    rhr_bpm: number | null;
    sleep_perf: number | null;
    strain: number | null;
  };
  key_stats?: Record<string, KeyStat>;
  strain?: {
    score?: number | null;
    calories: number | null;
    steps: number | null;
    target: number | null;
    zones_1_3_min: number | null;
    zones_4_5_min: number | null;
    strength_min: number | null;
  };
  sleep?: {
    id: string;
    status: string | null;
    start: string | null;
    end: string | null;
    asleep_min: number | null;
    in_bed_min: number | null;
    efficiency_pct: number | null;
    rr: number | null;
    disturbances: number | null;
    stages_min: StageMap | null;
    naps: number;
  } | null;
  activities?: { columns: ReturnType<typeof activityColumns>; cardio: ActivityRow[]; recovery: ActivityRow[]; sleep: ActivityRow[] };
  /** CARDIO activities only (RECOVERY and SLEEP tiles are listed, not counted). */
  workouts_count: number;
  recommendations: CoachRecommendation[];
  sleep_plan?: SleepNeed | null;
  now: { state: string; sport: string | null; since: string | null } | null;
  /** Filled in by the tool: the series comes from another service than the day itself. */
  hr?: HrWindow;
}

export function projectDay(input: DayInput): DayV2 {
  const { home, include } = input;
  const tiles = activityTiles(home);
  const stats = keyStats(home);
  const cardio = kinds(tiles, "CARDIO");
  const out: DayV2 = {
    date: input.date,
    cycle: homeCycle(home),
    workouts_count: cardio.length,
    recommendations: coachRecommendations(home),
    now: null,
  };
  const strainScore = stickyGauge(home, "STRAIN_GAUGE_STICKY").score;

  if (include.has("scores")) {
    const rec = stickyGauge(home, "RECOVERY_GAUGE_STICKY");
    const dd = input.recovery ? projectRecoveryDeepDive(input.recovery, input.date) : null;
    out.scores = {
      recovery: rec.score,
      recovery_state: recoveryStateFromStyle(rec.style),
      hrv_ms: dd?.hrv_ms.value ?? stats.HRV?.now ?? null,
      rhr_bpm: dd?.rhr_bpm.value ?? stats.RHR?.now ?? null,
      sleep_perf: stickyGauge(home, "SLEEP_GAUGE_STICKY").score,
      strain: strainScore,
    };
  }

  if (include.has("key_stats")) out.key_stats = stats;

  if (include.has("strain")) {
    const s = input.strain ? projectStrainV2(input.strain, input.date) : null;
    out.strain = {
      // Issue #5 item 5: the day's calories are the CALORIES key stat. Fall back to
      // whoop_live_metadata only when the stat isn't on the dashboard at all (a "--"
      // stat means no data; live metadata then reads 0).
      calories: stats.CALORIES ? stats.CALORIES.now : liveCalories(home),
      steps: s?.steps.value ?? stats.STEPS?.now ?? null,
      target: s?.target?.value ?? null,
      zones_1_3_min: s?.zones_1_3_min.value ?? null,
      zones_4_5_min: s?.zones_4_5_min.value ?? null,
      strength_min: s?.strength_min.value ?? null,
    };
    if (!include.has("scores")) out.strain.score = s?.score ?? strainScore;
  }

  if (include.has("sleep")) {
    const main = mainSleepTile(tiles);
    const d = main && input.sleepDetails ? projectSleepDetails(input.sleepDetails, main.id, false) : null;
    out.sleep = main
      ? {
          id: main.id,
          status: main.status,
          start: d?.start ?? main.start,
          end: d?.end ?? main.end,
          asleep_min: d?.asleep_min ?? main.min,
          in_bed_min: d?.in_bed_min ?? null,
          efficiency_pct: d?.efficiency_pct ?? null,
          rr: d?.rr ?? null,
          disturbances: d?.disturbances ?? null,
          stages_min: d?.scored ? d.stages_min : null,
          naps: napsFromTiles(tiles).length,
        }
      : null;
  }

  if (include.has("activities")) {
    // The main sleep is already the `sleep` section when that is included.
    const mainId = include.has("sleep") ? mainSleepTile(tiles)?.id : undefined;
    const rows = {
      cardio: cardio.map(activityRow),
      recovery: kinds(tiles, "RECOVERY").map(activityRow),
      sleep: kinds(tiles, "SLEEP").filter((t) => t.id !== mainId).map(activityRow),
    };
    out.activities = { columns: activityColumns(rows.cardio, rows.recovery, rows.sleep), ...rows };
  }

  if (include.has("sleep_plan")) out.sleep_plan = input.isToday ? input.sleepNeed ?? null : null;

  if (input.isToday && input.userState !== undefined && input.userState !== null) {
    const now = projectNow(input.userState, null, null);
    // "idle since" is noise; the start matters only for an activity in progress.
    out.now = { state: now.state, sport: now.sport_name, since: now.state === "idle" ? null : now.started_at };
  }
  return out;
}
