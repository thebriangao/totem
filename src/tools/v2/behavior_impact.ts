import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { BehaviorImpactOut } from "../../schemas/journal.js";
import { projectBehaviorImpact } from "../../projections/behavior_impact.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerBehaviorImpact(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_behavior_impact",
    "Per-behavior impact analysis: how much this behavior has historically affected your recovery, HRV, sleep.",
    {
      behavior_id: z.union([z.number().int(), z.string()]).describe("Numeric behavior_tracker_id or UUID."),
    },
    async ({ behavior_id }) => {
      const raw = await client.get(`/behavior-impact-service/v2/impact/details/${behavior_id}`);
      const projected = projectBehaviorImpact(raw, behavior_id);
      try {
        const out = BehaviorImpactOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_behavior_impact", e);
        throw e;
      }
    },
  );
}
