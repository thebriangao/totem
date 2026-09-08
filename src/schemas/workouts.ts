import { z } from "zod";
import { HrZoneDurations, IsoDateTime, withPreview } from "./primitives.js";

export const WorkoutListOut = z.array(z.object({
  id: z.string(),
  sport_name: z.string(),
  start: IsoDateTime,
  end: IsoDateTime,
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
  start: IsoDateTime.nullable(),
  end: IsoDateTime.nullable(),
  duration_ms: z.number().int().nullable(),
  strain: z.number().nullable(),
  calories: z.number().int().nullable(),
  distance_m: z.number().nullable(),
  avg_hr_bpm: z.number().nullable(),
  max_hr_bpm: z.number().nullable(),
  zone_durations: HrZoneDurations,
  hr_curve: z.array(z.object({
    at: IsoDateTime,
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
  start: IsoDateTime,
  end: IsoDateTime,
  sport_id: z.number().int(),
}));

export const ActivityDeleteOut = withPreview(z.object({
  deleted: z.literal(true),
  activity_id: z.string(),
}));

export const NapCreateOut = withPreview(z.object({
  created: z.literal(true),
  activity_id: z.string(),
  cycle_id: z.number().int(),
  start: IsoDateTime,
  end: IsoDateTime,
  type: z.string(),
  score_state: z.string(),
  // The just-created activity was read back and its type confirmed. A false here
  // means WHOOP returned a 2xx create receipt but the re-read did not show the
  // expected nap/sleep activity — treat it as a failure, not a success.
  verified: z.boolean(),
}));
