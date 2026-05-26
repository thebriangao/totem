import { z } from "zod";

export const PgRange = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }).nullable(),
});

export const HrZoneDurations = z.object({
  zone_0_ms: z.number().int().nullable(),
  zone_1_ms: z.number().int().nullable(),
  zone_2_ms: z.number().int().nullable(),
  zone_3_ms: z.number().int().nullable(),
  zone_4_ms: z.number().int().nullable(),
  zone_5_ms: z.number().int().nullable(),
});
export type HrZoneDurationsT = z.infer<typeof HrZoneDurations>;

export const RecoveryState = z.enum(["GREEN", "YELLOW", "RED"]);
export const SleepStage = z.enum(["AWAKE", "LIGHT", "REM", "SWS"]);
export const Medal = z.enum(["GOLD", "SILVER", "BRONZE"]);
export const Direction = z.enum(["positive", "negative", "neutral"]);
export const CalibrationState = z.enum(["CALIBRATING", "CALIBRATED"]);

// Re-export from write_safety so schemas/*.ts has one import path.
export { withPreview, WritePreviewSchema } from "../whoop/write_safety.js";
