import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { RecoveryOut } from "../../schemas/recovery.js";
import { projectRecovery } from "../../projections/recovery.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { READ_ONLY } from "../annotations.js";

export function registerRecovery(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_recovery",
    "Recovery deep-dive: score, state, HRV and RHR (each with baseline), respiratory rate, SpO2, skin temp, and sleep performance. (The generic contributors[] array and calibration_state are empty in the current tile shape — the per-metric data is in the typed fields.)",
    { date: z.iso.date().optional().describe("YYYY-MM-DD. Defaults to today.") },
    READ_ONLY,
    async ({ date }) => {
      const d = date ?? todayIso();
      // Window the date so the lightweight recovery record (which carries SpO2 +
      // skin temp, absent from the deep-dive tiles) is in range.
      const dayMs = Date.parse(`${d}T00:00:00.000Z`);
      const start = new Date(dayMs - 86_400_000).toISOString();
      const end = new Date(dayMs + 2 * 86_400_000).toISOString();
      const [raw, recoveryV2] = await Promise.all([
        client.get("/home-service/v1/deep-dive/recovery", { date: d }),
        client.get("/developer/v2/recovery", { start, end, limit: "10" }).catch(() => null),
      ]);
      const projected = projectRecovery(raw, d, recoveryV2);
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
