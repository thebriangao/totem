import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiveStressOut } from "../../schemas/live.js";
import { projectLiveStress } from "../../projections/live_stress.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerLiveStress(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_live_stress",
    "Current stress level (terse). Cheaper than whoop_stress if you just want the latest reading.",
    {},
    async () => {
      const raw = await client.get(`/health-service/v2/stress-bff/${todayIso()}`);
      const projected = projectLiveStress(raw);
      try {
        const out = LiveStressOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_live_stress", e);
        throw e;
      }
    },
  );
}
