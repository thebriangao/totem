import type { TodayOutT } from "../schemas/today.js";
import { findByType, isObject, asArray, asNumber, asString } from "../lib/walk.js";
import { stateFromStyle } from "./recovery.js";
import { projectSleep } from "./sleep.js";

// Whoop's home payload's authoritative score source is SCORE_GAUGE_STICKY which
// contains a gauges[] array with one entry per pillar (SLEEP, RECOVERY, STRAIN).
// Each gauge has score_display (string), score_display_suffix, progress_fill_style.
// Sleep stages + start/end come from a separate deep-dive/sleep/last-night call.
// Activity state comes from /activities-service/v1/user-state.

interface ProjectTodayInput {
  home: unknown;
  sleep: unknown;
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

export function projectToday(input: ProjectTodayInput): TodayOutT {
  const { home, sleep, state, date } = input;
  const sticky = findByType(home, "SCORE_GAUGE_STICKY");
  const stickyContent = sticky && isObject(sticky.content) ? (sticky.content as Record<string, unknown>) : {};
  const gauges = asArray(stickyContent.gauges);

  const recoveryGauge = gauge(gauges, "RECOVERY");
  const sleepGauge = gauge(gauges, "SLEEP");
  const strainGauge = gauge(gauges, "STRAIN");

  const recoveryStyle = recoveryGauge ? asString(recoveryGauge.progress_fill_style) : null;

  // Count workouts: ACTIVITY tiles in home (excludes the navigation tiles by checking for content)
  let workoutsCount = 0;
  function countWorkouts(n: unknown): void {
    if (Array.isArray(n)) {
      for (const x of n) countWorkouts(x);
      return;
    }
    if (!isObject(n)) return;
    if (n.type === "ACTIVITY") {
      const c = isObject(n.content) ? (n.content as Record<string, unknown>) : null;
      if (c && asString(c.title)) workoutsCount++;
    }
    for (const v of Object.values(n)) countWorkouts(v);
  }
  countWorkouts(home);

  // Sleep details from /deep-dive/sleep/last-night
  const sleepProjected = sleep ? projectSleep(sleep, date) : null;

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
      hrv_ms: null,
      rhr_bpm: null,
    },
    sleep: {
      performance_pct: gaugeScore(sleepGauge) ?? sleepProjected?.performance_pct ?? null,
      total_sleep_ms: sleepProjected?.total_sleep_ms ?? null,
      time_in_bed_ms: sleepProjected?.time_in_bed_ms ?? null,
      efficiency_pct: sleepProjected?.efficiency_pct ?? null,
      stages: {
        rem_ms: sleepProjected?.stages.rem_ms ?? null,
        light_ms: sleepProjected?.stages.light_ms ?? null,
        sws_ms: sleepProjected?.stages.sws_ms ?? null,
        wake_ms: sleepProjected?.stages.wake_ms ?? null,
      },
      started_at: sleepProjected?.started_at ?? null,
      ended_at: sleepProjected?.ended_at ?? null,
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
