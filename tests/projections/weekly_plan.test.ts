import { describe, expect, it } from "vitest";
import { goalTarget, planWeek, projectWeeklyPlan } from "../../src/projections/weekly_plan.js";
import { WeeklyPlanOut } from "../../src/schemas/weekly_plan.js";
import { fx } from "../tools/health_plans_helpers.js";

describe("projectWeeklyPlan — v1 weekly-plan + v2 home tile", () => {
  it("merges goals by id: target parsed from the title, days met, %, this week's total", () => {
    const out = projectWeeklyPlan(fx("weekly_plan_v1_active.json"), fx("weekly_plan_tile_active.json"), "2026-11-21");
    expect(() => WeeklyPlanOut.parse(out)).not.toThrow();
    expect(out).toEqual({
      has_plan: true,
      plan_id: "d027813c-507a-48d3-b06e-3d71a8f098c0",
      plan: "Custom",
      week: { start: "2026-11-16", end: "2026-11-22" },
      days_left: 2,
      pct: 14,
      goals: [
        { type: "STEPS", target: 10000, days_met: [0, 7], pct: null, this_week: 1197 },
        { type: "STRENGTH_TRAINING_TIME", target: 120, days_met: null, pct: 27.4, this_week: 32 },
      ],
    });
  });

  it("no plan: has_plan false and no goals (the locked plan tiles aren't goals)", () => {
    expect(projectWeeklyPlan(fx("weekly_plan_v1_none.json"), fx("weekly_plan_tile_none.json"), "2026-11-21")).toEqual({
      has_plan: false, plan_id: null, plan: null, week: { start: "2026-11-16", end: "2026-11-22" }, days_left: null, pct: null, goals: [],
    });
  });

  it("works from either read alone", () => {
    expect(projectWeeklyPlan(null, fx("weekly_plan_tile_active.json"), "2026-11-21").goals.map((g) => g.type)).toEqual(["STRENGTH_TRAINING_TIME", "STEPS"]);
    expect(projectWeeklyPlan(fx("weekly_plan_v1_active.json"), null, "2026-11-21")).toMatchObject({ has_plan: true, pct: 0, goals: [{ type: "STEPS" }] });
  });

  it("weeks run Monday–Sunday; targets parse steps and h:mm", () => {
    expect(planWeek("2026-11-16")).toEqual({ start: "2026-11-16", end: "2026-11-22" });
    expect(planWeek("2026-11-22")).toEqual({ start: "2026-11-16", end: "2026-11-22" });
    expect(goalTarget("8,000+ Steps")).toBe(8000);
    expect(goalTarget("2:00+ Strength Activity Time")).toBe(120);
    expect(goalTarget(null)).toBeNull();
  });
});
