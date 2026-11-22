import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE, idempotent } from "../annotations.js";
import { PLAN_GOAL_TYPES, WeeklyPlanSetOut, type WeeklyPlanOutT } from "../../schemas/weekly_plan.js";
import { previewWith, toolError, writeRejected } from "../../lib/health_plans_write.js";
import { get } from "../../whoop/bff.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { todayIso } from "../../lib/dates.js";
import { PLAN_V2, readWeeklyPlan } from "./weekly_plan.js";

type GoalType = typeof PLAN_GOAL_TYPES[number];
interface Range { min: number; max: number; step: number }

// Fallbacks if the setup screen omits its slider (live: STEPS 100–10000 by 100,
// STRENGTH_TRAINING_TIME 10–720 minutes by 15).
const FALLBACK: Record<GoalType, Range> = {
  STEPS: { min: 100, max: 50_000, step: 100 },
  STRENGTH_TRAINING_TIME: { min: 10, max: 720, step: 15 },
};

/** The slider WHOOP's setup screen offers for a goal type (usable range + increment). */
export function sliderRange(setup: unknown, type: GoalType): Range {
  const screens = get(setup, "screens");
  const screen = Array.isArray(screens) ? screens.find((s) => get(s, "goal") === type) : undefined;
  const slider = get(screen, "slider_content");
  const min = get(slider, "usable_range", "lower_endpoint");
  const max = get(slider, "usable_range", "upper_endpoint");
  const step = get(slider, "increment");
  return typeof min === "number" && typeof max === "number" && typeof step === "number" && step > 0
    ? { min, max, step }
    : FALLBACK[type];
}

/** Within the slider, on its increment (the slider minimum itself is also allowed: 10 min). */
export function targetError(type: GoalType, target: number, r: Range): string | null {
  const unit = type === "STEPS" ? "steps/day" : "minutes/week";
  if (target < r.min || target > r.max || (target % r.step !== 0 && target !== r.min)) {
    return `${type} target must be ${r.min}–${r.max} ${unit} in steps of ${r.step} (WHOOP's slider); got ${target}.`;
  }
  return null;
}

export function registerWeeklyPlanSet(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_weekly_plan_set",
    description:
      "WRITE: change the Weekly Plan goals. set_goal adds or edits a goal (creates a Custom plan if none): STEPS target in steps/day, STRENGTH_TRAINING_TIME in minutes/week; " +
      "targets must fit WHOOP's slider. remove_goal drops one; end_plan removes every goal (removing the last one ends the plan). Other goal types are managed in the app. Preview unless confirm:true.",
    input: {
      action: z.enum(["set_goal", "remove_goal", "end_plan"]),
      type: z.enum(PLAN_GOAL_TYPES).optional().describe("Goal type for set_goal / remove_goal."),
      target: z.number().int().positive().optional().describe("set_goal: steps/day or minutes/week."),
      confirm: z.boolean().default(false),
    },
    annotations: idempotent(WRITE_DESTRUCTIVE),
  }, async ({ action, type, target, confirm }) => {
    if (action === "set_goal" && (!type || target === undefined)) return toolError("set_goal needs type and target.");
    if (action === "remove_goal" && !type) return toolError("remove_goal needs type.");
    if (action === "end_plan" && (type || target !== undefined)) return toolError("end_plan takes no type or target.");
    if (action === "remove_goal" && target !== undefined) return toolError("remove_goal takes no target.");

    // Fresh pre-reads: the current plan, and the plan id (+ slider) from setup.
    const date = todayIso();
    const [current, setup] = await Promise.all([
      readWeeklyPlan(client, date, true),
      client.get(`${PLAN_V2}/setup`, type && action === "set_goal" ? { screens: type } : {}, { fresh: true }),
    ]);
    const planId = get(setup, "plan_id");
    if (typeof planId !== "string" || !planId) return toolError("WHOOP's plan setup returned no plan_id; try again or use the app.");
    if (current.plan_id && current.plan_id !== planId) {
      return toolError(`WHOOP reports two plan ids (current ${current.plan_id}, setup ${planId}); refusing to write to the wrong plan. Edit the plan in the app.`);
    }

    const warnings: string[] = [];
    const goalTypes = current.goals.map((g) => g.type);
    let writes: Array<{ method: "PUT" | "DELETE"; path: string; body?: unknown }>;
    if (action === "set_goal") {
      const err = targetError(type!, target!, sliderRange(setup, type!));
      if (err) return toolError(err);
      if (!current.has_plan) warnings.push("There is no plan this week, so this starts a Custom weekly plan.");
      writes = [{ method: "PUT", path: `${PLAN_V2}/${planId}/goal/target`, body: { type, target } }];
    } else if (action === "remove_goal") {
      if (!goalTypes.includes(type!)) return toolError(`${type} isn't in the current plan (goals: ${goalTypes.join(", ") || "none"}).`);
      if (goalTypes.length === 1) warnings.push("This is the plan's last goal, so removing it ends the plan.");
      writes = [{ method: "DELETE", path: `${PLAN_V2}/${planId}/goal/target/${type}` }];
    } else {
      if (!current.has_plan || !goalTypes.length) return toolError("There is no active weekly plan to end.");
      const foreign = goalTypes.filter((g) => !(PLAN_GOAL_TYPES as readonly string[]).includes(g));
      if (foreign.length) {
        return toolError(`The plan has goals totem doesn't manage (${foreign.join(", ")}); end it in the WHOOP app.`);
      }
      writes = goalTypes.map((g) => ({ method: "DELETE" as const, path: `${PLAN_V2}/${planId}/goal/target/${g}` }));
      warnings.push("Ending the plan removes every goal.");
    }

    if (!confirm) {
      const body = writes.length === 1 ? writes[0]!.body ?? null : { requests: writes.map((w) => `${w.method} ${w.path}`) };
      return respond("whoop_weekly_plan_set", WeeklyPlanSetOut, previewWith(writes[0]!.method, writes[0]!.path, body, warnings, current));
    }
    for (const w of writes) {
      try {
        if (w.method === "PUT") await client.put(w.path, w.body);
        else await client.delete(w.path);
      } catch (error) {
        if (error instanceof WhoopApiError) return writeRejected("weekly plan change", w.path, error);
        throw error;
      }
    }

    const after: WeeklyPlanOutT = await readWeeklyPlan(client, date, true);
    const goal = after.goals.find((g) => g.type === type);
    const verified = action === "set_goal"
      ? Boolean(goal) && (goal!.target === null || goal!.target === target)
      : action === "remove_goal"
        ? !goal
        : !after.has_plan || after.goals.length === 0;
    if (!verified) warnings.push("The plan read back doesn't show the change yet; check whoop_weekly_plan.");
    return respond("whoop_weekly_plan_set", WeeklyPlanSetOut, { action, verified, plan: after, warnings });
  });
}
