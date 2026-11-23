import { z } from "zod";
import { PreviewOut } from "../lib/health_plans_write.js";

/** D12: the only goal types totem writes. */
export const PLAN_GOAL_TYPES = ["STEPS", "STRENGTH_TRAINING_TIME"] as const;

export const PlanGoal = z.object({
  type: z.string(),
  /** Steps/day for STEPS; minutes/week for STRENGTH_TRAINING_TIME (parsed from the goal title). */
  target: z.number().nullable(),
  /** Days the daily target was met so far this week, of the week's days. */
  days_met: z.tuple([z.number().int(), z.number().int()]).nullable(),
  pct: z.number().nullable(),
  /** This week's running total: steps, or minutes for time goals. */
  this_week: z.number().nullable(),
});

export const WeeklyPlanOut = z.object({
  has_plan: z.boolean(),
  plan_id: z.string().nullable(),
  plan: z.string().nullable(),
  week: z.object({ start: z.iso.date(), end: z.iso.date() }),
  days_left: z.number().int().nullable(),
  pct: z.number().nullable(),
  goals: z.array(PlanGoal),
});
export type WeeklyPlanOutT = z.infer<typeof WeeklyPlanOut>;

export const WeeklyPlanSetReceipt = z.object({
  action: z.enum(["set_goal", "remove_goal", "end_plan"]),
  verified: z.boolean(),
  plan: WeeklyPlanOut,
  warnings: z.array(z.string()),
});

export const WeeklyPlanSetOut = z.union([PreviewOut, WeeklyPlanSetReceipt]);
