import { z } from "zod";

export const METRICS = [
  "HRV",
  "RHR",
  "RECOVERY",
  "DAY_STRAIN",
  "CALORIES",
  "STEPS",
  "AVERAGE_HR",
  "HOURS_V_NEED",
  "HOURS_V_NEEDED_PERCENT",
  "TIME_IN_BED",
  "SLEEP_PERFORMANCE",
  "SLEEP_EFFICIENCY",
  "SLEEP_CONSISTENCY",
  "SLEEP_DEBT_POST",
  "RESTORATIVE_SLEEP",
  "HR_ZONES_1_3",
  "HR_ZONES_4_5",
  "RESPIRATORY_RATE",
  "STRENGTH_ACTIVITY_TIME",
  "STRESS",
  "STRESS_DURING_SLEEP",
  "STRESS_DURING_NON_STRAIN",
  "VO2_MAX",
  "BODY_COMPOSITION",
  "WEIGHT",
] as const;

export const TrendMetric = z.enum(METRICS);

export const TrendOut = z.object({
  metric: TrendMetric,
  end_date: z.iso.date(),
  segments: z.array(z.object({
    label: z.enum(["week", "month", "six_month", "year"]),
    start_date: z.string(),
    end_date: z.string(),
    avg: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    delta_pct: z.number().nullable(),
    unit: z.string().nullable(),
    points: z.array(z.object({
      date: z.string(),
      value: z.number().nullable(),
      value_display: z.string().nullable(),
    })),
  })),
  cardio_fitness_level: z.string().nullable(),
});
export type TrendOutT = z.infer<typeof TrendOut>;
