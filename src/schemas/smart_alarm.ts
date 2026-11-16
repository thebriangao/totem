import { z } from "zod";
import { IsoDateTime, withPreview } from "./primitives.js";

export const DayOfWeek = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

export const AlarmMode = z.enum(["IN_THE_GREEN", "EXACT_TIME", "SLEEP_GOAL", "NO_ALARM"]);

export const SmartAlarmOut = z.object({
  enabled: z.boolean(),
  preferences: z.object({
    enabled: z.boolean().nullable(),
    schedule_enabled: z.boolean().nullable(),
    day_of_week: DayOfWeek.nullable(),
    alarm_bounds: z.string().nullable(),
    lower_time_bound: z.string().nullable(),
    upper_time_bound: z.string().nullable(),
    goal: z.string().nullable(),
    weekly_plan_goal_minutes: z.number().int().nullable(),
    last_triggered_at: IsoDateTime.nullable(),
  }),
  schedules: z.array(z.object({
    schedule_id: z.string(),
    enabled: z.boolean(),
    days_of_week: z.array(DayOfWeek),
    latest_wake_time: z.string(),
    alarm_mode: AlarmMode,
    sleep_goal: z.string().nullable(),
    timezone_offset: z.string(),
  })),
});
export type SmartAlarmOutT = z.infer<typeof SmartAlarmOut>;

export const SmartAlarmSetOut = withPreview(z.object({
  updated: z.boolean(),
  no_change: z.boolean(),
  mode: z.enum(["schedule", "preferences", "master_enable", "master_disable"]),
}));
