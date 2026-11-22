// whoop_activity_delete: replaces v1 whoop_activity_delete.
//
// Routes by the pre-read's kind (SPEC.md §4.3, §4.4): DELETE cd/v1/cardio-details
// for CARDIO/RECOVERY, DELETE cd/v2/sleep-details/{id} for sleeps and naps.
// WHOOP answers 204 even for ids that don't exist, so success is a fresh read
// that 404s, never the status code.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE, idempotent } from "../annotations.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { ActivityDeleteOut } from "../../schemas/activities.js";
import { CARDIO_DETAILS_V1, isGone, readActivity, sleepDetailsPath } from "../../lib/activity_records.js";
import { DELETE_MAIN_SLEEP_WARNING, errorResult, writeRejection } from "../../lib/activity_results.js";
import { typeForInternalName } from "../../lib/activity_types.js";

export function registerActivityDelete(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_activity_delete",
    description:
      "WRITE / DESTRUCTIVE: delete one activity, nap or sleep by activity_id (from whoop_workouts or whoop_sleep). Reads it first to " +
      "pick the right endpoint, then confirms it's gone (WHOOP answers 204 even for missing ids). Deleting a main sleep does not " +
      "restore the day's cycles. Preview unless confirm:true.",
    input: {
      activity_id: z.string().min(1),
      confirm: z.boolean().default(false),
    },
    annotations: idempotent(WRITE_DESTRUCTIVE),
  }, async ({ activity_id, confirm }) => {
    const rec = await readActivity(client, activity_id);
    if (!rec) return errorResult({ error: `No activity ${activity_id}: WHOOP says it doesn't exist (already deleted?).` });
    const scoreType = rec.score_type ?? typeForInternalName(rec.type)?.score_type ?? "CARDIO";
    const isSleep = scoreType === "SLEEP";
    const method = "DELETE";
    const path = isSleep ? sleepDetailsPath(activity_id) : CARDIO_DETAILS_V1;
    const query = isSleep ? {} : { activityId: activity_id };
    const warnings: string[] = [];
    if (rec.type === "sleep") warnings.push(DELETE_MAIN_SLEEP_WARNING);

    if (!confirm) {
      return respond("whoop_activity_delete", ActivityDeleteOut, preview(method, isSleep ? path : `${path}?activityId=${activity_id}`, {
        activity: { type: rec.type, score_type: scoreType, start: rec.start, end: rec.end },
        warnings,
      }));
    }

    try {
      await client.delete(path, query);
    } catch (e) {
      // A 404 means it's already gone; the read below confirms either way.
      if (!(e instanceof WhoopApiError && e.status === 404)) {
        const rejected = writeRejection(e, path);
        if (rejected) return rejected;
        throw e;
      }
    }
    const gone = await isGone(client, activity_id, scoreType);
    if (gone === null) warnings.push("Couldn't confirm the deletion (the read-back failed); check whoop_workouts.");
    else if (!gone) warnings.push("WHOOP still returns the activity after the delete.");
    return respond("whoop_activity_delete", ActivityDeleteOut, {
      deleted: gone === true,
      type: rec.type,
      score_type: scoreType,
      start: rec.start,
      end: rec.end,
      verified: gone === true,
      warnings,
    });
  });
}
