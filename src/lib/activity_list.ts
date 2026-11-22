// App-native activity listing (SPEC.md D1, §4.2, §4.3): the home screen's
// "Today's Activities" card for each cycle day, pruned by the calendar overview.
// `/developer/v2/activity/workout` hides pending and incomplete activities, so it
// is never used for overlap checks or read-backs.
import type { WhoopClient } from "../whoop/client.js";
import { findAll, get, str } from "../whoop/bff.js";
import { isoDay } from "./dates.js";
import { runPaced } from "./concurrency.js";
import { toUtc } from "./activity_records.js";

export interface ActivityTile {
  activity_id: string;
  /** CARDIO | RECOVERY | SLEEP (the tile's `type`). */
  score_type: string | null;
  internal_name: string | null;
  title: string | null;
  /** COMPLETE | INCOMPLETE | PENDING. */
  status: string | null;
  /** Strain for CARDIO ("4.6", "0.0"); h:mm duration for RECOVERY and SLEEP. */
  score_display: string | null;
  start: string | null;
  end: string | null;
  /** The cycle day whose home card listed it. */
  cycle_day: string | null;
}

export const HOME_PATH = "/home-service/v1/home";
export const CALENDAR_OVERVIEW_PATH = "/home-service/v1/calendar/overview";

/** Every ACTIVITY tile on a home screen (walks for `activity_v2_id`; index-free). */
export function activityTiles(home: unknown, fallbackDay: string | null = null): ActivityTile[] {
  const cycleDay = str(get(home, "metadata", "cycle_metadata", "cycle_day")) ?? fallbackDay;
  const seen = new Set<string>();
  const out: ActivityTile[] = [];
  for (const n of findAll(home, (node) => typeof node.activity_v2_id === "string")) {
    const id = n.activity_v2_id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      activity_id: id,
      score_type: str(n.type),
      internal_name: str(n.internal_name),
      title: str(n.title),
      status: str(n.status),
      score_display: str(n.score_display),
      start: toUtc(get(n, "during", "lower_endpoint")),
      end: toUtc(get(n, "during", "upper_endpoint")),
      cycle_day: cycleDay,
    });
  }
  return out;
}

/** Days with data in the calendar month of `monthDate` ("YYYY-MM-..."), as full dates. */
export function calendarDataDays(raw: unknown, monthDate: string): string[] {
  const month = monthDate.slice(0, 7);
  const days = get(raw, "days_of_month");
  if (!Array.isArray(days)) return [];
  const out: string[] = [];
  for (const d of days) {
    const n = Number(get(d, "date_value_display"));
    if (get(d, "has_data") === true && Number.isInteger(n) && n >= 1 && n <= 31) out.push(`${month}-${String(n).padStart(2, "0")}`);
  }
  return out;
}

function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD from start to end. */
export function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

export function daySpan(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export interface TileListing {
  tiles: ActivityTile[];
  days_checked: string[];
  days_failed: string[];
  calendar_pruned: boolean;
}

/**
 * Walk home?date= for every day in [start, end] that the calendar overview marks
 * as having data (every day if the calendar can't be read), 3 at a time.
 */
export async function listTiles(client: WhoopClient, start: string, end: string, opts: { fresh?: boolean } = {}): Promise<TileListing> {
  const all = enumerateDays(start, end);
  const months = [...new Set(all.map((d) => d.slice(0, 7)))];
  let pruned = true;
  const withData = new Set<string>();
  const calendars = await runPaced(months.map((m) => () =>
    client.get(CALENDAR_OVERVIEW_PATH, { date: `${m}-01` }).then((raw) => calendarDataDays(raw, `${m}-01`)).catch(() => null)));
  for (const days of calendars) {
    if (days === null) pruned = false;
    else for (const d of days) withData.add(d);
  }
  const days = pruned ? all.filter((d) => withData.has(d)) : all;
  const failed: string[] = [];
  const homes = await runPaced(days.map((day) => () =>
    client.get(HOME_PATH, { date: day }, opts.fresh ? { fresh: true } : {})
      .then((raw) => activityTiles(raw, day))
      .catch(() => { failed.push(day); return [] as ActivityTile[]; })), { concurrency: 3 });
  const seen = new Set<string>();
  const tiles: ActivityTile[] = [];
  for (const list of homes) for (const t of list) {
    if (seen.has(t.activity_id)) continue;
    seen.add(t.activity_id);
    tiles.push(t);
  }
  return { tiles, days_checked: days, days_failed: failed.sort(), calendar_pruned: pruned };
}

/** Half-open overlap of [aStart, aEnd) and [bStart, bEnd), as WHOOP checks it. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Activities whose window overlaps [start, end), excluding `excludeId`. Reads the
 * home card of the cycle days around the window (a nap before a main sleep sits
 * on the previous day's card), fresh.
 */
export async function overlappingTiles(client: WhoopClient, startIso: string, endIso: string, excludeId?: string): Promise<{ tiles: ActivityTile[]; complete: boolean }> {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  const first = addDays(isoDay(new Date(s)), -1);
  const last = addDays(isoDay(new Date(e)), 1);
  const days = enumerateDays(first, last);
  let complete = true;
  const lists = await runPaced(days.map((day) => () =>
    client.get(HOME_PATH, { date: day }, { fresh: true }).then((raw) => activityTiles(raw, day)).catch(() => {
      complete = false;
      return [] as ActivityTile[];
    })), { concurrency: 3 });
  const seen = new Set<string>();
  const out: ActivityTile[] = [];
  for (const list of lists) for (const t of list) {
    if (t.activity_id === excludeId || seen.has(t.activity_id) || !t.start || !t.end) continue;
    seen.add(t.activity_id);
    if (overlaps(s, e, Date.parse(t.start), Date.parse(t.end))) out.push(t);
  }
  return { tiles: out, complete };
}
