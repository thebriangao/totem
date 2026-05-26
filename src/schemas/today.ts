import { z } from "zod";

export const TodayOut = z.object({
  date: z.iso.date(),
  recovery: z.object({
    score: z.number().nullable(),
    state: z.enum(["GREEN", "YELLOW", "RED"]).nullable(),
    hrv_ms: z.number().nullable(),
    rhr_bpm: z.number().nullable(),
  }),
  sleep: z.object({
    performance_pct: z.number().nullable(),
    total_sleep_ms: z.number().int().nullable(),
    time_in_bed_ms: z.number().int().nullable(),
    efficiency_pct: z.number().nullable(),
    stages: z.object({
      rem_ms: z.number().int().nullable(),
      light_ms: z.number().int().nullable(),
      sws_ms: z.number().int().nullable(),
      wake_ms: z.number().int().nullable(),
    }),
    started_at: z.iso.datetime({ offset: true }).nullable(),
    ended_at: z.iso.datetime({ offset: true }).nullable(),
  }),
  strain: z.object({
    score: z.number().nullable(),
    calories: z.number().int().nullable(),
    avg_hr_bpm: z.number().nullable(),
    max_hr_bpm: z.number().nullable(),
    workouts_count: z.number().int(),
  }),
  current_state: z.object({
    state: z.enum(["workout", "sleep", "idle", "recovery"]).nullable(),
    sport_name: z.string().nullable(),
    started_at: z.iso.datetime({ offset: true }).nullable(),
  }),
});
export type TodayOutT = z.infer<typeof TodayOut>;
