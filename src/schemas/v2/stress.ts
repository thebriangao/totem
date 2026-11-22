import { z } from "zod";
import { IsoDateTime } from "../primitives.js";
import { Calibration, IsoDate, NumOrNull, StrOrNull } from "./core_common.js";

export const StressV2Out = z.object({
  date: IsoDate,
  state: StrOrNull,
  level: NumOrNull,
  label: StrOrNull,
  min: NumOrNull,
  peak: NumOrNull,
  calibrating: z.boolean(),
  calibration: Calibration,
  band_min: z.object({ low: NumOrNull, medium: NumOrNull, high: NumOrNull }).nullable(),
  timeline: z.object({
    start: IsoDateTime,
    step_min: z.number().int(),
    levels: z.array(NumOrNull),
  }).optional(),
});
