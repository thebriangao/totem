import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { StressOut } from "../../schemas/stress.js";
import { projectStress } from "../../projections/stress.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerStress(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_stress",
    "Stress monitor for a day: timeline buckets (15-min), current level, baseline, daily min/peak.",
    { date: z.iso.date().optional() },
    async ({ date }) => {
      const d = date ?? todayIso();
      const raw = await client.get(`/health-service/v2/stress-bff/${d}`);
      const projected = projectStress(raw, d);
      try {
        const out = StressOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_stress", e);
        throw e;
      }
    },
  );
}
