import { z } from "zod";
import { ActivityRowOut, Calibration, IsoDate, NumOrNull, VsBaselineOut } from "./core_common.js";

export const StrainV2Out = z.object({
  date: IsoDate,
  score: NumOrNull,
  calibrating: z.boolean(),
  calibration: Calibration,
  target: z.object({ value: NumOrNull, low: NumOrNull, high: NumOrNull }).nullable(),
  zones_1_3_min: VsBaselineOut,
  zones_4_5_min: VsBaselineOut,
  strength_min: VsBaselineOut,
  steps: VsBaselineOut,
  activities: z.array(ActivityRowOut),
  workouts_count: z.number().int(),
});
