import { z } from "zod";
import { HEALTH_FEATURES } from "../projections/health_features.js";

/** whoop_health. experimental: true unless the answer's shape has been seen filled in on a real account (Healthspan has). */
export const HealthOut = z.object({
  feature: z.enum(HEALTH_FEATURES),
  experimental: z.boolean(),
  date: z.iso.date().optional(),
  id: z.string().optional(),
  status: z.enum(["available", "locked", "not_set_up", "no_data", "unavailable"]),
  message: z.string().nullable().optional(),
  /** The screen with UI fields stripped: its filled-in shape is unverified. */
  content: z.unknown().optional(),
  truncated: z.literal(true).optional(),
  biomarkers: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    value: z.string().nullable(),
    unit: z.string().nullable(),
    status: z.string().nullable(),
  })).optional(),
  /** Healthspan's unlocked screen, projected (verified on a real account). */
  healthspan: z.object({
    period: z.string().nullable(),
    calibrating: z.boolean(),
    whoop_age: z.number().nullable(),
    years_vs_actual_age: z.number().nullable(),
    pace_of_aging: z.number().nullable(),
    previous: z.object({ whoop_age: z.number().nullable(), years_vs_actual_age: z.number().nullable(), pace_of_aging: z.number().nullable() }).nullable(),
    contributor_cols: z.tuple([z.literal("area"), z.literal("name"), z.literal("long_avg"), z.literal("recent_avg"), z.literal("impact_years")]),
    contributors: z.array(z.tuple([z.string(), z.string(), z.string().nullable(), z.string().nullable(), z.number().nullable()])),
  }).optional(),
  tests: z.unknown().optional(),
  next_cursor: z.string().nullable().optional(),
  warnings: z.array(z.string()),
});
