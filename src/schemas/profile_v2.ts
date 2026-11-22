// v2 output schemas for whoop_profile and whoop_profile_update.
import { z } from "zod";
import { withPreview } from "./primitives.js";
import { HrZonesV2Out } from "./settings_v2.js";

const Pillar = z.object({ to: z.string(), trends: z.boolean(), daily: z.boolean() });

const HealthFeature = z.object({
  status: z.enum(["available", "locked", "not_set_up", "no_data", "unavailable"]),
  message: z.string().nullable().optional(),
  /** The unlocked shape has never been seen by totem's tests: fields may be missing or misnamed. */
  unverified: z.literal(true).optional(),
  content: z.unknown().optional(),
  truncated: z.literal(true).optional(),
  biomarkers: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    value: z.string().nullable(),
    unit: z.string().nullable(),
    status: z.string().nullable(),
  })).optional(),
});

export const ProfileV2Out = z.object({
  user_id: z.number().int().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  birthday: z.iso.date().nullable(),
  /** PUT enum: MALE, FEMALE, NON_BINARY, PREFER_NOT. */
  gender: z.string().nullable(),
  physiological_baseline: z.string().nullable(),
  height_m: z.number().nullable(),
  weight_kg: z.number().nullable(),
  unit_system: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  tz_offset: z.string().nullable(),
  max_hr: z.number().int().nullable(),
  resting_hr: z.number().int().nullable(),
  fitness_level: z.string().nullable(),
  membership: z.string().nullable(),
  /** Metrics you've hidden from the app. */
  hidden_metrics: z.array(z.string()),
  stealth: z.boolean().nullable(),
  locked_fields: z.array(z.string()),
  hr_zones: HrZonesV2Out.nullable().optional(),
  entitlements: z.object({
    on: z.number().int(),
    /** feature → why it's off. */
    off: z.record(z.string(), z.string()),
  }).nullable().optional(),
  integrations: z.object({ connected: z.array(z.string()), available: z.array(z.string()) }).nullable().optional(),
  privacy: z.object({
    searchable: z.boolean().nullable(),
    mutual_sharing: z.boolean().nullable(),
    /** Field → everyone | friends | no_one. */
    visibility: z.record(z.string(), z.string()),
    sleep: Pillar.nullable(),
    recovery: Pillar.nullable(),
    strain: Pillar.nullable(),
    /** Sports whose sharing differs from the default. */
    activity_overrides: z.record(z.string(), z.string()).nullable(),
  }).nullable().optional(),
  /** include=health (src/projections/health_features.ts). */
  health: z.object({
    healthspan: HealthFeature,
    blood_pressure: HealthFeature,
    advanced_labs: HealthFeature,
    afib: HealthFeature,
  }).optional(),
  warnings: z.array(z.string()),
});

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ProfileUpdateV2Out = withPreview(z.object({
  updated: z.boolean(),
  no_change: z.boolean(),
  /** field → [before, after]; "after" is what the read-back shows. */
  changed: z.record(z.string(), z.tuple([Scalar, Scalar])),
  verified: z.boolean(),
  mismatches: z.array(z.string()),
  warnings: z.array(z.string()),
}));
