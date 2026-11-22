import { z } from "zod";
import { HEALTH_FEATURES } from "../projections/health_features.js";

/** whoop_health. Every answer says experimental: these features were built without an account that has them. */
export const HealthOut = z.object({
  feature: z.enum(HEALTH_FEATURES),
  experimental: z.literal(true),
  date: z.iso.date().optional(),
  id: z.string().optional(),
  status: z.enum(["available", "locked", "not_set_up", "no_data", "not_readable", "unavailable"]),
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
  tests: z.unknown().optional(),
  about: z.record(z.string(), z.string()).optional(),
  next_cursor: z.string().nullable().optional(),
  warnings: z.array(z.string()),
});
