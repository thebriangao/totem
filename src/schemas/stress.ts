import { z } from "zod";

export const StressOut = z.object({
  date: z.iso.date(),
  current_level: z.number().nullable(),
  baseline_level: z.number().nullable(),
  peak_level: z.number().nullable(),
  min_level: z.number().nullable(),
  calibration_state: z.enum(["CALIBRATING", "CALIBRATED"]).nullable(),
  timeline: z.array(z.object({
    started_at: z.iso.datetime({ offset: true }),
    ended_at: z.iso.datetime({ offset: true }),
    level: z.number().nullable(),
  })),
});
export type StressOutT = z.infer<typeof StressOut>;
