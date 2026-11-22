import { z } from "zod";
import { IsoDateTime } from "../primitives.js";
import { HISTORY_COLUMNS } from "../../projections/v2/history.js";
import {
  ActivityColumnsOut, ActivityRowOut, CoachRecommendationOut, CycleOut, InstantOrNull, IntOrNull, IsoDate, KeyStatOut, NumOrNull,
  RecoveryStateOut, SleepNeedOut, StageMapOut, StrOrNull,
} from "./core_common.js";

/** Heart rate over a window: bpm[i] of a run is at run.start + i·step_s seconds; holes split runs. */
export const HrWindowOut = z.object({
  start: IsoDateTime,
  end: IsoDateTime,
  step_s: z.number().int(),
  n: z.number().int(),
  min: IntOrNull,
  max: IntOrNull,
  avg: IntOrNull,
  runs: z.array(z.object({ start: IsoDateTime, bpm: z.array(z.number().int()) })),
});

/** whoop_day with end_date: one row per cycle day. Columns with no value on any day are left out. */
export const DayRangeOut = z.object({
  start_date: IsoDate,
  end_date: IsoDate,
  count: z.number().int(),
  columns: z.array(z.enum(HISTORY_COLUMNS)),
  rows: z.array(z.array(z.union([z.string(), z.number()]).nullable())),
  /** Days WHOOP is still scoring (today, usually): partial numbers. */
  pending: z.array(IsoDate),
  warnings: z.array(z.string()),
});

export const DayOut = z.object({
  date: IsoDate,
  cycle: CycleOut,
  scores: z.object({
    recovery: NumOrNull,
    recovery_state: RecoveryStateOut,
    hrv_ms: NumOrNull,
    rhr_bpm: NumOrNull,
    sleep_perf: NumOrNull,
    strain: NumOrNull,
  }).optional(),
  key_stats: z.record(z.string(), KeyStatOut).optional(),
  strain: z.object({
    score: NumOrNull.optional(),
    calories: NumOrNull,
    steps: NumOrNull,
    target: NumOrNull,
    zones_1_3_min: NumOrNull,
    zones_4_5_min: NumOrNull,
    strength_min: NumOrNull,
  }).optional(),
  sleep: z.object({
    id: z.string(),
    status: StrOrNull,
    start: InstantOrNull,
    end: InstantOrNull,
    asleep_min: NumOrNull,
    in_bed_min: NumOrNull,
    efficiency_pct: NumOrNull,
    rr: NumOrNull,
    disturbances: IntOrNull,
    stages_min: StageMapOut.nullable(),
    naps: z.number().int(),
  }).nullable().optional(),
  activities: z.object({
    columns: ActivityColumnsOut,
    cardio: z.array(ActivityRowOut),
    recovery: z.array(ActivityRowOut),
    sleep: z.array(ActivityRowOut),
  }).optional(),
  workouts_count: z.number().int(),
  recommendations: z.array(CoachRecommendationOut),
  sleep_plan: SleepNeedOut.nullable().optional(),
  now: z.object({ state: z.string(), sport: StrOrNull, since: InstantOrNull }).nullable(),
  hr: HrWindowOut.optional(),
});
export type DayOutT = z.infer<typeof DayOut>;
