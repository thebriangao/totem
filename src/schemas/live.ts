import { z } from "zod";

export const LiveHrOut = z.object({
  current_bpm: z.number().int().nullable(),
  hr_zone: z.number().int().min(0).max(5).nullable(),
  is_recording: z.boolean(),
  last_updated_at: z.iso.datetime({ offset: true }).nullable(),
  show_live_hr: z.boolean(),
});
export type LiveHrOutT = z.infer<typeof LiveHrOut>;

export const LiveStateOut = z.object({
  state: z.enum(["workout", "sleep", "idle", "recovery", "unknown"]),
  sport_name: z.string().nullable(),
  sport_id: z.number().int().nullable(),
  activity_id: z.string().nullable(),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  duration_so_far_ms: z.number().int().nullable(),
  tracked_sleep: z.boolean(),
  latest_metrics_at: z.iso.datetime({ offset: true }).nullable(),
});
export type LiveStateOutT = z.infer<typeof LiveStateOut>;

export const LiveStressOut = z.object({
  current_level: z.number().nullable(),
  baseline_level: z.number().nullable(),
  calibration_state: z.enum(["CALIBRATING", "CALIBRATED"]).nullable(),
  last_updated_at: z.iso.datetime({ offset: true }).nullable(),
});
export type LiveStressOutT = z.infer<typeof LiveStressOut>;
