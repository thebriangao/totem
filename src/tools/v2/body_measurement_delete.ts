import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { BodyMeasurementDeleteOut } from "../../schemas/body.js";
import { BODY_READINGS_PATH } from "../../projections/body_measurements.js";
import { preview, writeRejected } from "../../whoop/write_safety.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerBodyMeasurementDelete(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_body_measurement_delete",
    "WRITE / DESTRUCTIVE: delete one weight / body-composition reading by id (from whoop_body_measurements). Preview unless confirm:true.",
    {
      reading_id: z.string().min(1),
      confirm: z.boolean().default(false),
    },
    async ({ reading_id, confirm }) => {
      const path = `${BODY_READINGS_PATH}/${encodeURIComponent(reading_id)}`;
      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview("DELETE", path, { reading_id })) }] };
      }
      try {
        await client.delete(path);
      } catch (error) {
        if (error instanceof WhoopApiError) return writeRejected("deletion", path, error);
        throw error;
      }
      const out = BodyMeasurementDeleteOut.parse({ deleted: true, reading_id });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
