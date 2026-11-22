import { z } from "zod";
import { IsoDateTime } from "../primitives.js";
import { InstantOrNull, IntOrNull, IsoDate, NumOrNull, SleepNeedOut, StageMapOut, StrOrNull } from "./core_common.js";

export const SleepRecordOut = z.object({
  id: z.string(),
  type: z.enum(["sleep", "nap"]),
  scored: z.boolean(),
  status: StrOrNull,
  start: InstantOrNull,
  end: InstantOrNull,
  perf_pct: NumOrNull,
  hours_vs_needed_pct: NumOrNull,
  consistency_pct: NumOrNull,
  asleep_min: NumOrNull,
  in_bed_min: NumOrNull,
  efficiency_pct: NumOrNull,
  latency_min: NumOrNull,
  rr: NumOrNull,
  wake_per_hr: NumOrNull,
  disturbances: IntOrNull,
  restorative_min: NumOrNull,
  stages_min: StageMapOut,
  stages_pct: StageMapOut,
  hr: z.object({ avg: NumOrNull, min: NumOrNull }),
  hypnogram: z.object({
    start: IsoDateTime,
    runs: z.array(z.tuple([z.string(), z.number()])),
  }).optional(),
  coach_note: StrOrNull,
});

export const SleepV2Out = z.object({
  date: IsoDate.nullable(),
  sleep: SleepRecordOut.nullable(),
  naps: z.array(z.object({
    id: z.string(),
    status: StrOrNull,
    start: InstantOrNull,
    end: InstantOrNull,
    min: NumOrNull,
  })).optional(),
  need: SleepNeedOut.nullable().optional(),
  hr_baseline_bpm: NumOrNull,
});
export type SleepV2OutT = z.infer<typeof SleepV2Out>;
