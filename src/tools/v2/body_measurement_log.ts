import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { BodyMeasurementLogOut } from "../../schemas/body.js";
import { BODY_READINGS_PATH } from "../../projections/body_measurements.js";
import { preview, writeRejected } from "../../whoop/write_safety.js";
import { WhoopApiError, WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { fatFractionToPercent } from "../../lib/format.js";
import { buildMeasurementBody, type MeasurementBody } from "../../whoop/build_measurement_body.js";
import { toLocalIso } from "../../lib/timezone.js";

export function registerBodyMeasurementLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_body_measurement_log",
    "WRITE: add a reading to the Weight and Lean Body Mass trends — weight, plus body fat % or lean body mass (other derived). Kilograms only. Separate from the profile weight (whoop_profile_update). The app keeps one reading per day, so a same-day reading may be replaced — check whoop_body_measurements first. Preview unless confirm:true.",
    {
      weight_kg: z.number().positive().describe("Body weight in kilograms."),
      lean_body_mass_kg: z.number().positive().optional().describe("Lean body mass in kilograms."),
      body_fat_percent: z.number().gt(0).lt(100).optional().describe("Body fat as a percentage, e.g. 18.5."),
      timestamp: z.iso.datetime({ offset: true }).optional().describe("When it was measured, ISO-8601 with offset. Defaults to now; sent in your local offset."),
      confirm: z.boolean().default(false),
    },
    async ({ weight_kg, lean_body_mass_kg, body_fat_percent, timestamp, confirm }) => {
      let body: MeasurementBody;
      try {
        body = buildMeasurementBody({
          // The app sends local wall-clock time with its offset; toLocalIso leaves non-UTC input as given.
          timestamp: toLocalIso(timestamp ?? new Date().toISOString()),
          weight_kg,
          lean_body_mass_kg,
          body_fat_percent,
        });
      } catch (e) {
        return { content: [{ type: "text", text: jsonOut({ error: (e as Error).message }) }], isError: true };
      }
      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview("POST", BODY_READINGS_PATH, body)) }] };
      }
      try {
        await client.post(BODY_READINGS_PATH, body);
      } catch (error) {
        if (error instanceof WhoopApiError) return writeRejected("measurement", BODY_READINGS_PATH, error);
        throw error;
      }
      try {
        const out = BodyMeasurementLogOut.parse({
          logged: true,
          timestamp: body.timestamp,
          weight_kg: body.weight_kg,
          body_fat_percent: body.body_fat_percent === null ? null : fatFractionToPercent(body.body_fat_percent),
          lean_body_mass_kg: body.lean_body_mass_kg,
        });
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_body_measurement_log", e);
        throw e;
      }
    },
  );
}
