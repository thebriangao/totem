import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftPrsOut } from "../../schemas/strength.js";
import { projectLiftPrs } from "../../projections/lift_prs.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerLiftPrs(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_prs",
    "All Strength Trainer personal records: per-exercise top weight, units, date, medal.",
    {},
    async () => {
      const raw = await client.get("/weightlifting-service/v3/prs");
      const projected = projectLiftPrs(raw);
      try {
        const out = LiftPrsOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_prs", e);
        throw e;
      }
    },
  );
}
