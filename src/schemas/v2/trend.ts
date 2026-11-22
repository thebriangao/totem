import { z } from "zod";
import { IsoDate, NumOrNull, StrOrNull } from "./core_common.js";

/**
 * whoop_trend metric enum (SPEC.md §5.2): v1's list plus HR_ZONES_ALL and
 * RESTORATIVE_SLEEP_PERCENT. TOTAL_VOLUME_LOAD stays out (WHOOP 500s on it).
 */
export const TREND_METRICS = [
  "RECOVERY", "HRV", "RHR", "RESPIRATORY_RATE",
  "DAY_STRAIN", "CALORIES", "STEPS", "AVERAGE_HR", "HR_ZONES_1_3", "HR_ZONES_4_5", "HR_ZONES_ALL",
  "STRENGTH_ACTIVITY_TIME", "VO2_MAX",
  "SLEEP_PERFORMANCE", "TIME_IN_BED", "HOURS_V_NEED", "HOURS_V_NEEDED_PERCENT", "SLEEP_CONSISTENCY",
  "SLEEP_EFFICIENCY", "RESTORATIVE_SLEEP", "RESTORATIVE_SLEEP_PERCENT", "SLEEP_DEBT_POST",
  "STRESS", "STRESS_DURING_SLEEP", "STRESS_DURING_NON_STRAIN", "BODY_COMPOSITION", "WEIGHT",
] as const;

const Row = z.object({
  key: StrOrNull,
  avg: NumOrNull,
  prev_avg: NumOrNull,
  change_pct: NumOrNull,
  direction: StrOrNull,
  unit: StrOrNull,
  per: z.literal("week").optional(),
});

const Window = z.object({
  start: IsoDate,
  end: IsoDate,
  hidden: z.boolean(),
  rows: z.array(Row),
  breakdown: z.array(z.tuple([z.string(), NumOrNull])).nullable(),
  points: z.object({ start: IsoDate, step: z.literal("day"), values: z.array(NumOrNull) }).optional(),
});

export const TrendV2Out = z.object({
  window: z.enum(["week", "month", "six_month"]),
  metrics: z.array(z.object({
    metric: z.enum(TREND_METRICS),
    a: Window.nullable(),
    b: Window.nullable().optional(),
    delta: z.array(z.object({ key: StrOrNull, diff: NumOrNull, diff_pct: NumOrNull })).optional(),
    error: z.string().optional(),
  })),
});
