// whoop_workouts: replaces v1 whoop_workouts + whoop_workout.
//
// List (SPEC.md D1): GET home?date= per cycle day, pruned by calendar/overview,
// ≤31 days, 3 at a time. Lists every activity WHOOP shows in the app, pending and
// unscored included. Detail: GET cd/v1/cardio-details, plus cd/v2/recovery-details
// for RECOVERY activities.
//
// Opt-in fallback: with WHOOP_DEV_V2_LISTS=1 in the server environment, ranges
// longer than 31 days (up to 366) come from GET /developer/v2/activity/workout
// instead. That list holds scored workouts only (pending/incomplete ones are
// missing) and the app never calls it, so it is off by default.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { ActivityDetailOut, WorkoutsListOut, type ActivityListItemT } from "../../schemas/activities.js";
import { projectActivityDetail, projectDeveloperWorkout, projectTile, workoutRows } from "../../projections/activities.js";
import { daySpan, listTiles } from "../../lib/activity_list.js";
import { CARDIO_DETAILS_V1, RECOVERY_DETAILS_V2 } from "../../lib/activity_records.js";
import { errorResult } from "../../lib/activity_results.js";
import { todayIso } from "../../lib/dates.js";
import { wallClockIso } from "../../lib/timezone.js";
import { get, str } from "../../whoop/bff.js";

const MAX_APP_DAYS = 31;
const MAX_DEV_DAYS = 366;
const DEV_PATH = "/developer/v2/activity/workout";

const devListsEnabled = (): boolean => process.env.WHOOP_DEV_V2_LISTS === "1" || process.env.WHOOP_DEV_V2_LISTS === "true";

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

async function developerList(client: WhoopClient, startDate: string, endDate: string, limit: number): Promise<{ items: ActivityListItemT[]; more: boolean }> {
  const items: ActivityListItemT[] = [];
  let token: string | undefined;
  let more = false;
  for (let page = 0; page < Math.ceil(limit / 25) + 1; page++) {
    const raw = await client.get(DEV_PATH, {
      start: wallClockIso(startDate, 0, 0),
      end: wallClockIso(shiftDay(endDate, 1), 0, 0),
      limit: 25,
      nextToken: token,
    });
    for (const r of Array.isArray(get(raw, "records")) ? (get(raw, "records") as unknown[]) : []) {
      const item = projectDeveloperWorkout(r);
      if (item) items.push(item);
    }
    token = str(get(raw, "next_token")) ?? undefined;
    if (!token) break;
    if (items.length >= limit) { more = true; break; }
  }
  return { items, more };
}

export function registerWorkouts(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_workouts",
    description:
      "Activities as the app lists them. List: one cycle day (date) or start_date–end_date (≤31 days; default the last 7), pending and " +
      "unscored included, as rows of id, type, sport, start, minutes, status and CARDIO strain. With activity_id: strain, calories, HR, " +
      "zones, distance and MSK summary. Sleeps and naps: whoop_sleep.",
    input: {
      date: z.iso.date().optional(),
      start_date: z.iso.date().optional(),
      end_date: z.iso.date().optional(),
      activity_id: z.string().min(1).optional(),
      include: z.array(z.enum(["hr"])).optional().describe("Detail only"),
      types: z.array(z.enum(["CARDIO", "RECOVERY", "SLEEP"])).min(1).optional().describe("Default CARDIO, RECOVERY"),
      sport: z.string().optional().describe("Substring of the sport's name"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY,
  }, async ({ date, start_date, end_date, activity_id, include, types, sport, limit }) => {
    if (activity_id) {
      let cardio: unknown;
      try {
        cardio = await client.get(CARDIO_DETAILS_V1, { activityId: activity_id });
      } catch (e) {
        if (e instanceof WhoopApiError && e.status === 404) {
          return errorResult({ error: `No activity ${activity_id} (deleted, or not an activity id).` });
        }
        if (e instanceof WhoopApiError && e.status === 400) {
          // cardio-details refuses pending sleeps (SPEC.md C1).
          return errorResult({ error: `${activity_id} is a sleep or nap that WHOOP hasn't scored yet.`, hint: "Use whoop_sleep with this activity_id." });
        }
        throw e;
      }
      const scoreType = str(get(cardio, "details_edit_components", "single_score_type"));
      if (scoreType === "SLEEP") {
        return errorResult({ error: `${activity_id} is a sleep or nap.`, hint: "Use whoop_sleep with this activity_id." });
      }
      const recovery = scoreType === "RECOVERY"
        ? await client.get(RECOVERY_DETAILS_V2, { activityId: activity_id }).catch(() => null)
        : null;
      return respond("whoop_workouts", ActivityDetailOut, projectActivityDetail(cardio, recovery, activity_id, { hr: include?.includes("hr") ?? false }));
    }

    const today = todayIso();
    const endDate = date ?? end_date ?? today;
    const startDate = date ?? start_date ?? shiftDay(endDate, -6);
    if (startDate > endDate) return errorResult({ error: `start_date ${startDate} is after end_date ${endDate}.` });
    const span = daySpan(startDate, endDate);
    const wanted = types ?? ["CARDIO", "RECOVERY"];
    const needle = sport?.trim().toLowerCase();
    const matches = (a: ActivityListItemT): boolean =>
      wanted.includes(a.type as "CARDIO" | "RECOVERY" | "SLEEP") &&
      (!needle || (a.internal_name ?? "").toLowerCase().includes(needle) || (a.name ?? "").toLowerCase().includes(needle));
    const newestFirst = (a: ActivityListItemT, b: ActivityListItemT): number => (b.start ?? "").localeCompare(a.start ?? "");
    const warnings: string[] = [];

    if (span > MAX_APP_DAYS) {
      if (!devListsEnabled() || span > MAX_DEV_DAYS) {
        return errorResult({
          error: `The range is ${span} days; whoop_workouts reads at most ${MAX_APP_DAYS} days per call.`,
          hint: "Split the range into ≤31-day calls.",
        });
      }
      const { items, more } = await developerList(client, startDate, endDate, limit);
      const kept = items.filter(matches).sort(newestFirst);
      warnings.push("Ranges over 31 days come from WHOOP's developer list (WHOOP_DEV_V2_LISTS): scored workouts only; pending and incomplete ones are missing.");
      return respond("whoop_workouts", WorkoutsListOut, {
        source: "developer", start_date: startDate, end_date: endDate, count: Math.min(kept.length, limit),
        ...(more || kept.length > limit ? { truncated: true } : {}), ...workoutRows(kept.slice(0, limit)), warnings,
      });
    }

    const listing = await listTiles(client, startDate, endDate);
    if (!listing.calendar_pruned) warnings.push("The calendar couldn't be read, so every day in the range was checked.");
    if (listing.days_failed.length) warnings.push(`Couldn't read these days: ${listing.days_failed.join(", ")}.`);
    const kept = listing.tiles.map(projectTile).filter(matches).sort(newestFirst);
    return respond("whoop_workouts", WorkoutsListOut, {
      start_date: startDate, end_date: endDate, count: Math.min(kept.length, limit),
      ...(kept.length > limit ? { truncated: true } : {}), ...workoutRows(kept.slice(0, limit)), warnings,
    });
  });
}
