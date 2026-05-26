import { z } from "zod";
import { withPreview } from "./primitives.js";

export const DayOfWeek = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

export const AlarmMode = z.enum(["IN_THE_GREEN", "EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP"]);

export const SmartAlarmOut = z.object({
  enabled: z.boolean(),
  preferences: z.object({
    lower_time_bound: z.string().nullable(),
    upper_time_bound: z.string().nullable(),
    goal: z.enum(["EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP", "IN_THE_GREEN"]).nullable(),
    weekly_plan_goal_minutes: z.number().int().nullable(),
    last_triggered_at: z.iso.datetime({ offset: true }).nullable(),
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
  updated: z.literal(true),
  mode: z.enum(["schedule", "preferences", "master_enable", "master_disable"]),
}));
