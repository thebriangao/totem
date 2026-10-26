import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { PerformanceAssessmentOut } from "../../schemas/performance.js";
import { projectPerformanceAssessment } from "../../projections/performance_assessment.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { getTimezone, zonedParts } from "../../lib/timezone.js";
import { READ_ONLY } from "../annotations.js";

// "now" as a wall-clock timestamp in the USER's timezone with the user's offset
// (e.g. "2026-05-27T13:05:00-0700"). Uses the configured WHOOP_TIMEZONE / profile
// TZ rather than the server's offset — `getTimezoneOffset()` returns 0 on a UTC
// host like Fly, which produced wrong local times before.
function localIsoNow(): string {
  const now = new Date();
  const p = zonedParts(now, getTimezone());
  const pad = (n: number): string => String(n).padStart(2, "0");
  // Offset = (the wall-clock components read as if UTC) minus the real instant.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMin = Math.round((asUtc - now.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

export function registerPerformanceAssessment(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_performance_assessment",
    "Whoop's performance assessment for a period — recoveries logged vs required, whether an assessment is due, and the next assessment window. period: WEEK or MONTH (default MONTH).",
    { period: z.enum(["WEEK", "MONTH"]).default("MONTH") },
    READ_ONLY,
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
