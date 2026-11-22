import { z } from "zod";
import { Calibration, IntOrNull, IsoDate, NumOrNull, RecoveryStateOut, StrOrNull, VsBaselineOut } from "./core_common.js";

const Window = z.object({ start: IsoDate, end: IsoDate }).nullable();

export const AssessmentOut = z.object({
  needed: z.boolean().nullable(),
  has_assessment: z.boolean().nullable(),
  recoveries: IntOrNull,
  required: IntOrNull,
  expected: Window,
  next: Window,
});

export const RecoveryV2Out = z.object({
  date: IsoDate,
  score: NumOrNull,
  state: RecoveryStateOut,
  calibrating: z.boolean(),
  calibration: Calibration,
  hrv_ms: VsBaselineOut,
  rhr_bpm: VsBaselineOut,
  rr: VsBaselineOut,
  sleep_perf_pct: VsBaselineOut,
  monitor: z.object({
    spo2_pct: NumOrNull,
    skin_temp_dev_f: NumOrNull,
    rr: NumOrNull,
    rhr_bpm: NumOrNull,
    hrv_ms: NumOrNull,
    status: z.record(z.string(), z.string()),
    in_range: IntOrNull,
    with_values: IntOrNull,
    note: StrOrNull,
  }).nullable(),
  assessment: z.object({ week: AssessmentOut.nullable(), month: AssessmentOut.nullable() }).optional(),
});
export type RecoveryV2OutT = z.infer<typeof RecoveryV2Out>;
