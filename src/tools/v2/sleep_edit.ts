import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { SleepEditOut } from "../../schemas/sleep.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { canonicalUtc, todayIso } from "../../lib/dates.js";
import { isObject, asString } from "../../lib/walk.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";

// The sleep's activity_id + current window live at
// header_section.destination.parameters of the deep-dive (same source projectSleep reads).
export function sleepActivity(raw: unknown): { activityId: string | null; start: string | null; end: string | null } {
  const header = isObject(raw) ? raw.header_section : null;
  const dest = isObject(header) ? header.destination : null;
  const params = isObject(dest) && isObject(dest.parameters) ? dest.parameters : {};
  return {
    activityId: asString(params.activity_id),
    start: asString(params.start_time),
    end: asString(params.end_time),
  };
}

export function registerSleepEdit(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_sleep_edit",
    "WRITE: change a sleep's start and/or end time. Resolves the sleep's activity_id from `date` (default today); pass start and/or end (ISO-8601, any offset — sent as UTC), an omitted bound keeps the current value. Set resolve_overlaps:true if the new window overlaps an adjacent sleep/nap. Preview unless confirm:true.",
    {
      date: z.iso.date().optional(),
      start: z.iso.datetime({ offset: true }).optional(),
      end: z.iso.datetime({ offset: true }).optional(),
      resolve_overlaps: z.boolean().optional(),
      confirm: z.boolean().default(false),
    },
    WRITE_DESTRUCTIVE,
    async ({ date, start, end, resolve_overlaps, confirm }) => {
      const d = date ?? todayIso();
      if (!start && !end) {
        return { content: [{ type: "text", text: jsonOut({ error: "Provide at least one of start/end (ISO-8601 datetime)." }) }], isError: true };
      }

      // Resolve the sleep + its current window so an omitted bound is preserved.
      const sleep = sleepActivity(await client.get("/home-service/v1/deep-dive/sleep/last-night", { date: d }));
      if (!sleep.activityId) {
        return { content: [{ type: "text", text: jsonOut({ error: `No sleep found for ${d}.` }) }], isError: true };
      }

      const startSrc = start ?? sleep.start;
      const endSrc = end ?? sleep.end;
      const startMs = startSrc ? Date.parse(startSrc) : NaN;
      const endMs = endSrc ? Date.parse(endSrc) : NaN;
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        return { content: [{ type: "text", text: jsonOut({ error: "Need a full window with end after start." }) }], isError: true };
      }

      // The app sends the window in UTC; toISOString() produces that exact format.
      const startTime = canonicalUtc(startMs);
      const endTime = canonicalUtc(endMs);
      const path = `/core-details-bff/v2/sleep-details/${sleep.activityId}`;
      const body: Record<string, unknown> = { start_time: startTime, end_time: endTime };
      if (resolve_overlaps !== undefined) body.resolve_overlaps = resolve_overlaps;

      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview("PUT", path, body)) }] };
      }

      const currentStart = sleep.start ? canonicalUtc(sleep.start) : null;
      const currentEnd = sleep.end ? canonicalUtc(sleep.end) : null;
      if (startTime === currentStart && endTime === currentEnd && !resolve_overlaps) {
        const out = SleepEditOut.parse({ edited: false, no_change: true, activity_id: sleep.activityId, start: startTime, end: endTime });
        return { content: [{ type: "text", text: jsonOut(out) }] };
      }

      await client.put(path, body);
      const out = SleepEditOut.parse({ edited: true, no_change: false, activity_id: sleep.activityId, start: startTime, end: endTime });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
