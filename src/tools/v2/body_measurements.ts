import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { BodyMeasurementsOut } from "../../schemas/body.js";
import { BODY_READINGS_PATH, projectBodyMeasurements } from "../../projections/body_measurements.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerBodyMeasurements(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_body_measurements",
    "Every recorded weight / body-composition reading (manual, Apple Health, Withings…): id, timestamp, weight kg, body fat %, lean body mass kg, source. Use the id with whoop_body_measurement_delete; a non-null next_token means WHOOP has older readings than these.",
    {},
    async () => {
      const projected = projectBodyMeasurements(await client.get(BODY_READINGS_PATH));
      try {
        const out = BodyMeasurementsOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_body_measurements", e);
        throw e;
      }
    },
  );
}
