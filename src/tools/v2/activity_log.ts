// whoop_activity_log: replaces v1 whoop_activity_create and PR #29's
// whoop_nap_create (@k-vasily), folded into one v2 create.
//
// POST cd/v2/create-activity {activity_internal_name, start_time, end_time,
// gps_enabled[, garment_id]} takes every v2 type: CARDIO, RECOVERY, nap and sleep
// (SPEC.md §4.3, §4.4). Timestamps need milliseconds (offsets are fine).
// Read-back: cardio-details for CARDIO/RECOVERY; sleep-details for naps and
// sleeps, because cardio-details 400s while a sleep is pending.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_ADDITIVE } from "../annotations.js";
import { preview } from "../../whoop/write_safety.js";
import { get } from "../../whoop/bff.js";
import { ActivityLogOut } from "../../schemas/activities.js";
import { assertNotFuture, canonicalUtc } from "../../lib/dates.js";
import { describeType, resolveActivityTypeLive, resolveGarment } from "../../lib/activity_types.js";
import {
  CARDIO_DETAILS_V1, CREATE_PATH, readActivityAs, recordFromActivity, sameInstant, type ActivityRecord,
} from "../../lib/activity_records.js";
import { MAIN_SLEEP_WARNING, errorResult, writeRejection } from "../../lib/activity_results.js";

const MIN_DURATION_MS = 60_000;
const SLEEP_READBACK_DELAYS_MS = [0, 2_000, 5_000];

export interface ActivityToolOptions {
  /** Delay between read-back attempts (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function registerActivityLog(server: McpServer, client: WhoopClient, opts: ActivityToolOptions = {}): void {
  const sleep = opts.sleep ?? realSleep;
  defineTool(server, {
    name: "whoop_activity_log",
    description:
      "Log a past activity, nap or main sleep over start–end (≥1 min, not in the future); WHOOP scores it from strap data. type is an " +
      "internal_name (\"sauna\", \"nap\", \"sleep\"), display name or sport_id; a miss returns the closest. Overlaps are refused. A main " +
      "sleep permanently re-cuts the day's cycles. Previews unless confirm:true.",
    input: {
      type: z.string().optional(),
      sport_id: z.number().int().optional().describe("Instead of type"),
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
      gps_enabled: z.boolean().default(false),
      garment_id: z.number().int().optional().describe("Strap location id; a miss lists them"),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_ADDITIVE,
  }, async ({ type, sport_id, start, end, gps_enabled, garment_id, confirm }) => {
    if ((type === undefined) === (sport_id === undefined)) {
      return errorResult({ error: "Pass exactly one of type or sport_id." });
    }
    const resolved = await resolveActivityTypeLive(client, type ?? sport_id!);
    if (!resolved.ok) return errorResult({ error: resolved.error, suggestions: resolved.suggestions });
    const t = resolved.type;

    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (endMs - startMs < MIN_DURATION_MS) {
      return errorResult({ error: "end must be at least one minute after start." });
    }
    try {
      assertNotFuture(end, "end");
    } catch (e) {
      return errorResult({ error: (e as Error).message });
    }
    if (garment_id !== undefined) {
      const g = resolveGarment(garment_id);
      if (!g.ok) return errorResult({ error: g.error });
    }

    const body: Record<string, unknown> = {
      activity_internal_name: t.internal_name,
      start_time: canonicalUtc(startMs),
      end_time: canonicalUtc(endMs),
      gps_enabled,
    };
    if (garment_id !== undefined) body.garment_id = garment_id;
    const warnings: string[] = [];
    if (t.internal_name === "sleep") warnings.push(MAIN_SLEEP_WARNING);
    if (gps_enabled && !t.has_gps) warnings.push(`${t.name} isn't a GPS type in WHOOP's catalog; gps_enabled has no known effect.`);

    if (!confirm) {
      return respond("whoop_activity_log", ActivityLogOut, preview("POST", CREATE_PATH, {
        body,
        type: describeType(t),
        score_type: t.score_type,
        sport_id: t.sport_id,
        duration_ms: endMs - startMs,
        warnings,
      }));
    }

    let response: unknown;
    try {
      response = await client.post(CREATE_PATH, body);
    } catch (e) {
      const rejected = writeRejection(e, CREATE_PATH);
      if (rejected) return rejected;
      throw e;
    }
    const rec = recordFromActivity(response);
    if (!rec) return errorResult({ error: "WHOOP answered without an activity id; check whoop_workouts before retrying.", endpoint: CREATE_PATH });

    // Read back through the kind-specific screen (fresh). A just-created sleep
    // can take a few seconds to become readable.
    const scoreType = rec.score_type ?? t.score_type;
    const delays = scoreType === "SLEEP" ? SLEEP_READBACK_DELAYS_MS : [0, 2_000];
    let back: ActivityRecord | null = null;
    let readError: string | null = null;
    for (const delay of delays) {
      if (delay) await sleep(delay);
      try {
        back = await readActivityAs(client, rec.id, scoreType);
        readError = null;
        if (back) break;
      } catch (e) {
        readError = (e as Error).message;
      }
    }
    const typeMatches = back?.type === t.internal_name;
    const windowMatches = sameInstant(back?.start, body.start_time as string) && sameInstant(back?.end, body.end_time as string);
    if (!back) warnings.push(`Couldn't read the activity back (${readError ?? `${scoreType === "SLEEP" ? "sleep-details" : CARDIO_DETAILS_V1} said 404`}); check whoop_workouts or whoop_sleep.`);
    else if (!typeMatches) {
      warnings.push(t.internal_name === "sleep" && back.type === "nap"
        ? "WHOOP saved it as a nap, not a main sleep (the cycle probably already has a main sleep)."
        : `WHOOP shows it as ${back.type ?? "an unknown type"}, not ${t.internal_name}.`);
    } else if (!windowMatches) warnings.push(`WHOOP shows the window as ${back.start} – ${back.end}.`);
    if (scoreType !== "SLEEP" && rec.score_state === "pending") {
      warnings.push("Pending: WHOOP scores it from strap data in the window; with none it stays INCOMPLETE (strain \"---\").");
    }

    const cycleId = get(response, "activity", "cycle_id");
    const linkable = get(response, "strength_trainer_linkable");
    return respond("whoop_activity_log", ActivityLogOut, {
      created: true,
      activity_id: rec.id,
      type: rec.type,
      score_type: rec.score_type,
      start: rec.start,
      end: rec.end,
      version: rec.version,
      strength_trainer_linkable: typeof linkable === "boolean" ? linkable : null,
      cycle_id_informational: typeof cycleId === "number" ? cycleId : null,
      verified: Boolean(back && typeMatches && windowMatches),
      warnings,
    });
  });
}
