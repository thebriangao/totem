import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { RecoveryOut } from "../../schemas/recovery.js";
import { projectRecovery } from "../../projections/recovery.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerRecovery(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_recovery",
    "Recovery deep-dive: score, HRV (current + baseline), RHR (current + baseline), respiratory rate, SpO2, skin temp, sleep performance contributor, calibration state, recovery contributors.",
    { date: z.iso.date().optional().describe("YYYY-MM-DD. Defaults to today.") },
    async ({ date }) => {
      const d = date ?? todayIso();
      const raw = await client.get("/home-service/v1/deep-dive/recovery", { date: d });
      const projected = projectRecovery(raw, d);
      try {
        const out = RecoveryOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_recovery", e);
        throw e;
      }
    },
  );
}
