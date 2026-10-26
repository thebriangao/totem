import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { METRICS } from "../../schemas/trend.js";
import { projectTrend } from "../../projections/trend.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { TrendPackOut } from "../../schemas/compact.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { READ_ONLY } from "../annotations.js";

export function registerTrendPack(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_trend_pack",
    "Compact trend summaries for up to five requested metrics. Per-day points are omitted unless include_points is true.",
    {
      metrics: z.array(z.enum(METRICS)).min(1).max(5).refine((v) => new Set(v).size === v.length, "metrics must not contain duplicates"),
      end_date: z.iso.date().optional(),
      window: z.enum(["week", "month", "six_month", "year"]).default("month"),
      include_points: z.boolean().default(false),
    },
    READ_ONLY,
    async ({ metrics, end_date, window, include_points }) => {
      const d = end_date ?? todayIso();
      const trends = await Promise.all(metrics.map(async (metric) => {
        const raw = await client.get(`/progression-service/v3/trends/${metric}`, { endDate: d });
        const segment = projectTrend(raw, metric, d).segments.find((item) => item.label === window) ?? null;
        return segment && (include_points ? { metric, ...segment } : {
          metric,
          window: segment.label,
          avg: segment.avg,
          min: segment.min,
          max: segment.max,
          delta_pct: segment.delta_pct,
          unit: segment.unit,
        });
      }));
      try {
        return { content: [{ type: "text", text: jsonOut(TrendPackOut.parse({ end_date: d, window, trends })) }] };
      } catch (error) {
        if (error instanceof z.ZodError) throw new WhoopProjectionError("whoop_trend_pack", error);
        throw error;
      }
    },
  );
}
