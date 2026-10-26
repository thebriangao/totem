import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { asArray, asNumber, asString, isObject } from "../../lib/walk.js";
import { WeeklyPlanOut } from "../../schemas/compact.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { READ_ONLY } from "../annotations.js";

/** A compact projection of Whoop's weekly-plan home tile. */
export function registerWeeklyPlan(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_weekly_plan",
    "EXPERIMENTAL: Weekly-plan progress in a compact form. Its upstream endpoint has not yet been verified against a live account.",
    { date: z.iso.date().optional().describe("Any date in the target week. Defaults to today.") },
    READ_ONLY,
    async ({ date }) => {
      const d = date ?? todayIso();
      const raw = await client.get(`/progression-service/v2/weekly-plan/home-tile/${d}`);
      const root = isObject(raw) ? raw : {};
      const tile = isObject(root.tile) ? root.tile : {};
      const content = isObject(tile.content) ? tile.content : {};
      const progress = isObject(content.progress_bar) ? content.progress_bar : {};
      const goals = asArray(content.items).flatMap((item) => {
        if (!isObject(item)) return [];
        const indicator = isObject(item.circular_progress_indicator) ? item.circular_progress_indicator : {};
        const steps = isObject(indicator.current_progress_steps) ? indicator.current_progress_steps : null;
        const percentage = isObject(indicator.current_progress_percentage) ? indicator.current_progress_percentage : null;
        return [{
          id: asString(item.id),
          title: asString(item.title),
          progress: steps
            ? { display: asString(steps.text_display), current: asNumber(steps.current_step), target: asNumber(steps.total_steps), percent: null }
            : percentage
              ? { display: asString(percentage.text_display), current: null, target: null, percent: asNumber(percentage.percentage) }
              : null,
        }];
      });
      const out = {
        experimental: true as const,
        date: d,
        title: asString(content.title),
        days_left: asString(content.days_left_display),
        accomplished_pct: asNumber(progress.percent_value),
        goals,
      };
      try {
        return { content: [{ type: "text", text: jsonOut(WeeklyPlanOut.parse(out)) }] };
      } catch (error) {
        if (error instanceof z.ZodError) throw new WhoopProjectionError("whoop_weekly_plan", error);
        throw error;
      }
    },
  );
}
