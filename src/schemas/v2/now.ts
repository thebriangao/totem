import { z } from "zod";
import { IsoDateTime } from "../primitives.js";
import { InstantOrNull, NumOrNull, StrOrNull } from "./core_common.js";

export const NowV2Out = z.object({
  state: z.enum(["workout", "sleep", "idle", "recovery", "unknown"]),
  sport_name: StrOrNull,
  activity_id: StrOrNull,
  started_at: InstantOrNull,
  duration_min: z.number().int().nullable(),
  tracked_sleep: z.boolean(),
  latest_metrics_at: InstantOrNull,
  stress: z.object({ level: NumOrNull, label: StrOrNull, state: StrOrNull }).nullable(),
  scores: z.object({
    recovery_pct: NumOrNull,
    sleep_pct: NumOrNull,
    strain: NumOrNull,
    calories: NumOrNull,
    hrv_ms: NumOrNull,
  }).nullable(),
  fetched_at: IsoDateTime,
  metrics_age_min: z.number().int().nonnegative().nullable(),
});
