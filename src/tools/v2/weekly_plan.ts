import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { WeeklyPlanOut, type WeeklyPlanOutT } from "../../schemas/weekly_plan.js";
import { projectWeeklyPlan } from "../../projections/weekly_plan.js";
import { todayIso } from "../../lib/dates.js";

export const PLAN_V1 = "/progression-service/v1/weekly-plan";
export const PLAN_V2 = "/progression-service/v2/weekly-plan";

/** v1 weekly plan + v2 home tile for the week containing `date`; one may fail, not both. */
export async function readWeeklyPlan(client: WhoopClient, date: string, fresh = false): Promise<WeeklyPlanOutT> {
  const [v1, tile] = await Promise.allSettled([
    client.get(PLAN_V1, { date }, { fresh }),
    client.get(`${PLAN_V2}/home-tile/${date}`, {}, { fresh }),
  ]);
  if (v1.status === "rejected" && tile.status === "rejected") throw v1.reason;
  return projectWeeklyPlan(
    v1.status === "fulfilled" ? v1.value : null,
    tile.status === "fulfilled" ? tile.value : null,
    date,
  );
}

export function registerWeeklyPlan(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_weekly_plan",
    description:
      "The Weekly Plan for the Monday–Sunday week containing a date: has_plan, plan name, days left, overall % accomplished, and goals " +
      "(type, target: steps/day or minutes/week, days_met [met, of], pct, this_week running total). Change goals with whoop_weekly_plan_set.",
    input: {
      date: z.iso.date().optional().describe("Any date in the week (default today)."),
    },
    annotations: READ_ONLY,
  }, async ({ date }) => respond("whoop_weekly_plan", WeeklyPlanOut, await readWeeklyPlan(client, date ?? todayIso())));
}
