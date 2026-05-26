import { z } from "zod";
import { withPreview } from "./primitives.js";

// ─── Catalog row schema ─────────────────────────────────────────────────────
export const JournalBehaviorSchema = z.object({
  behavior_tracker_id: z.number().int(),
  title: z.string(),
  question: z.string(),
  internal_name: z.string(),
  category: z.string(),
  magnitude: z.enum(["bare", "boolean", "magnitude"]),
  status: z.literal("active"),
});
export type JournalBehavior = z.infer<typeof JournalBehaviorSchema>;

// ─── Read tool outputs ──────────────────────────────────────────────────────
export const JournalOut = z.object({
  date: z.iso.date(),
  cycle_id: z.number().int().nullable(),
  journal_entry_id: z.string().nullable(),
  notes: z.string().nullable(),
  behaviors: z.array(z.object({
    behavior_tracker_id: z.number().int(),
    title: z.string(),
    category: z.string(),
    internal_name: z.string(),
    answered_yes: z.boolean().nullable(),
    magnitude_value: z.number().nullable(),
    magnitude_label: z.string().nullable(),
    recorded_at: z.iso.datetime({ offset: true }).nullable(),
  })),
});
export type JournalOutT = z.infer<typeof JournalOut>;

export const JournalCatalogOut = z.object({
  total_in_catalog: z.literal(308),
  matched: z.number().int(),
  truncated: z.boolean(),
  behaviors: z.array(JournalBehaviorSchema),
});
export type JournalCatalogOutT = z.infer<typeof JournalCatalogOut>;

export const BehaviorImpactOut = z.object({
  behavior_id: z.union([z.number().int(), z.string()]),
  behavior_name: z.string().nullable(),
  metrics: z.array(z.object({
    metric: z.string(),
    delta_avg: z.number().nullable(),
    delta_unit: z.string().nullable(),
    sample_size: z.number().int().nullable(),
    direction: z.enum(["positive", "negative", "neutral"]),
  })),
  insight: z.string().nullable(),
});
export type BehaviorImpactOutT = z.infer<typeof BehaviorImpactOut>;

// ─── Write tool outputs ─────────────────────────────────────────────────────
export const JournalLogOut = withPreview(z.object({
  logged: z.literal(true),
  date: z.iso.date(),
  behaviors_count: z.number().int(),
}));

export const JournalAutopopOut = withPreview(z.object({
  triggered: z.literal(true),
  cycle_id: z.number().int(),
}));
