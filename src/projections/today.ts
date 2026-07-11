import type { TodayOutT } from "../schemas/today.js";
import { findByType, isObject, asArray, asNumber, asString } from "../lib/walk.js";
import { projectRecovery, stateFromStyle } from "./recovery.js";

// Whoop's home payload's authoritative score source is SCORE_GAUGE_STICKY which
// contains a gauges[] array with one entry per pillar (SLEEP, RECOVERY, STRAIN).
// Each gauge has score_display (string), score_display_suffix, progress_fill_style.
// Sleep stages + start/end come from the lightweight /developer/v2/activity/sleep
// endpoint (~1 KB), NOT the 848 KB deep-dive — the full per-minute hypnogram is
// whoop_sleep's job. Activity state comes from /activities-service/v1/user-state.

interface ProjectTodayInput {
  home: unknown;
  sleep: unknown;
  recovery: unknown;
  state: unknown;
  date: string;
}

function gauge(gauges: unknown[], title: string): Record<string, unknown> | null {
  return (gauges.find(
    (g) => isObject(g) && asString((g as Record<string, unknown>).title) === title,
  ) as Record<string, unknown> | undefined) ?? null;
}

function gaugeScore(g: Record<string, unknown> | null): number | null {
  if (!g) return null;
  return asNumber(g.score_display);
}

interface SleepSummary {
  performance_pct: number | null;
  total_sleep_ms: number | null;
  time_in_bed_ms: number | null;
  efficiency_pct: number | null;
  stages: { rem_ms: number | null; light_ms: number | null; sws_ms: number | null; wake_ms: number | null };
  started_at: string | null;
  ended_at: string | null;
}

// Map a /developer/v2/activity/sleep response → the snapshot's sleep summary.
// Picks the main (non-nap) sleep whose local end date matches `date`, else the
// most recent. All stage durations come straight from score.stage_summary.
function sleepSummary(resp: unknown, date: string): SleepSummary | null {
  const root = isObject(resp) ? resp : {};
  const records = asArray(root.records).filter(
    (r): r is Record<string, unknown> => isObject(r) && r.nap !== true,
  );
  const pick = records.find((r) => asString(r.end)?.slice(0, 10) === date) ?? records[0];
  if (!pick) return null;
  const score = isObject(pick.score) ? (pick.score as Record<string, unknown>) : {};
  const st = isObject(score.stage_summary) ? (score.stage_summary as Record<string, unknown>) : {};
  const rem = asNumber(st.total_rem_sleep_time_milli);
  const light = asNumber(st.total_light_sleep_time_milli);
  const sws = asNumber(st.total_slow_wave_sleep_time_milli);
  const wake = asNumber(st.total_awake_time_milli);
  const inBed = asNumber(st.total_in_bed_time_milli);
  const noData = asNumber(st.total_no_data_time_milli) ?? 0;
  const totalSleep =
    rem !== null && light !== null && sws !== null
      ? rem + light + sws
      : inBed !== null && wake !== null
        ? inBed - wake - noData
        : null;
  const eff = asNumber(score.sleep_efficiency_percentage);
  return {
    performance_pct: asNumber(score.sleep_performance_percentage),
    total_sleep_ms: totalSleep,
    time_in_bed_ms: inBed,
    efficiency_pct: eff === null ? null : Math.round(eff),
    stages: { rem_ms: rem, light_ms: light, sws_ms: sws, wake_ms: wake },
    started_at: asString(pick.start),
    ended_at: asString(pick.end),
  };
}

// HRV + RHR come from the date-aligned deep-dive recovery payload via
// projectRecovery (the same source whoop_recovery uses). The previous approach
// matched /developer/v2/recovery records by created_at.slice(0,10), which is
// off-by-one because created_at is UTC: on a historical lookup it returned the
// adjacent day HRV/RHR.

export function projectToday(input: ProjectTodayInput): TodayOutT {
  const { home, sleep, recovery, state, date } = input;
  const sticky = findByType(home, "SCORE_GAUGE_STICKY");
  const stickyContent = sticky && isObject(sticky.content) ? (sticky.content as Record<string, unknown>) : {};
  const gauges = asArray(stickyContent.gauges);

  const recoveryGauge = gauge(gauges, "RECOVERY");
  const sleepGauge = gauge(gauges, "SLEEP");
  const strainGauge = gauge(gauges, "STRAIN");

  const recoveryStyle = recoveryGauge ? asString(recoveryGauge.progress_fill_style) : null;

  // Count workouts: ACTIVITY tiles in home with real content. Whoop lists the
  // nightly SLEEP as an ACTIVITY tile too (content.type === "SLEEP"); exclude it
  // so the count reflects true exercises only. Dedupe by activity id in case a
  // tile is referenced from more than one section.
  const workoutIds = new Set<string>();
  function countWorkouts(n: unknown): void {
    if (Array.isArray(n)) {
      for (const x of n) countWorkouts(x);
      return;
    }
    if (!isObject(n)) return;
    if (n.type === "ACTIVITY") {
      const c = isObject(n.content) ? (n.content as Record<string, unknown>) : null;
      const title = c ? asString(c.title) : null;
      const innerType = c ? asString(c.type) : null;
      if (c && title && innerType?.toUpperCase() !== "SLEEP") {
        const id = asString(c.activity_v2_id) ?? `${title}|${asString(c.start_time_text) ?? ""}`;
        workoutIds.add(id);
      }
    }
    for (const v of Object.values(n)) countWorkouts(v);
  }
  countWorkouts(home);
  const workoutsCount = workoutIds.size;

  // Sleep summary from the lightweight /developer/v2/activity/sleep endpoint
  const sleepSum = sleep ? sleepSummary(sleep, date) : null;
  const recProj = recovery ? projectRecovery(recovery, date) : null;

  // Activity state
  const stateObj = isObject(state) ? state : {};
  const activityObj = isObject(stateObj.activity) ? (stateObj.activity as Record<string, unknown>) : null;
  const rawState = asString(stateObj.state)?.toLowerCase() ?? null;
  const KNOWN_STATES = ["workout", "sleep", "idle", "recovery"] as const;
  const stateValue = rawState && (KNOWN_STATES as readonly string[]).includes(rawState)
    ? (rawState as typeof KNOWN_STATES[number])
    : null;

  return {
    date,
    recovery: {
      score: gaugeScore(recoveryGauge),
      state: stateFromStyle(recoveryStyle),
      hrv_ms: recProj?.hrv.ms ?? null,
      rhr_bpm: recProj?.rhr.bpm ?? null,
    },
    sleep: {
      performance_pct: gaugeScore(sleepGauge) ?? sleepSum?.performance_pct ?? null,
      total_sleep_ms: sleepSum?.total_sleep_ms ?? null,
      time_in_bed_ms: sleepSum?.time_in_bed_ms ?? null,
      efficiency_pct: sleepSum?.efficiency_pct ?? null,
      stages: {
        rem_ms: sleepSum?.stages.rem_ms ?? null,
        light_ms: sleepSum?.stages.light_ms ?? null,
        sws_ms: sleepSum?.stages.sws_ms ?? null,
        wake_ms: sleepSum?.stages.wake_ms ?? null,
      },
      started_at: sleepSum?.started_at ?? null,
      ended_at: sleepSum?.ended_at ?? null,
    },
    strain: {
      score: gaugeScore(strainGauge),
      calories: null,
      avg_hr_bpm: null,
      max_hr_bpm: null,
      workouts_count: workoutsCount,
    },
    current_state: {
      state: stateValue,
      sport_name: activityObj ? asString(activityObj.sport_name) : null,
      started_at: asString(stateObj.startAt),
    },
  };
}
