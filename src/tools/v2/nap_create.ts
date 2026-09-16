import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { NapCreateOut } from "../../schemas/workouts.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopApiError, WhoopProjectionError, apiErrorDetail } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { canonicalUtc } from "../../lib/dates.js";
import { isObject, asString } from "../../lib/walk.js";

// Naps (and back-filled main sleeps) are sleep-category activities that carry no
// numeric sport_id, so the v0 create-activity path (sport_id-only) cannot make
// them. The app creates them through the v2 endpoint, which takes the activity's
// `activity_internal_name` string instead of a sport_id. Confirmed live 2026-09-08:
// POST {activity_internal_name:"nap", start_time, end_time, gps_enabled:false}
// returns 200 with a nap receipt; the same body with internal_name/activity_type
// (the wrong field names) 422s. WHOOP then scores the window from already-recorded
// strap data, exactly as when you add a nap in the app.
const PATH = "/core-details-bff/v2/create-activity";

// title_bar.title_display of the cardio-details read for the created activity,
// used to prove the write landed as the right kind of activity.
function readBackTitle(raw: unknown): string | null {
  const titleBar = isObject(raw) ? raw.title_bar : null;
  return isObject(titleBar) ? asString(titleBar.title_display) : null;
}

export function registerNapCreate(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_nap_create",
    "WRITE: log a nap (default) or a back-filled main sleep over a start–end window of at least 1 minute; WHOOP scores it from recorded strap data. Set nap:false for a main sleep. Times are ISO-8601 with offset, normalized to UTC. Preview unless confirm:true.",
    {
      start: z.iso.datetime({ offset: true }).describe("ISO-8601 datetime with offset; automatically normalized to UTC."),
      end: z.iso.datetime({ offset: true }).describe("ISO-8601 datetime with offset; automatically normalized to UTC."),
      nap: z.boolean().default(true).describe("true (default) logs a nap; false logs a main sleep."),
      confirm: z.boolean().default(false),
    },
    async ({ start, end, nap, confirm }) => {
      const durationMs = Date.parse(end) - Date.parse(start);
      if (!Number.isFinite(durationMs) || durationMs < 60_000) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Nap end must be at least one minute after start." }) }],
          isError: true,
        };
      }
      // The create endpoint rejects offset-form timestamps even though its read
      // endpoints return them. Canonical UTC is accepted.
      const startTime = canonicalUtc(start);
      const endTime = canonicalUtc(end);
      const internalName = nap ? "nap" : "sleep";
      const body = { activity_internal_name: internalName, start_time: startTime, end_time: endTime, gps_enabled: false };
      if (!confirm) {
        return {
          content: [{
            type: "text",
            text: jsonOut(preview("POST", PATH, {
              activity_internal_name: internalName,
              start,
              end,
              sent_start_utc: startTime,
              sent_end_utc: endTime,
              duration_ms: durationMs,
            })),
          }],
        };
      }

      let receipt: unknown;
      try {
        receipt = await client.post(PATH, body);
      } catch (error) {
        if (error instanceof WhoopApiError) {
          return {
            content: [{ type: "text", text: jsonOut({
              error: `WHOOP rejected the ${internalName}.`,
              status: error.status,
              endpoint: PATH,
              reason: apiErrorDetail(error.body) ?? null,
              hint: "Start and end were sent as canonical UTC timestamps. Check the window and that it does not overlap an existing sleep/nap.",
            }) }],
            isError: true,
          };
        }
        throw error;
      }

      // The receipt nests the activity under `activity`.
      const activity = isObject(receipt) && isObject(receipt.activity) ? receipt.activity : {};
      const activityId = asString(activity.id);
      if (!activityId) {
        return {
          content: [{ type: "text", text: jsonOut({
            error: "WHOOP returned a create receipt without an activity id.",
            endpoint: PATH,
          }) }],
          isError: true,
        };
      }

      // Prove the write landed by reading the activity back. The developer
      // sleep-collection only surfaces SCORED records and lags a fresh create, so
      // the internal cardio-details read is the immediate source of truth. A
      // just-created activity is not queryable for a second or two (the read 404s),
      // so retry a few times before giving up.
      let verified = false;
      for (let attempt = 0; attempt < 4 && !verified; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
        try {
          const back = await client.get("/core-details-bff/v1/cardio-details", { activityId });
          verified = readBackTitle(back)?.toUpperCase() === internalName.toUpperCase();
        } catch {
          // 404 while the activity is still propagating — retry.
        }
      }

      const projected = {
        created: true as const,
        activity_id: activityId,
        cycle_id: typeof activity.cycle_id === "number" ? activity.cycle_id : 0,
        start: startTime,
        end: endTime,
        type: asString(activity.type) ?? internalName,
        score_state: asString(activity.score_state) ?? "pending",
        verified,
      };
      try {
        const out = NapCreateOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_nap_create", e);
        throw e;
      }
    },
  );
}
