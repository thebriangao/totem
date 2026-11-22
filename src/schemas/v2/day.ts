import { z } from "zod";
import {
  ActivityRowOut, CoachRecommendationOut, CycleOut, InstantOrNull, IntOrNull, IsoDate, KeyStatOut, NumOrNull,
  RecoveryStateOut, SleepNeedOut, StageMapOut, StrOrNull,
} from "./core_common.js";

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
    cardio: z.array(ActivityRowOut),
    recovery: z.array(ActivityRowOut),
    sleep: z.array(ActivityRowOut),
  }).optional(),
  workouts_count: z.number().int(),
  recommendations: z.array(CoachRecommendationOut),
  sleep_plan: SleepNeedOut.nullable().optional(),
  now: z.object({ state: z.string(), sport: StrOrNull, since: InstantOrNull }).nullable(),
});
export type DayOutT = z.infer<typeof DayOut>;
