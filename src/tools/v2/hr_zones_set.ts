import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { HrZonesSetOut } from "../../schemas/settings.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerHrZonesSet(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_hr_zones_set",
    "WRITE: set max HR (auto-computes zones) OR set custom zones.",
    {
      mode: z.enum(["max_hr", "custom"]),
      max_hr: z.number().int().optional().describe("Required for mode=max_hr."),
      zones: z
        .array(z.object({
          id: z.enum(["ZONE_1", "ZONE_2", "ZONE_3", "ZONE_4", "ZONE_5"]),
          min: z.number().int(),
          max: z.number().int(),
        }))
        .optional()
        .describe("Required for mode=custom. Must be 5 entries."),
      confirm: z.boolean().default(false),
    },
    async ({ mode, max_hr, zones, confirm }) => {
      let path: string;
      let body: unknown;
      if (mode === "max_hr") {
        if (max_hr === undefined) {
          return {
            content: [{ type: "text", text: jsonOut({ error: "mode=max_hr requires max_hr" }) }],
            isError: true,
          };
        }
        path = "/hr-zones-service/v1/maxhr";
        body = { max_heart_rate: max_hr };
      } else {
        if (!zones || zones.length !== 5) {
          return {
            content: [{ type: "text", text: jsonOut({ error: "mode=custom requires exactly 5 zones" }) }],
            isError: true,
          };
        }
        path = "/hr-zones-service/v1/bff/custom";
        body = { zones, is_custom: true };
      }
      if (!confirm) {
        return {
          content: [{ type: "text", text: jsonOut(preview("POST", path, { mode, summary: body })) }],
        };
      }
      await client.post(path, body);
      const out = HrZonesSetOut.parse({ updated: true as const, mode });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
