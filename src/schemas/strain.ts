import { z } from "zod";
import { HrZoneDurations } from "./primitives.js";

export const StrainOut = z.object({
  date: z.iso.date(),
  score: z.number().nullable(),
  calories: z.number().int().nullable(),
  avg_hr_bpm: z.number().nullable(),
  max_hr_bpm: z.number().nullable(),
  zone_durations: HrZoneDurations,
  workouts_count: z.number().int(),
  steps: z.number().int().nullable(),
  strength_activity_time_ms: z.number().int().nullable(),
});
export type StrainOutT = z.infer<typeof StrainOut>;
