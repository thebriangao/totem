import type { SmartAlarmOutT } from "../schemas/smart_alarm.js";
import { isObject, asArray, asBool, asNumber, asString } from "../lib/walk.js";

// Schedule list from /smart-alarm-bff/v1/schedule/all:
//   alarm_schedule_list[], schedule_enabled
//
// Preferences from /smart-alarm-service/v1/smartalarm/preferences (documented):
//   lower_time_bound, recovery_score_goal, sleep_score_goal, weekly_plan_goal,
//   weekly_plan_sleep_hours_goal_in_minutes, weekly_plan_sleep_hours_goal,
//   weekly_plan_goal_info, alarm_bounds, last_triggered_at, created_at
//
// The UPPER bound + goal mode are nested in alarm_bounds (not at top level).
// The PUT body shape (from captures) is {default, enabled, goal, lower_time_bound,
// schedule_enabled, time_zone_offset, upper_time_bound, weekly_plan_goal} —
// so on GET they're likely inside alarm_bounds: {goal, upper, lower, enabled}.

interface ProjectSmartAlarmInput {
  schedules: unknown;
  preferences: unknown;
}

const VALID_DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
type Day = typeof VALID_DAYS[number];
const VALID_MODES = ["IN_THE_GREEN", "EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP"] as const;
type Mode = typeof VALID_MODES[number];

export function projectSmartAlarm(input: ProjectSmartAlarmInput): SmartAlarmOutT {
  const sched = isObject(input.schedules) ? (input.schedules as Record<string, unknown>) : {};
  const prefs = isObject(input.preferences) ? (input.preferences as Record<string, unknown>) : {};
  const bounds = isObject(prefs.alarm_bounds) ? (prefs.alarm_bounds as Record<string, unknown>) : {};

  const list = asArray(sched.alarm_schedule_list)
    .map((s) => {
      if (!isObject(s)) return null;
      const days = asArray(s.day_of_week_list)
        .filter((d): d is string => typeof d === "string")
        .filter((d): d is Day => (VALID_DAYS as readonly string[]).includes(d));
      const mode = asString(s.alarm_mode);
      return {
        schedule_id: asString(s.schedule_id ?? s.id) ?? "",
        enabled: asBool(s.enabled) ?? false,
        days_of_week: days,
        latest_wake_time: asString(s.latest_wake_time) ?? "",
        alarm_mode: ((VALID_MODES as readonly string[]).includes(mode ?? "") ? mode : "IN_THE_GREEN") as Mode,
        sleep_goal: asString(s.sleep_goal),
        timezone_offset: asString(s.time_zone_offset) ?? "",
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // goal + upper_time_bound: try alarm_bounds first, fall back to top-level
  const goal = asString(bounds.goal) ?? asString(prefs.goal);
  const upperTimeBound = asString(bounds.upper) ?? asString(prefs.upper_time_bound);
  const lowerTimeBound = asString(prefs.lower_time_bound) ?? asString(bounds.lower);

  return {
    enabled: asBool(sched.schedule_enabled) ?? asBool(prefs.schedule_enabled) ?? false,
    preferences: {
      lower_time_bound: lowerTimeBound,
      upper_time_bound: upperTimeBound,
      goal: (VALID_MODES as readonly string[]).includes(goal ?? "")
        ? (goal as Mode)
        : null,
      weekly_plan_goal_minutes:
        asNumber(prefs.weekly_plan_sleep_hours_goal_in_minutes) ?? asNumber(prefs.weekly_plan_goal),
      last_triggered_at: asString(prefs.last_triggered_at),
    },
    schedules: list,
  };
}
