// whoop_lift_sessions (R): replaces whoop_lift_history + whoop_lift_overview.
// Lists come from the app's own day screens (SPEC.md D1), never /developer/v2,
// which hides unscored activities.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { LiftSessionsOut, type LiftSessionOutT } from "../../schemas/strength_v2.js";
import {
  activityFromDetail,
  buildSession,
  hasLiftData,
  hoistUnit,
  homeActivities,
  parseCardioDetails,
  parseHistoryCards,
  type HomeActivity,
} from "../../projections/lift_sessions.js";
import type { LiftCard } from "../../projections/lift_cards.js";
import { walkHistory } from "../../lib/lift_history.js";
import { readActivityAs } from "../../lib/activity_records.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { get } from "../../whoop/bff.js";
import { runPaced } from "../../lib/concurrency.js";
import { isoDay, todayIso } from "../../lib/dates.js";

const TOOL = "whoop_lift_sessions";
const MAX_SPAN_DAYS = 60;
const DEFAULT_SPAN_DAYS = 14;
const DAY_CHUNK = 3;
// The unscored sweep (opt-in): WHOOP has no read for one workout's sets, only
// per-exercise history, so it costs up to PR_PAGES requests plus one or more per
// exercise the account has a PR tile for (live: 30–45 requests for 25 exercises).
const PR_PAGES = 6; // exercises probed for unscored sessions: 10 per page
const HISTORY_PAGES = 4; // 5 workouts per page
const PACE = { concurrency: 3, jitterMaxMs: 120 };
const STRENGTH_TRAINER = "weightlifting_msk";

type Session = LiftSessionOutT & { _unit: "kg" | "lb" | null };
/** cardio-details answered 400 (pending): treat as unscored. */
const PENDING_400 = Symbol("pending");
type CardIndex = Map<string, Array<{ exercise_id: string; name: string | null; card: LiftCard }>>;

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Days in [start, end] that calendar/overview marks has_data (newest first), or every day if it can't be read. */
async function daysWithData(client: WhoopClient, start: string, end: string, warnings: string[]): Promise<string[]> {
  const all: string[] = [];
  for (let d = end; d >= start; d = addDays(d, -1)) all.push(d);
  try {
    const marked = new Set<string>();
    for (const month of [...new Set(all.map((d) => d.slice(0, 7)))]) {
      const raw = await client.get("/home-service/v1/calendar/overview", { date: `${month}-01` });
      for (const day of (get(raw, "days_of_month") ?? []) as unknown[]) {
        const n = Number(get(day, "date_value_display"));
        if (get(day, "has_data") === true && Number.isInteger(n)) marked.add(`${month}-${String(n).padStart(2, "0")}`);
      }
    }
    return all.filter((d) => marked.has(d));
  } catch {
    warnings.push("Calendar unreadable; checked every day.");
    return all;
  }
}

/** An activity whose lift sets (if any) only exercise_history can show. */
function unscored(activity: HomeActivity, detail: unknown): boolean {
  if (hasLiftData(detail)) return false;
  const strain = get(detail, "horizontal_stat", "stat_main_value_display");
  return activity.internal_name === STRENGTH_TRAINER || activity.status === "INCOMPLETE" || strain === "---" || strain === "--";
}

/**
 * Sets for unscored sessions: exercise_history is per exercise, so walk the
 * exercises the account has records for (v3/prs, deduped, deleted dropped) and
 * keep the cards whose GO TO ACTIVITY button points at a wanted activity.
 * `fresh` skips the cache (a just-logged workout can lag ~30 s behind).
 */
async function historyIndex(client: WhoopClient, wanted: Set<string>, notBefore: string | undefined, fresh: boolean, warnings: string[]): Promise<CardIndex> {
  const exercises = new Map<string, string | null>();
  let offset = 0;
  let more = true;
  for (let page = 0; page < PR_PAGES && more; page++) {
    const raw = await client.get("/weightlifting-service/v3/prs", offset ? { offset } : {}, fresh ? { fresh: true } : {});
    for (const t of (get(raw, "tiles") ?? []) as unknown[]) {
      const id = get(t, "exercise_id");
      if (typeof id === "string" && get(t, "deleted") !== true && !exercises.has(id)) exercises.set(id, (get(t, "name") as string | undefined) ?? null);
    }
    more = get(raw, "show_more") === true;
    const next = Number(get(raw, "next_exercise_offset"));
    offset = Number.isFinite(next) && next > offset ? next : offset + 10;
  }
  if (more) warnings.push(`Unscored sessions were matched against the first ${exercises.size} exercises of your PR list only; an exercise beyond them is missing.`);

  const index: CardIndex = new Map();
  await runPaced([...exercises].map(([exerciseId, name]) => () =>
    walkHistory(client, exerciseId, { notBefore, maxPages: HISTORY_PAGES, fresh }, (cards) => {
      for (const card of cards) {
        if (!card.activity_id || !wanted.has(card.activity_id)) continue;
        const list = index.get(card.activity_id) ?? [];
        list.push({ exercise_id: exerciseId, name, card });
        index.set(card.activity_id, list);
      }
    })), PACE);
  return index;
}

/**
 * How far back the sweep pages each exercise's history: a day before the oldest
 * wanted activity, not the whole requested range. `fallbackDay` when a start is unknown.
 */
function sweepFloor(activities: HomeActivity[], fallbackDay: string): string {
  const starts = activities.map((a) => a.start);
  if (starts.length === 0 || starts.some((s) => !s)) return `${fallbackDay}T00:00:00.000Z`;
  const oldest = Math.min(...starts.map((s) => Date.parse(s!)));
  return new Date(oldest - 86_400_000).toISOString();
}

/** True when any activity started within the last 2 h (its history may still be catching up). */
function recent(activities: HomeActivity[], now = Date.now()): boolean {
  return activities.some((a) => !a.start || now - Date.parse(a.start) < 2 * 3_600_000);
}

function fromIndex(activity: HomeActivity, detail: unknown, index: CardIndex, withRows: boolean): Session | null {
  const cards = index.get(activity.activity_id);
  if (cards?.length) return buildSession(activity, detail, parseHistoryCards(cards), "history", withRows);
  if (activity.internal_name === STRENGTH_TRAINER) return buildSession(activity, detail, { exercises: [], volume: null, unit: null }, "none", withRows);
  return null;
}

export function registerLiftSessions(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: TOOL,
    description:
      "Strength sessions, newest first (default last 14 days, max 60; 3 per call): any activity with Strength Trainer sets, any sport. Each exercise: id, sets (\"3x5\"; timed in s), top [weight, reps], volume, best medal. include sets adds rows [weight, reps] (or [weight, reps, pct_1rm, avg_hr] when scored). An unscored session lists as src unscored with no exercises: include unscored, or activity_id, reads its sets from exercise history (slow: a request per exercise you have a PR in; no HR/%1RM). Weights in `unit`. Names: whoop_lift_library search.",
    input: {
      start_date: z.iso.date().optional().describe("Default end_date minus 13 days."),
      end_date: z.iso.date().optional().describe("Default today."),
      activity_id: z.string().optional().describe("Read one activity instead of a range."),
      limit: z.number().int().min(1).max(20).default(3),
      include: z.array(z.enum(["sets", "unscored"])).optional().describe("sets = per-set rows; unscored = read unscored sessions' sets."),
    },
    annotations: READ_ONLY,
  }, async ({ start_date, end_date, activity_id, limit, include }) => {
    const warnings: string[] = [];
    const withRows = include?.includes("sets") ?? false;
    const sweep = include?.includes("unscored") ?? false;
    const today = todayIso();

    if (activity_id) {
      let detail: unknown = null;
      try {
        detail = await client.get("/core-details-bff/v1/cardio-details", { activityId: activity_id });
      } catch (e) {
        // WHOOP sometimes answers 400 "Cannot view activity details for a pending activity" for a few seconds after a log.
        if (!(e instanceof WhoopApiError && e.status === 400)) throw e;
        warnings.push("Activity details unavailable while pending; sets come from exercise history.");
      }
      let activity = activityFromDetail(activity_id, detail, today);
      if (!activity.start) {
        // The raw record answers in every state: its window bounds the history paging below.
        const record = await readActivityAs(client, activity_id, "CARDIO").catch(() => null);
        if (record?.start) activity = { ...activity, internal_name: activity.internal_name ?? record.type, start: record.start, end: record.end };
      }
      if (activity.start) activity.date = isoDay(new Date(activity.start));
      let session: Session | null;
      if (hasLiftData(detail)) session = buildSession(activity, detail, parseCardioDetails(detail), "details", withRows);
      else {
        session = fromIndex(activity, detail, await historyIndex(client, new Set([activity_id]), sweepFloor([activity], addDays(today, -MAX_SPAN_DAYS)), recent([activity]), warnings), withRows);
      }
      if (!session) warnings.push("This activity has no Strength Trainer sets.");
      const hoisted = hoistUnit(session ? [session] : []);
      return respond(TOOL, LiftSessionsOut, { from: activity.date, to: activity.date, ...hoisted, more: false, warnings });
    }

    const end = !end_date || end_date > today ? today : end_date;
    const start = start_date ?? addDays(end, -(DEFAULT_SPAN_DAYS - 1));
    if (start > end) throw new Error(`start_date ${start} is after end_date ${end}.`);
    const span = daysBetween(start, end) + 1;
    if (span > MAX_SPAN_DAYS) throw new Error(`The range is ${span} days; the maximum is ${MAX_SPAN_DAYS}.`);

    const days = await daysWithData(client, start, end, warnings);
    const sessions: Session[] = [];
    const candidates = new Map<string, { activity: HomeActivity; detail: unknown }>();
    const seen = new Set<string>();
    const found = () => sessions.length + [...candidates.values()].filter((c) => c.activity.internal_name === STRENGTH_TRAINER).length;
    let scanned = 0;
    let detailFailures = 0;
    for (let i = 0; i < days.length && found() < limit; i += DAY_CHUNK) {
      const chunk = days.slice(i, i + DAY_CHUNK);
      const homes = await runPaced(chunk.map((d) => () => client.get("/home-service/v1/home", { date: d }).catch(() => null)), PACE);
      scanned += chunk.length;
      const activities = homes
        .flatMap((h, k) => (h ? homeActivities(h, chunk[k]!) : []))
        .filter((a) => a.type === "CARDIO" && !seen.has(a.activity_id) && (seen.add(a.activity_id), true));
      const details = await runPaced(
        activities.map((a) => () => client.get("/core-details-bff/v1/cardio-details", { activityId: a.activity_id })
          .catch((e) => (e instanceof WhoopApiError && e.status === 400 ? PENDING_400 : undefined))),
        PACE,
      );
      activities.forEach((a, k) => {
        const detail = details[k];
        if (detail === PENDING_400) candidates.set(a.activity_id, { activity: a, detail: null });
        else if (detail === undefined) detailFailures++;
        else if (hasLiftData(detail)) sessions.push(buildSession(a, detail, parseCardioDetails(detail), "details", withRows));
        else if (unscored(a, detail)) candidates.set(a.activity_id, { activity: a, detail });
      });
    }
    if (detailFailures) warnings.push(`${detailFailures} activity detail read(s) failed.`);

    if (candidates.size > 0 && sweep) {
      const list = [...candidates.values()].map((c) => c.activity);
      const index = await historyIndex(client, new Set(candidates.keys()), sweepFloor(list, addDays(start, -1)), recent(list), warnings);
      for (const { activity, detail } of candidates.values()) {
        const s = fromIndex(activity, detail, index, withRows);
        if (s) sessions.push(s);
      }
    } else if (candidates.size > 0) {
      // Default: no sweep. Strength Trainer workouts are listed without their sets;
      // other unscored sports are left out (only the sweep can tell whether sets were attached).
      let listed = 0;
      for (const { activity, detail } of candidates.values()) {
        if (activity.internal_name !== STRENGTH_TRAINER) continue;
        sessions.push(buildSession(activity, detail, { exercises: [], volume: null, unit: null }, "unscored", withRows));
        listed++;
      }
      if (listed) warnings.push(`${listed} unscored session(s) listed without exercises; include ["unscored"] (or activity_id) reads their sets from exercise history.`);
    }

    sessions.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
    const hoisted = hoistUnit(sessions.slice(0, limit));
    return respond(TOOL, LiftSessionsOut, {
      from: start,
      to: end,
      ...hoisted,
      more: sessions.length > limit || scanned < days.length,
      warnings,
    });
  });
}
