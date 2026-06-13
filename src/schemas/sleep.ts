import { z } from "zod";
import { IsoDateTime, withPreview } from "./primitives.js";

export const SleepStageEnum = z.enum(["AWAKE", "LIGHT", "REM", "SWS"]);

export const SleepOut = z.object({
  date: z.iso.date(),
  started_at: IsoDateTime.nullable(),
  ended_at: IsoDateTime.nullable(),
  total_sleep_ms: z.number().int().nullable(),
  time_in_bed_ms: z.number().int().nullable(),
  efficiency_pct: z.number().nullable(),
  performance_pct: z.number().nullable(),
  consistency_pct: z.number().nullable(),
  debt_ms: z.number().int().nullable(),
  latency_ms: z.number().int().nullable(),
  stages: z.object({
    rem_ms: z.number().int().nullable(),
    rem_pct: z.number().nullable(),
    light_ms: z.number().int().nullable(),
    light_pct: z.number().nullable(),
    sws_ms: z.number().int().nullable(),
    sws_pct: z.number().nullable(),
    wake_ms: z.number().int().nullable(),
    wake_pct: z.number().nullable(),
  }),
  hypnogram: z.array(z.object({
    started_at: IsoDateTime,
    ended_at: IsoDateTime,
    stage: SleepStageEnum,
  })),
  disturbances: z.number().int().nullable(),
  sleep_hr: z.object({
    avg_bpm: z.number().nullable(),
    min_bpm: z.number().nullable(),
  }),
  sleep_hrv_ms: z.number().nullable(),
  respiratory_rate: z.number().nullable(),
});
export type SleepOutT = z.infer<typeof SleepOut>;

export const SleepEditOut = withPreview(z.object({
  edited: z.literal(true),
  activity_id: z.string(),
  start: IsoDateTime,
  end: IsoDateTime,
}));
