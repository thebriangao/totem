import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CycleOut } from "../../schemas/womens_health.js";
import { projectCycle } from "../../projections/cycle.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerCycle(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_cycle",
    "Current menstrual cycle status: phase, day, hormonal mode, MCI tile.",
    { date: z.iso.date().optional() },
    async ({ date }) => {
      const d = date ?? todayIso();
      const raw = await client.get("/womens-health-service/v1/menstrual-cycle-insights", { date: d });
      const projected = projectCycle(raw, d);
      try {
        const out = CycleOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_cycle", e);
        throw e;
      }
    },
  );
}
