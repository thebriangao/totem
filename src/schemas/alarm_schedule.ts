import { z } from "zod";
import { PreviewOut } from "../lib/health_plans_write.js";

export const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export const WIRE_DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export type Day = typeof DAYS[number];

/** Schedule modes the bff schedule endpoints accept (SPEC.md §4.8). */
export const ALARM_MODES = ["EXACT_TIME", "SLEEP_GOAL", "IN_THE_GREEN", "NO_ALARM"] as const;
export const SLEEP_GOALS = ["PEAK", "PERFORM", "GET_BY"] as const;
/**
 * S1: the ONLY preferences goals totem ever writes. Other values from WHOOP's own
 * enum (ALARM_OFF_*, EXACT_TIME_WEEKLY_PLAN, EXACT_TIME_SLEEP_HOURS, EXACT_TIME_GET_BY)
 * returned 500 and permanently broke the test account's alarm preferences.
 */
export const SAFE_ALARM_GOALS = [
  "EXACT_TIME_PERFORM",
  "EXACT_TIME_PEAK",
  "EXACT_TIME_OPTIMIZE_SLEEP",
  "IN_THE_GREEN",
  "SLEEP_HEALTH_PEAK",
  "SLEEP_HEALTH_PERFORM",
  "SLEEP_HEALTH_GET_BY",
] as const;

export const AlarmSchedule = z.object({
  id: z.string(),
  days: z.array(z.enum(DAYS)),
  /** Derived from the stored goal; null for a goal that isn't a schedule mode (see goal). */
  mode: z.enum(ALARM_MODES).nullable(),
  sleep_goal: z.enum(SLEEP_GOALS).nullable(),
  /** The raw stored goal, only when it doesn't map to a mode. */
  goal: z.string().nullable(),
  wake: z.string(),
  enabled: z.boolean(),
});
export type AlarmScheduleT = z.infer<typeof AlarmSchedule>;

export const NextAlarm = z.object({
  date: z.iso.date().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  goal: z.string().nullable(),
  enabled: z.boolean().nullable(),
});

export const SmartAlarmOut = z.object({
  master_switch: z.union([z.boolean(), z.literal("unavailable")]),
  schedules: z.array(AlarmSchedule),
  unscheduled: z.array(z.enum(DAYS)),
  next_alarm: z.union([NextAlarm, z.literal("unavailable")]),
  note: z.string().nullable(),
});

export const SmartAlarmSetReceipt = z.object({
  action: z.enum(["create", "edit", "delete", "enable", "disable", "single_alarm"]),
  schedule_id: z.string().nullable(),
  verified: z.boolean(),
  no_change: z.boolean(),
  schedules: z.array(AlarmSchedule),
  master_switch: z.union([z.boolean(), z.literal("unavailable")]),
  next_alarm: z.union([NextAlarm, z.literal("unavailable")]).nullable(),
  warnings: z.array(z.string()),
});

export const SmartAlarmSetOut = z.union([PreviewOut, SmartAlarmSetReceipt]);
