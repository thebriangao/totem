import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { PerformanceAssessmentOut } from "../../schemas/performance.js";
import { projectPerformanceAssessment } from "../../projections/performance_assessment.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

function localIsoNow(): string {
  const now = new Date();
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, "0");
  const mm = String(absMin % 60).padStart(2, "0");
  return `${now.toISOString().slice(0, 19)}${sign}${hh}${mm}`;
}

export function registerPerformanceAssessment(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_performance_assessment",
    "Whoop's performance assessment for a period: aggregated training load, recovery trends, sleep performance, progress against goals.",
    { period: z.enum(["WEEK", "MONTH"]).default("MONTH") },
    async ({ period }) => {
      const ts = localIsoNow();
      const raw = await client.get(`/coaching-service/v1/performance-assessment/${period}/data/${ts}`);
      const projected = projectPerformanceAssessment(raw, period);
      try {
        const out = PerformanceAssessmentOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_performance_assessment", e);
        throw e;
      }
    },
  );
}
