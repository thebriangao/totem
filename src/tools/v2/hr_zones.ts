import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { HrZonesOut } from "../../schemas/settings.js";
import { projectHrZones } from "../../projections/hr_zones.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerHrZones(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_hr_zones",
    "Current heart-rate zones + max HR + last updated.",
    {},
    async () => {
      const [zones, settings] = await Promise.all([
        client.get("/hr-zones-service/v1/bff/zones").catch(() => null),
        client.get("/hr-zones-service/v1/bff/settings").catch(() => null),
      ]);
      const projected = projectHrZones({ zones, settings });
      try {
        const out = HrZonesOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_hr_zones", e);
        throw e;
      }
    },
  );
}
