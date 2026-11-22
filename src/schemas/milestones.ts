import { z } from "zod";

export const BADGE_COLUMNS = ["type", "tag", "name", "count", "status"] as const;

export const Badge = z.object({
  type: z.string(),
  name: z.string().nullable(),
  /** Times earned; null when WHOOP shows none (a locked badge). */
  count: z.number().int().nullable(),
  /** "top 7%" (rarity of an earned badge) or "3/5" (progress to the first). */
  status: z.string().nullable(),
});
export type BadgeT = z.infer<typeof Badge> & { tag: string };

export const Streak = z.object({
  days: z.number().int().nullable(),
  state: z.string().nullable(),
  started: z.iso.date().nullable(),
  max: z.number().int().nullable(),
  next_milestone_in_days: z.number().int().nullable(),
  this_week: z.object({ worn: z.array(z.string()), missed: z.array(z.string()) }).nullable(),
});
export type StreakT = z.infer<typeof Streak>;

export const MilestonesHubOut = z.object({
  totals: z.object({ total: z.number().nullable(), unique: z.number().nullable(), rare: z.number().nullable() }),
  streak: Streak.nullable(),
  top: z.array(Badge),
  in_progress: z.array(Badge),
  badges: z.object({
    columns: z.array(z.enum(BADGE_COLUMNS)),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  }).optional(),
});
export type MilestonesHubOutT = z.infer<typeof MilestonesHubOut>;

export const MilestoneDetailOut = z.object({
  type: z.string(),
  name: z.string().nullable(),
  about: z.string().nullable(),
  count: z.number().int().nullable(),
  next: z.object({ more: z.number().nullable(), pct: z.number().nullable() }).nullable(),
  /** [threshold, date earned] per level reached. */
  earned: z.array(z.tuple([z.number().nullable(), z.iso.date().nullable()])),
});
export type MilestoneDetailOutT = z.infer<typeof MilestoneDetailOut>;

export const MilestonesOut = z.union([MilestoneDetailOut, MilestonesHubOut]);
