// Output schemas for the v2 activity tools: whoop_workouts, whoop_activity_log,
// whoop_activity_edit, whoop_activity_delete. Kept compact: a model reads these.
import { z } from "zod";
import { IsoDateTime, withPreview } from "./primitives.js";

const ScoreType = z.enum(["CARDIO", "RECOVERY", "SLEEP"]);

/** One short row per activity. */
export const ActivityListItem = z.object({
  activity_id: z.string(),
  /** CARDIO | RECOVERY | SLEEP. */
  type: z.string().nullable(),
  internal_name: z.string().nullable(),
  /** Display name, only when it says more than internal_name ("Strength Trainer"). */
  name: z.string().optional(),
  start: IsoDateTime.nullable(),
  end: IsoDateTime.nullable(),
  /** App: COMPLETE | INCOMPLETE | PENDING. Developer list: SCORED. */
  status: z.string().nullable(),
  /** CARDIO only, once scored. */
  strain: z.number().optional(),
});
export type ActivityListItemT = z.infer<typeof ActivityListItem>;

/**
 * The list goes out as columnar rows in this order, so no key is repeated per
 * activity: `min` is the duration in whole minutes, `strain` is CARDIO only.
 */
export const WORKOUT_COLUMNS = ["activity_id", "type", "internal_name", "start", "min", "status", "strain"] as const;
export const WorkoutRow = z.tuple([
  z.string(), z.string().nullable(), z.string().nullable(), IsoDateTime.nullable(), z.number().int().nullable(), z.string().nullable(),
  z.number().nullable(),
]);
export type WorkoutRowT = z.infer<typeof WorkoutRow>;

export const WorkoutsListOut = z.object({
  /** Only present for the opt-in developer list. */
  source: z.literal("developer").optional(),
  start_date: z.string(),
  end_date: z.string(),
  count: z.number().int(),
  truncated: z.literal(true).optional(),
  /** Empty (so dropped) when there are no rows. */
  columns: z.array(z.enum(WORKOUT_COLUMNS)),
  rows: z.array(WorkoutRow),
  /** Display names that say more than the internal_name, stated once: {weightlifting_msk: "Strength Trainer"}. */
  names: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
});
export type WorkoutsListOutT = z.infer<typeof WorkoutsListOut>;

/** HR series, evenly spaced: bpm[i] is at start + i·step_s seconds. */
export const HrSeries = z.object({
  start: IsoDateTime,
  step_s: z.number().int(),
  bpm: z.array(z.number().int()),
});

export const ActivityDetailOut = z.object({
  type: z.string().nullable(),
  internal_name: z.string().nullable(),
  sport_id: z.number().int().nullable(),
  name: z.string().optional(),
  start: IsoDateTime.nullable(),
  end: IsoDateTime.nullable(),
  duration_ms: z.number().int().nullable(),
  /** CARDIO strain; null while unscored ("---"). */
  strain: z.number().nullable(),
  calories: z.number().nullable(),
  avg_hr_bpm: z.number().nullable(),
  max_hr_bpm: z.number().nullable(),
  min_hr_bpm: z.number().optional(),
  /** Minutes in HR zones 0–5. */
  zones_min: z.array(z.number()).nullable(),
  distance_m: z.number().nullable(),
  elevation_gain_m: z.number().optional(),
  msk: z.object({
    total_volume_kg: z.number().nullable(),
    intensity_pct: z.number().nullable(),
  }).optional(),
  /** False while pending even when linking would work (SPEC.md C12). */
  strength_trainer_linkable: z.boolean().nullable(),
  hr: HrSeries.optional(),
  warnings: z.array(z.string()),
});
export type ActivityDetailOutT = z.infer<typeof ActivityDetailOut>;

const ActivityWindow = z.object({
  type: z.string().nullable(),
  score_type: ScoreType.nullable(),
  start: IsoDateTime.nullable(),
  end: IsoDateTime.nullable(),
});

export const ActivityLogReceipt = z.object({
  created: z.literal(true),
  activity_id: z.string(),
  type: z.string().nullable(),
  score_type: ScoreType.nullable(),
  start: IsoDateTime.nullable(),
  end: IsoDateTime.nullable(),
  version: z.number().int().nullable(),
  strength_trainer_linkable: z.boolean().nullable(),
  /** Informational only: WHOOP re-cuts cycles on sleep writes. Never reuse it. */
  cycle_id_informational: z.number().int().nullable(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
});
export const ActivityLogOut = withPreview(ActivityLogReceipt);

export const ActivityEditReceipt = z.object({
  edited: z.boolean(),
  no_change: z.literal(true).optional(),
  activity_id: z.string(),
  before: ActivityWindow,
  after: ActivityWindow.extend({ version: z.number().int().nullable() }),
  repaired: z.literal(true).optional(),
  deleted_overlapping: z.array(z.string()),
  verified: z.boolean(),
  warnings: z.array(z.string()),
});
export const ActivityEditOut = withPreview(ActivityEditReceipt);

export const ActivityDeleteReceipt = z.object({
  /** True only once a fresh read 404s. */
  deleted: z.boolean(),
  type: z.string().nullable(),
  score_type: ScoreType.nullable(),
  start: IsoDateTime.nullable(),
  end: IsoDateTime.nullable(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
});
export const ActivityDeleteOut = withPreview(ActivityDeleteReceipt);
