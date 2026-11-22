// whoop_activity_edit: replaces v1 whoop_sleep_edit and adds cardio/recovery edits.
//
// Routes (SPEC.md §4.3, §4.4, D5, §7 S15–S18):
// - CARDIO/RECOVERY (window and/or type, CARDIO↔RECOVERY allowed):
//     PUT cd/v2/cardio-details?activityId= {start_time, end_time, activity_internal_name[, garment_id]}
// - nap → main sleep: the same cardio-details PUT with activity_internal_name "sleep".
// - sleep/nap window: PUT cd/v2/sleep-details/{id} {start_time, end_time[, resolve_overlaps]}.
//   resolve_overlaps DELETES the overlapped activities (it doesn't trim them), so
//   totem only sends it when the caller lists exactly the ids that will go.
// - sleep → nap is refused by WHOOP silently; totem refuses it up front.
// After every write: fresh read-back of the type and window. A main sleep that
// comes back as a nap is repaired once via the cardio-details PUT.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopConflictError } from "../../whoop/errors.js";
import { get, str } from "../../whoop/bff.js";
import { ActivityEditOut } from "../../schemas/activities.js";
import { assertNotFuture, canonicalUtc } from "../../lib/dates.js";
import { describeType, resolveActivityTypeLive, resolveGarment, typeForInternalName } from "../../lib/activity_types.js";
import {
  CARDIO_DETAILS_V2, isGone, readActivity, readActivityAs, recordFromActivity, sameInstant, sleepDetailsPath,
  toUtc, type ActivityRecord,
} from "../../lib/activity_records.js";
import { overlappingTiles, type ActivityTile } from "../../lib/activity_list.js";
import { DELETE_MAIN_SLEEP_WARNING, NAP_TO_SLEEP_WARNING, errorResult, writeRejection } from "../../lib/activity_results.js";
import type { ScoreType } from "../../data/sports.js";

const LAST_NIGHT_PATH = "/home-service/v1/deep-dive/sleep/last-night";
const MIN_DURATION_MS = 60_000;

function describeTile(t: ActivityTile): string {
  return `${t.activity_id} ${t.internal_name ?? t.title ?? "activity"} ${t.start ?? "?"} – ${t.end ?? "?"}`;
}

const sameSet = (a: string[], b: string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

export function registerActivityEdit(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_activity_edit",
    description:
      "WRITE / DESTRUCTIVE: change an activity's start/end or type (CARDIO↔RECOVERY, nap→main sleep), or a sleep/nap's window " +
      "(`activity_id`, or `sleep_date` for that day's main sleep). Omitted bounds keep their value. A sleep window that overlaps " +
      "others needs `delete_overlapping` = exactly the ids the preview lists, and WHOOP then DELETES them. The type is read " +
      "back; a main sleep demoted to a nap is repaired. Preview unless confirm:true.",
    input: {
      activity_id: z.string().min(1).optional(),
      sleep_date: z.iso.date().optional().describe("Instead of activity_id: the cycle day whose main sleep to edit."),
      start: z.iso.datetime({ offset: true }).optional().describe("New start, ISO-8601 with offset."),
      end: z.iso.datetime({ offset: true }).optional().describe("New end, ISO-8601 with offset; not in the future."),
      type: z.string().optional().describe("New type: internal_name, display name or sport_id."),
      garment_id: z.number().int().optional().describe("Strap location (activities only)."),
      delete_overlapping: z.array(z.string().min(1)).optional()
        .describe("Sleep/nap edits: the preview's overlapping ids, which WHOOP will delete."),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async ({ activity_id, sleep_date, start, end, type, garment_id, delete_overlapping, confirm }) => {
    if ((activity_id === undefined) === (sleep_date === undefined)) {
      return errorResult({ error: "Pass exactly one of activity_id or sleep_date." });
    }
    if (!start && !end && type === undefined && garment_id === undefined && !delete_overlapping?.length) {
      return errorResult({ error: "Nothing to change: pass start, end, type or garment_id." });
    }
    try {
      if (start) assertNotFuture(start, "start");
      if (end) assertNotFuture(end, "end");
    } catch (e) {
      return errorResult({ error: (e as Error).message });
    }
    if (garment_id !== undefined) {
      const g = resolveGarment(garment_id);
      if (!g.ok) return errorResult({ error: g.error });
    }
    let newType: { internal_name: string; score_type: ScoreType; name: string } | null = null;
    if (type !== undefined) {
      const r = await resolveActivityTypeLive(client, type);
      if (!r.ok) return errorResult({ error: r.error, suggestions: r.suggestions });
      newType = r.type;
    }

    // ── Pre-read (fresh) ──
    let id = activity_id;
    if (sleep_date) {
      const lastNight = await client.get(LAST_NIGHT_PATH, { date: sleep_date }, { fresh: true });
      id = str(get(lastNight, "header_section", "destination", "parameters", "activity_id")) ?? undefined;
      if (!id) return errorResult({ error: `No main sleep found for ${sleep_date}.`, hint: "Naps aren't listed by day here: pass their activity_id (whoop_sleep or whoop_workouts with types [SLEEP])." });
    }
    const activityId = id!;
    const before = await readActivity(client, activityId);
    if (!before) return errorResult({ error: `No activity ${activityId}: WHOOP says it doesn't exist.` });
    const beforeScore: ScoreType | null = before.score_type ?? typeForInternalName(before.type)?.score_type ?? null;
    if (!before.type) return errorResult({ error: `Couldn't read ${activityId}'s current type from WHOOP; not editing blind.` });
    if ((!start && !before.start) || (!end && !before.end)) {
      return errorResult({ error: "Couldn't read the current window; pass both start and end." });
    }
    const newStart = canonicalUtc(start ?? before.start!);
    const newEnd = canonicalUtc(end ?? before.end!);
    const windowSame = sameInstant(newStart, before.start) && sameInstant(newEnd, before.end);
    if (Date.parse(newEnd) <= Date.parse(newStart)) return errorResult({ error: `end (${newEnd}) must be after start (${newStart}).` });
    if (!windowSame && Date.parse(newEnd) - Date.parse(newStart) < MIN_DURATION_MS) {
      return errorResult({ error: "The new window must be at least one minute long." });
    }

    // ── Route ──
    const targetType = newType?.internal_name ?? before.type;
    const targetScore: ScoreType = newType?.score_type ?? beforeScore ?? "CARDIO";
    const typeChanged = targetType !== before.type;
    const warnings: string[] = [];
    let route: "cardio-details" | "sleep-details";
    if (beforeScore === "SLEEP") {
      if (typeChanged) {
        if (before.type === "nap" && targetType === "sleep") {
          route = "cardio-details";
          warnings.push(NAP_TO_SLEEP_WARNING);
        } else if (before.type === "sleep" && targetType === "nap") {
          return errorResult({ error: "WHOOP doesn't turn a main sleep into a nap: it answers 200 and keeps it a sleep. Delete it and log a nap instead." });
        } else {
          return errorResult({ error: `Changing a ${before.type} into ${targetType} isn't supported. Delete it (whoop_activity_delete) and log the new one (whoop_activity_log).` });
        }
        if (delete_overlapping?.length) return errorResult({ error: "delete_overlapping only applies to sleep/nap window edits without a type change." });
      } else {
        route = "sleep-details";
        if (garment_id !== undefined) warnings.push("garment_id is ignored for sleep and nap windows.");
      }
    } else {
      if (targetScore === "SLEEP") {
        return errorResult({ error: `Turning a ${before.type} into a ${targetType} isn't supported. Delete it and log the ${targetType} with whoop_activity_log.` });
      }
      if (delete_overlapping?.length) {
        return errorResult({ error: "delete_overlapping only applies to sleep/nap window edits; WHOOP refuses overlapping workout edits (409) and deletes nothing." });
      }
      route = "cardio-details";
    }

    const beforeOut = { type: before.type, score_type: beforeScore, start: before.start, end: before.end };
    const garmentChange = garment_id !== undefined && route === "cardio-details";
    if (windowSame && !typeChanged && !garmentChange && !delete_overlapping?.length) {
      return respond("whoop_activity_edit", ActivityEditOut, {
        edited: false, no_change: true, activity_id: activityId, before: beforeOut,
        after: { ...beforeOut, version: before.version }, deleted_overlapping: [], verified: true, warnings,
      });
    }

    // ── Overlaps (sleep windows: resolve_overlaps deletes, so it is gated on an exact id list) ──
    let overlapping: ActivityTile[] = [];
    let resolve = false;
    if (route === "sleep-details") {
      const found = await overlappingTiles(client, newStart, newEnd, activityId);
      overlapping = found.tiles;
      if (delete_overlapping?.length) {
        if (!found.complete) return errorResult({ error: "Couldn't read every day around the new window, so the overlap list can't be confirmed. Nothing was changed; try again." });
        if (!overlapping.length) return errorResult({ error: "Nothing overlaps the new window now; drop delete_overlapping." });
        if (!sameSet(delete_overlapping, overlapping.map((t) => t.activity_id))) {
          return errorResult({
            error: "delete_overlapping must list exactly the activities WHOOP would delete. Nothing was changed.",
            would_delete: overlapping.map(describeTile),
          });
        }
        resolve = true;
      } else if (overlapping.length) {
        warnings.push(`The new window overlaps ${overlapping.length} activit${overlapping.length === 1 ? "y" : "ies"} (listed). WHOOP will refuse (409) unless delete_overlapping lists exactly these ids, and then it DELETES them; it never trims.`);
      }
      if (overlapping.some((t) => t.internal_name === "sleep")) warnings.push(DELETE_MAIN_SLEEP_WARNING);
    }

    const path = route === "sleep-details" ? sleepDetailsPath(activityId) : CARDIO_DETAILS_V2;
    const query: Record<string, string> = route === "sleep-details" ? {} : { activityId };
    const body: Record<string, unknown> = { start_time: newStart, end_time: newEnd };
    if (route === "cardio-details") {
      body.activity_internal_name = targetType;
      if (garment_id !== undefined) body.garment_id = garment_id;
    } else if (resolve) {
      body.resolve_overlaps = true;
    }

    if (!confirm) {
      return respond("whoop_activity_edit", ActivityEditOut, preview("PUT", route === "sleep-details" ? path : `${path}?activityId=${activityId}`, {
        body,
        before: beforeOut,
        after: { type: targetType, score_type: targetScore, start: newStart, end: newEnd },
        new_type: newType ? describeType(newType) : null,
        overlapping: overlapping.map(describeTile),
        will_delete: resolve ? overlapping.map(describeTile) : [],
        warnings,
      }));
    }

    // ── Send ──
    let response: unknown;
    try {
      response = await client.put(path, body, query);
    } catch (e) {
      let fallback: string[] = overlapping.map(describeTile);
      if (e instanceof WhoopConflictError && !fallback.length && route === "cardio-details") {
        fallback = await overlappingTiles(client, newStart, newEnd, activityId).then((r) => r.tiles.map(describeTile)).catch(() => []);
      }
      const rejected = writeRejection(e, path, fallback);
      if (rejected) return rejected;
      throw e;
    }
    let after: ActivityRecord | null = recordFromActivity(response);

    // ── Read back (fresh), repairing a demoted main sleep once ──
    const readBack = async (): Promise<ActivityRecord | null> => {
      try {
        return await readActivityAs(client, activityId, targetScore);
      } catch (e) {
        warnings.push(`Read-back failed: ${(e as Error).message}`);
        return null;
      }
    };
    let back = await readBack();
    let repaired = false;
    if (route === "sleep-details" && targetType === "sleep" && (after?.type === "nap" || back?.type === "nap")) {
      try {
        const fixed = await client.put(CARDIO_DETAILS_V2, { activity_internal_name: "sleep", start_time: newStart, end_time: newEnd }, { activityId });
        after = recordFromActivity(fixed) ?? after;
        repaired = true;
        warnings.push("WHOOP demoted the main sleep to a nap after the edit; totem converted it back to a sleep.");
      } catch (e) {
        warnings.push(`WHOOP demoted the main sleep to a nap and the repair failed (${(e as Error).message}). Retry with type "sleep".`);
      }
      back = await readBack();
    }

    const deleted: string[] = [];
    if (resolve) {
      for (const t of overlapping) {
        const kind: ScoreType = t.score_type === "SLEEP" || t.score_type === "RECOVERY" ? t.score_type : "CARDIO";
        if (await isGone(client, t.activity_id, kind)) deleted.push(t.activity_id);
        else warnings.push(`${t.activity_id} still exists after resolve_overlaps.`);
      }
    }

    const afterType = back?.type ?? after?.type ?? null;
    const afterStart = back?.start ?? after?.start ?? null;
    const afterEnd = back?.end ?? after?.end ?? null;
    if (back && back.type !== targetType) warnings.push(`WHOOP shows the type as ${back.type ?? "unknown"}, not ${targetType}.`);
    if (back && !(sameInstant(afterStart, newStart) && sameInstant(afterEnd, newEnd))) warnings.push(`WHOOP shows the window as ${afterStart} – ${afterEnd}.`);
    const verified = Boolean(back) && afterType === targetType && sameInstant(afterStart, newStart) && sameInstant(afterEnd, newEnd) &&
      deleted.length === (resolve ? overlapping.length : 0);
    return respond("whoop_activity_edit", ActivityEditOut, {
      edited: true,
      activity_id: activityId,
      before: beforeOut,
      after: {
        type: afterType,
        score_type: back?.score_type ?? after?.score_type ?? targetScore,
        start: toUtc(afterStart),
        end: toUtc(afterEnd),
        version: after?.version ?? null,
      },
      ...(repaired ? { repaired: true as const } : {}),
      deleted_overlapping: deleted,
      verified,
      warnings,
    });
  });
}
