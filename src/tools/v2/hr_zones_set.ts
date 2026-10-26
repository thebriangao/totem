import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { HrZonesSetOut } from "../../schemas/settings.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { projectHrZones } from "../../projections/hr_zones.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";

export function registerHrZonesSet(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_hr_zones_set",
    "WRITE: set your heart-rate zones. mode=max_hr → pass max_hr (bpm) and Whoop recomputes the 5 zones; mode=custom → pass all 5 zones (ZONE_1..ZONE_5, each with min/max bpm).",
    {
      mode: z.enum(["max_hr", "custom"]),
      max_hr: z.number().int().positive().optional().describe("Required for mode=max_hr."),
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
    WRITE_DESTRUCTIVE,
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
        const expectedIds = ["ZONE_1", "ZONE_2", "ZONE_3", "ZONE_4", "ZONE_5"];
        for (let i = 0; i < zones.length; i++) {
          const zone = zones[i]!;
          const previous = zones[i - 1];
          if (zone.id !== expectedIds[i]) {
            return {
              content: [{ type: "text", text: jsonOut({ error: "Custom zones must contain ZONE_1 through ZONE_5 exactly once, in order." }) }],
              isError: true,
            };
          }
          if (zone.min >= zone.max) {
            return {
              content: [{ type: "text", text: jsonOut({ error: `${zone.id} must have min lower than max.` }) }],
              isError: true,
            };
          }
          if (zone.min < 0 || zone.max < 0) {
            return {
              content: [{ type: "text", text: jsonOut({ error: `${zone.id} cannot contain negative BPM values.` }) }],
              isError: true,
            };
          }
          if (previous && zone.min <= previous.max) {
            return {
              content: [{ type: "text", text: jsonOut({ error: `${zone.id} overlaps ${previous.id}; zone ranges must be ordered and non-overlapping.` }) }],
              isError: true,
            };
          }
        }
        path = "/hr-zones-service/v1/bff/custom";
        body = { zones, is_custom: true };
      }
      if (!confirm) {
        return {
          content: [{ type: "text", text: jsonOut(preview("POST", path, { mode, summary: body })) }],
        };
      }
      if (mode === "max_hr") {
        const current = projectHrZones({ zones: {}, settings: await client.get("/hr-zones-service/v1/bff/settings") });
        if (current.max_hr === max_hr) {
          const out = HrZonesSetOut.parse({ updated: false, no_change: true, mode });
          return { content: [{ type: "text", text: jsonOut(out) }] };
        }
      } else {
        const current = projectHrZones({ zones: await client.get("/hr-zones-service/v1/bff/zones"), settings: {} });
        const sameZones = current.is_custom && current.zones.length === zones!.length && current.zones.every((zone, index) =>
          zone.id === zones![index]!.id && zone.min === zones![index]!.min && zone.max === zones![index]!.max,
        );
        if (sameZones) {
          const out = HrZonesSetOut.parse({ updated: false, no_change: true, mode });
          return { content: [{ type: "text", text: jsonOut(out) }] };
        }
      }
      await client.post(path, body);
      const out = HrZonesSetOut.parse({ updated: true, no_change: false, mode });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
