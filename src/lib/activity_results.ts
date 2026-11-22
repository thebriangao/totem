// Small result helpers shared by the activity tools.
import type { ToolResult } from "../tools/define.js";
import { jsonOut } from "../whoop/json_out.js";
import { WhoopApiError, WhoopConflictError } from "../whoop/errors.js";
import { overlapDescriptions } from "./activity_records.js";

export const MAIN_SLEEP_WARNING =
  "Main sleep: WHOOP re-cuts the day's cycles around it (cycle boundaries and every later activity's cycle_id change), and deleting the sleep later does not undo that.";
export const NAP_TO_SLEEP_WARNING =
  "Converting a nap to a main sleep re-cuts the day's cycles (cycle boundaries and later activities' cycle_id change) permanently.";
export const DELETE_MAIN_SLEEP_WARNING =
  "Deleting a main sleep does not restore the cycles it created: the cycle keeps its start and goes back to 'add sleep'.";

/** A model-facing error result (isError) carrying structured fields. */
export function errorResult(body: { error: string } & Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: jsonOut(body) }], isError: true };
}

/**
 * Map a WHOOP write rejection to an actionable error. Returns null for anything
 * that isn't a WhoopApiError (let it propagate). `overlapFallback` lists what a
 * home-card check found when WHOOP's 409 names nothing (edit 409s are empty).
 */
export function writeRejection(e: unknown, endpoint: string, overlapFallback: string[] = []): ToolResult | null {
  if (e instanceof WhoopConflictError) {
    const listed = overlapDescriptions(e);
    return errorResult({
      error: "WHOOP refused: the window overlaps existing activities (409). Nothing was changed.",
      status: 409,
      endpoint,
      overlapping_activities: listed.length ? listed : overlapFallback,
      hint: "Pick a window that doesn't overlap, or move/delete the other activity first (whoop_activity_edit / whoop_activity_delete). WHOOP never merges or trims on a 409.",
    });
  }
  if (e instanceof WhoopApiError) {
    const hints: Record<number, string> = {
      400: "WHOOP rejected the values (window, type or timestamp format).",
      404: "WHOOP says the activity doesn't exist (deleted?). List current ones with whoop_workouts.",
      412: "WHOOP is recomputing this day (another write is in flight). Try again in a minute.",
      422: "WHOOP rejected the request shape (missing field).",
    };
    return errorResult({
      error: `WHOOP rejected the request (${e.status}).`,
      status: e.status,
      endpoint,
      reason: e.message,
      hint: hints[e.status] ?? null,
    });
  }
  return null;
}
