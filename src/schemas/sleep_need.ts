import { z } from "zod";

export const SleepNeedOut = z.object({
  recommended_time_in_bed: z.string().nullable(),
  recommended_time_in_bed_minutes: z.number().int().nullable(),
  need_breakdown: z.object({
    baseline_minutes: z.number().int().nullable(),
    debt_minutes: z.number().int().nullable(),
    strain_minutes: z.number().int().nullable(),
    nap_credit_minutes: z.number().int().nullable(),
  }),
  next_schedule_day: z.string().nullable(),
  smart_alarm_eligible: z.boolean(),
  schedule_state: z.string().nullable(),
});
export type SleepNeedOutT = z.infer<typeof SleepNeedOut>;
