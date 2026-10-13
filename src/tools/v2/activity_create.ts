import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { ActivityCreateOut } from "../../schemas/workouts.js";
import { preview, writeRejected } from "../../whoop/write_safety.js";
import { WhoopApiError, WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { SPORTS_BY_ID, SPORTS_BY_NAME } from "../../data/sports.js";
import { canonicalUtc } from "../../lib/dates.js";

const PATH = "/core-details-bff/v0/create-activity";

export function registerActivityCreate(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_activity_create",
    "WRITE: log a generic off-strap activity over a start–end window of at least 1 minute. Pass a sport_id or an exact sport name; preview unless confirm:true.",
    {
      sport_id: z.number().int().optional().describe("Numeric sport ID."),
      sport: z.string().optional().describe("Exact sport name, case-insensitive (for example 'Running')."),
      start: z.iso.datetime({ offset: true }).describe("ISO-8601 datetime with offset; automatically normalized to UTC."),
      end: z.iso.datetime({ offset: true }).describe("ISO-8601 datetime with offset; automatically normalized to UTC."),
      gps_enabled: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    async ({ sport_id, sport: sportName, start, end, gps_enabled, confirm }) => {
      const sport = sport_id !== undefined
        ? SPORTS_BY_ID.get(sport_id)
        : sportName ? SPORTS_BY_NAME.get(sportName.trim().toLowerCase()) : undefined;
      if (!sport) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Provide a valid sport_id or exact sport name. Use whoop_sports_catalog to browse options." }) }],
          isError: true,
        };
      }
      const durationMs = Date.parse(end) - Date.parse(start);
      if (!Number.isFinite(durationMs) || durationMs < 60_000) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Activity end must be at least one minute after start." }) }],
          isError: true,
        };
      }
      // The undocumented create endpoint rejects offset-form timestamps even
      // though its read endpoints return them. Canonical UTC is accepted.
      const startTime = canonicalUtc(start);
      const endTime = canonicalUtc(end);
      const body = { sport_id: sport.id, start_time: startTime, end_time: endTime, gps_enabled };
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("POST", PATH, {
                  sport_id: sport.id,
                  sport_name: sport.name,
                  start,
                  end,
                  sent_start_utc: startTime,
                  sent_end_utc: endTime,
                  duration_ms: durationMs,
                }),
              ),
            },
          ],
        };
      }
      let receipt: { id: string; cycle_id: number; sport_id?: number; start?: string; end?: string };
      try {
        receipt = await client.post(PATH, body);
      } catch (error) {
        if (error instanceof WhoopApiError) {
          return writeRejected("activity", PATH, error,
            "Start and end were sent as canonical UTC timestamps. Check the activity window, sport, and any WHOOP account restrictions.");
        }
        throw error;
      }
      const projected = {
        created: true as const,
        activity_id: receipt.id,
        cycle_id: receipt.cycle_id,
        start: receipt.start ?? startTime,
        end: receipt.end ?? endTime,
        sport_id: receipt.sport_id ?? sport.id,
      };
      try {
        const out = ActivityCreateOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_activity_create", e);
        throw e;
      }
    },
  );
}
