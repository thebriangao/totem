import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { TrendOut, METRICS } from "../../schemas/trend.js";
import { projectTrend } from "../../projections/trend.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { READ_ONLY } from "../annotations.js";

export function registerTrend(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_trend",
    "Trend for one metric across week / month / 6-month windows — per-day points, aggregate stats, and delta vs the prior window. metric is exactly one of: HRV, RHR, RECOVERY, DAY_STRAIN, CALORIES, STEPS, AVERAGE_HR, HOURS_V_NEED, HOURS_V_NEEDED_PERCENT, TIME_IN_BED, SLEEP_PERFORMANCE, SLEEP_EFFICIENCY, SLEEP_CONSISTENCY, SLEEP_DEBT_POST, RESTORATIVE_SLEEP, HR_ZONES_1_3, HR_ZONES_4_5, RESPIRATORY_RATE, STRENGTH_ACTIVITY_TIME, STRESS, STRESS_DURING_SLEEP, STRESS_DURING_NON_STRAIN, VO2_MAX, BODY_COMPOSITION, WEIGHT.",
    {
      metric: z.enum(METRICS).describe("Which metric to trend."),
      end_date: z.iso.date().optional().describe("End date. Defaults to today."),
    },
    READ_ONLY,
    async ({ metric, end_date }) => {
      const d = end_date ?? todayIso();
      const raw = await client.get(`/progression-service/v3/trends/${metric}`, { endDate: d });
      const projected = projectTrend(raw, metric, d);
      try {
        const out = TrendOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_trend", e);
        throw e;
      }
    },
  );
}
