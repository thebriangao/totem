// v2 output schemas for whoop_preferences, whoop_preferences_set and
// whoop_hr_zones_set (HR zones are also whoop_profile's hr_zones include).
import { z } from "zod";
import { withPreview } from "./primitives.js";

const ZoneRange = z.tuple([z.number().int(), z.number().int()]);

export const HrZonesV2Out = z.object({
  max_hr: z.number().int().nullable(),
  resting_hr: z.number().int().nullable(),
  /** From settings.manual_heart_rate_zones_form.toggle_value (bff/zones has no such flag). */
  is_custom: z.boolean().nullable(),
  /** Zones in effect as [min, max] bpm keyed Z0..Z5; Z0 is everything below Z1. */
  zones: z.record(z.string(), ZoneRange),
  /** Custom zones only: WHOOP's heart-rate-reserve zones, which `reset` restores. */
  defaults: z.record(z.string(), ZoneRange).nullable(),
});
export type HrZonesV2OutT = z.infer<typeof HrZonesV2Out>;

export const HrZonesSetV2Out = withPreview(z.object({
  action: z.enum(["max_hr", "custom", "reset"]),
  updated: z.boolean(),
  no_change: z.boolean(),
  before: HrZonesV2Out.nullable(),
  after: HrZonesV2Out.nullable(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
}));

export const JournalPrefsOut = z.object({
  journal_enabled: z.boolean().nullable(),
  journal_autopop_enabled: z.boolean().nullable(),
  ai_autopop_enabled: z.boolean().nullable(),
});

export const DashboardOut = z.object({
  /** Your two focus gauges (RECOVERY and DAY_STRAIN are always shown too). */
  gauges: z.array(z.string()),
  pinned: z.array(z.string()),
  /** whoop_preferences only: the metric keys this account can choose from (the write tool takes these). */
  options: z.object({ gauges: z.array(z.string()), pinnable: z.array(z.string()) }).optional(),
});

export const PreferencesV2Out = z.object({
  journal: JournalPrefsOut.nullable().optional(),
  /** namespace → active (false = blocked). */
  notifications: z.record(z.string(), z.boolean().nullable()).nullable().optional(),
  /** setting_key → active. */
  ai: z.record(z.string(), z.boolean().nullable()).nullable().optional(),
  dashboard: DashboardOut.nullable().optional(),
  tracked_behaviors: z.object({ count: z.number().int(), custom: z.number().int() }).nullable().optional(),
  errors: z.array(z.object({ section: z.string(), error: z.string() })),
});

export const PreferencesSetOut = withPreview(z.object({
  setting: z.enum(["hidden_metric", "stealth", "dashboard", "notification", "journal_prefs", "tracked_behaviors", "clock_format"]),
  updated: z.boolean(),
  no_change: z.boolean(),
  before: z.unknown(),
  after: z.unknown(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
}));
