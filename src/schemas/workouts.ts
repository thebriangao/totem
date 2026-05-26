import { z } from "zod";
import { HrZoneDurations, withPreview } from "./primitives.js";

export const WorkoutListOut = z.array(z.object({
  id: z.string(),
  sport_name: z.string(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  duration_ms: z.number().int(),
  strain: z.number().nullable(),
  avg_hr_bpm: z.number().nullable(),
  max_hr_bpm: z.number().nullable(),
  calories: z.number().int().nullable(),
  distance_m: z.number().nullable(),
}));
export type WorkoutListOutT = z.infer<typeof WorkoutListOut>;

export const WorkoutOut = z.object({
  id: z.string(),
  sport_name: z.string().nullable(),
  start: z.iso.datetime({ offset: true }).nullable(),
  end: z.iso.datetime({ offset: true }).nullable(),
  duration_ms: z.number().int().nullable(),
  strain: z.number().nullable(),
  calories: z.number().int().nullable(),
  distance_m: z.number().nullable(),
  avg_hr_bpm: z.number().nullable(),
  max_hr_bpm: z.number().nullable(),
  zone_durations: HrZoneDurations,
  hr_curve: z.array(z.object({
    at: z.iso.datetime({ offset: true }),
    bpm: z.number().int(),
  })),
  msk: z.object({
    total_volume_kg: z.number().nullable(),
    intensity_pct: z.number().nullable(),
    strain_score: z.number().nullable(),
    is_strength_workout: z.boolean(),
  }),
});
export type WorkoutOutT = z.infer<typeof WorkoutOut>;

export const ActivityCreateOut = withPreview(z.object({
  created: z.literal(true),
  activity_id: z.string(),
  cycle_id: z.number().int(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  sport_id: z.number().int(),
}));

export const ActivityDeleteOut = withPreview(z.object({
  deleted: z.literal(true),
  activity_id: z.string(),
}));
