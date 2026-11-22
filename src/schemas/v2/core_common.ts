// Output schema pieces shared by the reads-core v2 tools. Durations are minutes.
import { z } from "zod";
import { IsoDateTime } from "../primitives.js";

export const NumOrNull = z.number().nullable();
export const IntOrNull = z.number().int().nullable();
export const StrOrNull = z.string().nullable();
export const InstantOrNull = IsoDateTime.nullable();
export const IsoDate = z.iso.date();

export const Calibration = z.object({ filled: z.number().int(), total: z.number().int() }).nullable();
export const RecoveryStateOut = z.enum(["GREEN", "YELLOW", "RED"]).nullable();

export const SleepNeedOut = z.object({
  total_min: NumOrNull,
  baseline_min: NumOrNull,
  debt_min: NumOrNull,
  strain_min: NumOrNull,
  naps_min: NumOrNull,
  in_bed_min: z.object({ peak: NumOrNull, perform: NumOrNull, get_by: NumOrNull }),
  smart_alarm_eligible: z.boolean().nullable(),
  alarm_state: StrOrNull,
});

/** Compact activity row: CARDIO carries strain, RECOVERY/SLEEP carry minutes. */
export const ActivityRowOut = z.object({
  id: z.string(),
  name: StrOrNull,
  status: StrOrNull,
  start: InstantOrNull,
  end: InstantOrNull,
  strain: NumOrNull.optional(),
  min: NumOrNull.optional(),
});

export const CycleOut = z.object({
  id: z.number().int().nullable(),
  start: InstantOrNull,
  end: InstantOrNull,
  sleep_state: StrOrNull,
  day_state: StrOrNull,
  calibrating: z.boolean(),
});

export const CoachRecommendationOut = z.object({
  title: StrOrNull,
  recommended_min: NumOrNull,
  est_strain: NumOrNull,
});

export const KeyStatOut = z.object({ now: NumOrNull, avg_30d: NumOrNull, unit: z.literal("min").optional() });

export const StageMapOut = z.object({ awake: NumOrNull, light: NumOrNull, sws: NumOrNull, rem: NumOrNull });

/** A value vs the member's baseline; `trend` is WHOOP's verdict (HIGHER_POSITIVE, LOWER_NEGATIVE…). */
export const VsBaselineOut = z.object({ value: NumOrNull, baseline: NumOrNull, trend: StrOrNull });
