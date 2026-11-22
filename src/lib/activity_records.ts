// Reading one activity back from WHOOP, whatever its kind, for the activity
// write tools' pre-reads and read-backs (SPEC.md §4.3, §4.4).
//
// - The shared record (create/edit responses, GET /activities-service/v2/activities/{id})
//   carries type, score_type, during, version and score_state.
// - SLEEP (sleep, nap) reads go to GET cd/v2/sleep-details/{id}: cardio-details
//   400s while a sleep is pending. `nap_to_sleep_available` tells nap from sleep.
// - CARDIO/RECOVERY reads go to GET cd/v1/cardio-details (200 in every state).
// Every read here is fresh: pre-reads and read-backs must never see the cache.
import type { WhoopClient } from "../whoop/client.js";
import { WhoopApiError, WhoopConflictError } from "../whoop/errors.js";
import { get, str } from "../whoop/bff.js";
import { parsePgRange } from "./dates.js";
import { typeForInternalName } from "./activity_types.js";
import type { ScoreType } from "../data/sports.js";

export const CREATE_PATH = "/core-details-bff/v2/create-activity";
export const CARDIO_DETAILS_V1 = "/core-details-bff/v1/cardio-details";
export const CARDIO_DETAILS_V2 = "/core-details-bff/v2/cardio-details";
export const RECOVERY_DETAILS_V2 = "/core-details-bff/v2/recovery-details";
export const sleepDetailsPath = (id: string): string => `/core-details-bff/v2/sleep-details/${encodeURIComponent(id)}`;
export const activityRecordPath = (id: string): string => `/activities-service/v2/activities/${encodeURIComponent(id)}`;

export interface ActivityRecord {
  id: string;
  /** internal_name ("boxing", "nap", "sleep"). */
  type: string | null;
  score_type: ScoreType | null;
  start: string | null;
  end: string | null;
  version: number | null;
  score_state: string | null;
  /** Which read produced it. */
  source: "record" | "sleep-details" | "cardio-details";
}

const SCORE_TYPES = new Set(["CARDIO", "RECOVERY", "SLEEP"]);
const asScoreType = (v: unknown): ScoreType | null => (typeof v === "string" && SCORE_TYPES.has(v) ? (v as ScoreType) : null);

/** ISO with milliseconds in UTC, or null. Accepts WHOOP's "+0000" offsets. */
export function toUtc(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return Date.parse(a) === Date.parse(b);
}

/** Parse the shared activity record (bare, or wrapped as `{activity:{…}}`). */
export function recordFromActivity(raw: unknown): ActivityRecord | null {
  const node = (get(raw, "activity") ?? raw) as Record<string, unknown> | undefined;
  const id = str(get(node, "id"));
  if (!id) return null;
  let start: string | null = null;
  let end: string | null = null;
  const during = str(get(node, "during"));
  if (during) {
    try {
      const r = parsePgRange(during);
      start = toUtc(r.start);
      end = toUtc(r.end);
    } catch {
      // Unparseable range: leave the window unknown.
    }
  }
  const type = str(get(node, "type"));
  const version = get(node, "version");
  return {
    id,
    type,
    score_type: asScoreType(get(node, "score_type")) ?? typeForInternalName(type)?.score_type ?? null,
    start,
    end,
    version: typeof version === "number" ? version : null,
    score_state: str(get(node, "score_state")),
    source: "record",
  };
}

/** GET cd/v2/sleep-details/{id} → nap or sleep with its window. */
export function recordFromSleepDetails(raw: unknown, id: string): ActivityRecord {
  const edit = get(raw, "sleep_details_edit_components");
  const napToSleep = get(edit, "nap_to_sleep_available");
  const title = (str(get(raw, "sleep_details_labels", "screen_title_display")) ?? "").toUpperCase();
  const type = napToSleep === true ? "nap" : napToSleep === false ? "sleep" : title.includes("NAP") ? "nap" : title.includes("SLEEP") ? "sleep" : null;
  return {
    id,
    type,
    score_type: "SLEEP",
    start: toUtc(get(edit, "sleep_start_time")),
    end: toUtc(get(edit, "sleep_end_time")),
    version: null,
    score_state: null,
    source: "sleep-details",
  };
}

/** GET cd/v1/cardio-details → type and window from details_edit_components. */
export function recordFromCardioDetails(raw: unknown, id: string): ActivityRecord {
  const edit = get(raw, "details_edit_components");
  const type = str(get(edit, "activity_type_internal_name"));
  return {
    id,
    type,
    score_type: asScoreType(get(edit, "single_score_type")) ?? typeForInternalName(type)?.score_type ?? null,
    start: toUtc(get(edit, "start_time_selector", "initial_time")),
    end: toUtc(get(edit, "end_time_selector", "initial_time")),
    version: null,
    score_state: null,
    source: "cardio-details",
  };
}

const isStatus = (e: unknown, ...statuses: number[]): boolean => e instanceof WhoopApiError && statuses.includes(e.status);

/**
 * Read an activity of unknown kind: the activities-service record first, then
 * cardio-details (200 for CARDIO/RECOVERY in any state, 400 for a pending
 * sleep), then sleep-details for sleeps and naps. Returns null on 404.
 */
export async function readActivity(client: WhoopClient, id: string): Promise<ActivityRecord | null> {
  try {
    const rec = recordFromActivity(await client.get(activityRecordPath(id), {}, { fresh: true }));
    if (rec && rec.type) return rec;
  } catch {
    // The record GET is a convenience (unverified for sleeps); the detail screens below decide.
  }
  try {
    const rec = recordFromCardioDetails(await client.get(CARDIO_DETAILS_V1, { activityId: id }, { fresh: true }), id);
    if (rec.score_type !== "SLEEP" && rec.type) return rec;
  } catch (e) {
    if (isStatus(e, 404)) return null;
    if (!isStatus(e, 400)) throw e; // 400 = a pending sleep
  }
  try {
    return recordFromSleepDetails(await client.get(sleepDetailsPath(id), {}, { fresh: true }), id);
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

/** Fresh read through the endpoint that matches the kind; null on 404. */
export async function readActivityAs(client: WhoopClient, id: string, scoreType: ScoreType): Promise<ActivityRecord | null> {
  try {
    if (scoreType === "SLEEP") return recordFromSleepDetails(await client.get(sleepDetailsPath(id), {}, { fresh: true }), id);
    return recordFromCardioDetails(await client.get(CARDIO_DETAILS_V1, { activityId: id }, { fresh: true }), id);
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

/** True when the kind-specific detail read answers 404; null when the read failed otherwise. */
export async function isGone(client: WhoopClient, id: string, scoreType: ScoreType): Promise<boolean | null> {
  try {
    return (await readActivityAs(client, id, scoreType)) === null;
  } catch {
    return null;
  }
}

/** "**Rowing** - 7:45 AM - 7:55 AM" → "Rowing 7:45 AM – 7:55 AM". */
function cleanOverlapText(s: string): string {
  return s.replace(/\*\*/g, "").replace(/\s+-\s+/, " ").replace(/\s+-\s+/, " – ").trim();
}

/**
 * Human-readable list of what a 409 says overlaps. BFF creates and sleep edits
 * return `overlapping_activities` as display strings ("**Sleep** - 2:15 AM -
 * 5:45 AM"); the cardio-details edit returns none at all.
 */
export function overlapDescriptions(error: WhoopConflictError): string[] {
  const out: string[] = [];
  try {
    const parsed = JSON.parse(error.body) as { overlapping_activities?: unknown };
    if (Array.isArray(parsed.overlapping_activities)) {
      for (const item of parsed.overlapping_activities) if (typeof item === "string") out.push(cleanOverlapText(item));
    }
  } catch {
    // Text body (the edit 409): nothing listed.
  }
  for (const o of error.overlaps) {
    if (o.id || o.type || o.start) out.push([o.type, o.id, o.start && o.end ? `${o.start} – ${o.end}` : o.start].filter(Boolean).join(" "));
  }
  return out;
}
