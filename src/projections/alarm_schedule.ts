// Smart Alarm (SPEC.md §4.8; specs/settings.md §2.1–§2.9).
//   GET /smart-alarm-service/v1/alarm-schedule: the source of truth. One row per
//       (user, day_of_week): {schedule_id, day_of_week, upper_time_bound "HH:MM:SS",
//       goal, enabled, deleted}. `schedule_id` only groups rows. It's the only read
//       with the real SLEEP_HEALTH_* goal and it still works on a damaged account.
//   GET /smart-alarm-bff/v1/schedule/all: {schedule_enabled (master switch), …}. Its
//       alarm_mode is lossy (any disabled schedule shows NO_ALARM), so only the switch is used.
//   GET /smart-alarm-service/v1/smartalarm/preferences: the NEXT alarm (tomorrow).
// Reads accept any goal string; unknown goals are passed through, never relabelled.
import { DAYS, WIRE_DAYS, type AlarmScheduleT, type Day } from "../schemas/alarm_schedule.js";
import { parsePgRange } from "../lib/dates.js";

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function shortDay(wire: unknown): Day | null {
  const i = (WIRE_DAYS as readonly unknown[]).indexOf(wire);
  return i >= 0 ? DAYS[i]! : null;
}
export function wireDay(day: Day): typeof WIRE_DAYS[number] {
  return WIRE_DAYS[DAYS.indexOf(day)]!;
}

/** Stored goal → the schedule mode that writes it (SPEC.md §4.8 "Mode → stored goal"). */
export function goalToMode(goal: string | null): Pick<AlarmScheduleT, "mode" | "sleep_goal"> {
  if (!goal) return { mode: null, sleep_goal: null };
  if (goal === "IN_THE_GREEN") return { mode: "IN_THE_GREEN", sleep_goal: null };
  if (/^EXACT_TIME_/.test(goal)) return { mode: "EXACT_TIME", sleep_goal: null };
  const sleep = goal.match(/^SLEEP_HEALTH_(PEAK|PERFORM|GET_BY)$/);
  if (sleep) return { mode: "SLEEP_GOAL", sleep_goal: sleep[1] as "PEAK" | "PERFORM" | "GET_BY" };
  return { mode: null, sleep_goal: null };
}

const hhmm = (t: string | null): string => (t ? t.slice(0, 5) : "");

/**
 * Group per-day rows into schedules. Rows of one schedule_id normally agree; if
 * they don't (a half-applied write), they're kept as separate entries so nothing
 * is hidden.
 */
export function projectAlarmSchedules(raw: unknown): { schedules: AlarmScheduleT[]; unscheduled: Day[] } {
  const rows = (Array.isArray(raw) ? raw : []).filter((r): r is Row => isObj(r) && r.deleted !== true);
  const groups = new Map<string, AlarmScheduleT>();
  for (const r of rows) {
    const id = s(r.schedule_id);
    const day = shortDay(r.day_of_week);
    if (!id || !day) continue;
    const goal = s(r.goal);
    const wake = hhmm(s(r.upper_time_bound));
    const enabled = r.enabled === true;
    const key = `${id}|${goal}|${wake}|${enabled}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.days.includes(day)) existing.days.push(day);
      continue;
    }
    const m = goalToMode(goal);
    groups.set(key, { id, days: [day], mode: m.mode, sleep_goal: m.sleep_goal, goal: m.mode ? null : goal, wake, enabled });
  }
  const out = [...groups.values()];
  for (const x of out) x.days.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
  const used = new Set(out.flatMap((x) => x.days));
  return { schedules: out, unscheduled: DAYS.filter((d) => !used.has(d)) };
}

/** The next alarm from preferences: window date + times from alarm_bounds. */
export function projectNextAlarm(prefs: unknown) {
  const p = isObj(prefs) ? prefs : {};
  let date: string | null = null;
  let from: string | null = s(p.lower_time_bound) ? hhmm(s(p.lower_time_bound)) : null;
  let to: string | null = s(p.upper_time_bound) ? hhmm(s(p.upper_time_bound)) : null;
  const bounds = s(p.alarm_bounds);
  if (bounds) {
    try {
      const r = parsePgRange(bounds);
      date = r.start.slice(0, 10);
      from = r.start.slice(11, 16);
      if (r.end) to = r.end.slice(11, 16);
    } catch {
      // keep the time bounds
    }
  }
  return {
    date,
    from,
    to,
    goal: s(p.goal),
    enabled: typeof p.enabled === "boolean" ? p.enabled : null,
  };
}

/** Master (recurring schedule) switch: schedule/all first, preferences second. */
export function masterSwitch(all: unknown, prefs: unknown): boolean | "unavailable" {
  if (isObj(all) && typeof all.schedule_enabled === "boolean") return all.schedule_enabled;
  if (isObj(prefs) && typeof prefs.schedule_enabled === "boolean") return prefs.schedule_enabled;
  return "unavailable";
}
