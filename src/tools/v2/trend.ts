import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { TrendOut, METRICS } from "../../schemas/trend.js";
import { projectTrend } from "../../projections/trend.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerTrend(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_trend",
    "Trend data for one of 25 metrics over week/month/6-month windows. Returns per-day data points + aggregate stats + delta vs prior window.",
    {
      metric: z.enum(METRICS).describe("Which metric to trend."),
      end_date: z.iso.date().optional().describe("End date. Defaults to today."),
    },
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
