import { z } from "zod";

export const RecoveryOut = z.object({
  date: z.iso.date(),
  score: z.number().nullable(),
  state: z.enum(["GREEN", "YELLOW", "RED"]).nullable(),
  hrv: z.object({
    ms: z.number().nullable(),
    baseline_ms: z.number().nullable(),
    delta_pct: z.number().nullable(),
  }),
  rhr: z.object({
    bpm: z.number().nullable(),
    baseline_bpm: z.number().nullable(),
    delta_pct: z.number().nullable(),
  }),
  respiratory_rate: z.number().nullable(),
  spo2_pct: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  sleep_performance_pct: z.number().nullable(),
  contributors: z.array(z.object({
    name: z.string(),
    direction: z.enum(["positive", "negative", "neutral"]),
    detail: z.string().nullable(),
  })),
  calibration_state: z.enum(["CALIBRATING", "CALIBRATED"]).nullable(),
});
export type RecoveryOutT = z.infer<typeof RecoveryOut>;
