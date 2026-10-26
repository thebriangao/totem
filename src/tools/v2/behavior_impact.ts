import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { BehaviorImpactOut, BehaviorImpactListOut } from "../../schemas/journal.js";
import { projectBehaviorImpact, projectBehaviorImpactList } from "../../projections/behavior_impact.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { READ_ONLY } from "../annotations.js";

export function registerBehaviorImpact(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_behavior_impact",
    "How much your tracked behaviors have historically moved recovery/HRV/sleep. Call with NO behavior_id to list every behavior with its impact_uuid + headline effect; then call again with behavior_id set to that impact_uuid (the long UUID, not a numeric id) for the full breakdown.",
    {
      behavior_id: z.string().optional().describe("An impact_uuid from the no-argument list. Omit to get that list."),
    },
    READ_ONLY,
    async ({ behavior_id }) => {
      // No id → return the discovery list (the only place impact_uuids are exposed).
      if (!behavior_id) {
        const raw = await client.get("/behavior-impact-service/v1/impact");
        try {
          const out = BehaviorImpactListOut.parse(projectBehaviorImpactList(raw));
          return { content: [{ type: "text", text: jsonOut(out) }] };
        } catch (e) {
          if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_behavior_impact", e);
          throw e;
        }
      }
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
