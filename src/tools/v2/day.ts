// whoop_day (v2): replaces whoop_today, whoop_day and whoop_daily_brief.
//
// Three shapes behind one tool:
//  - one cycle day (the default): the app's home screen and deep dives;
//  - the same plus a heart-rate series (include hr, or a hr_from..hr_to window);
//  - with end_date, a table of days from WHOOP's bulk cycle history.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { isoDay, todayIso } from "../../lib/dates.js";
import { wallClockIso } from "../../lib/timezone.js";
import { daySpan } from "../../lib/activity_list.js";
import { MAX_HR_WINDOW_MS, accountUserId, hrStepFor, readHeartRate } from "../../lib/heart_rate.js";
import { DayOut, DayRangeOut } from "../../schemas/v2/day.js";
import { DAY_SECTIONS, projectDay, type DaySection } from "../../projections/v2/day.js";
import { activityTiles, type HomeCycle } from "../../projections/v2/core_home.js";
import { mainSleepTile } from "../../projections/v2/sleep.js";
import { projectSleepNeedV2 } from "../../projections/v2/core_sleep_need.js";
import { hrWindow } from "../../projections/v2/heart_rate.js";
import { projectHistory } from "../../projections/v2/history.js";
import { instantInput, toInstantOpt } from "../../lib/instant.js";

const NAME = "whoop_day";
const DEFAULT_SECTIONS: DaySection[] = ["scores", "sleep", "strain", "activities"];
/** WHOOP refuses windows over 200 days; 180 leaves room for DST and matches whoop_trend's six_month. */
const MAX_RANGE_DAYS = 180;
const DEFAULT_RANGE_DAYS = 30;
const CYCLES_PATH = "/core-details-bff/v0/cycles/details";

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}
const localMidnight = (day: string): number => Date.parse(wallClockIso(day, 0, 0));

/** The window `include: ["hr"]` reads: the cycle itself, else the calendar day; never past now, never over the cap. */
export function dayHrSpan(cycle: HomeCycle, day: string, now: number): [number, number] {
  const cycleStart = cycle.start ? Date.parse(cycle.start) : NaN;
  const start = Number.isFinite(cycleStart) ? cycleStart : localMidnight(day);
  const cycleEnd = cycle.end ? Date.parse(cycle.end) : NaN;
  // An open cycle has no end (or a predicted one in the future): read up to now.
  const end = Math.min(Number.isFinite(cycleEnd) ? cycleEnd : Number.isFinite(cycleStart) ? now : localMidnight(shiftDay(day, 1)), now);
  return [Math.max(start, end - MAX_HR_WINDOW_MS), end];
}

export function registerDay(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "One cycle day (default today): scores, main sleep, strain, calories, steps, activities and, today, the live state. sleep_plan " +
        "is today only. hr: heart rate every 10 min, or a window via hr_from/hr_to (1-min steps up to 5 h, 6 s up to 30 min). " +
        "end_date: a table of daily recovery, HRV, RHR, sleep, strain, calories and HR instead. Scores are null while calibrating. " +
        "Never reuse the cycle id: sleep edits change it.",
      input: {
        date: z.iso.date().optional(),
        end_date: z.iso.date().optional().describe("Table from date: default 30 days, max 180"),
        include: z.array(z.enum(DAY_SECTIONS)).min(1).optional()
          .describe("Default scores, sleep, strain, activities"),
        hr_from: instantInput().optional().describe("With hr_to, max 48 h"),
        hr_to: instantInput().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ date, end_date, include, hr_from: hrFromIn, hr_to: hrToIn }) => {
      const hr_from = toInstantOpt(hrFromIn, "hr_from");
      const hr_to = toInstantOpt(hrToIn, "hr_to");
      const today = todayIso();
      const now = Date.now();

      if (end_date !== undefined) {
        if (include || hr_from || hr_to) throw new Error("end_date returns the day table only: drop include, hr_from and hr_to, or drop end_date.");
        const end = end_date > today ? today : end_date;
        const start = date ?? shiftDay(end, 1 - DEFAULT_RANGE_DAYS);
        if (start > end) throw new Error(`date ${start} is after end_date ${end_date}${end === end_date ? "" : " (today is the last day with data)"}.`);
        const span = daySpan(start, end);
        if (span > MAX_RANGE_DAYS) throw new Error(`The range is ${span} days; whoop_day reads at most ${MAX_RANGE_DAYS} per call. Split it.`);
        const limit = span + 20;
        const raw = await client.get(CYCLES_PATH, {
          id: await accountUserId(client),
          startTime: new Date(localMidnight(start)).toISOString(),
          endTime: new Date(localMidnight(shiftDay(end, 1))).toISOString(),
          limit,
        });
        const records = (raw as { records?: unknown })?.records;
        const warnings = Array.isArray(records) && records.length >= limit
          ? ["WHOOP returned as many cycles as were asked for, so the oldest days may be missing. Ask for a shorter range."]
          : [];
        return respond(NAME, DayRangeOut, { start_date: start, end_date: end, ...projectHistory(raw, start, end), warnings });
      }

      if ((hr_from === undefined) !== (hr_to === undefined)) throw new Error("hr_from and hr_to go together.");
      const d = date ?? (hr_from ? isoDay(new Date(hr_from)) : today);
      const isToday = d === today;
      // A window on its own is a heart-rate question: answer it without the day's default sections.
      const inc = new Set<DaySection>(include ?? (hr_from ? [] : DEFAULT_SECTIONS));
      if (hr_from) inc.add("hr");
      let explicit: [number, number] | undefined;
      if (hr_from && hr_to) {
        const from = Date.parse(hr_from);
        const to = Math.min(Date.parse(hr_to), now);
        if (!(from < to)) throw new Error(from >= now ? "hr_from is in the future." : "hr_from must be before hr_to.");
        if (to - from > MAX_HR_WINDOW_MS) throw new Error("The heart-rate window is at most 48 hours. Split it, or use whoop_trend for longer spans.");
        explicit = [from, to];
      }
      // Started now so it overlaps the day's own reads; awaited (and allowed to fail) below.
      const explicitHr = explicit ? readHeartRate(client, explicit[0], explicit[1], hrStepFor(explicit[1] - explicit[0])) : undefined;
      explicitHr?.catch(() => undefined);

      const [home, recovery, strain, sleepNeed, userState] = await Promise.all([
        client.get("/home-service/v1/home", { date: d }),
        inc.has("scores") ? client.get("/home-service/v1/deep-dive/recovery", { date: d }).catch(() => null) : undefined,
        inc.has("strain") ? client.get("/home-service/v1/deep-dive/strain", { date: d }).catch(() => null) : undefined,
        // sleepneed 500s when Smart Alarm preferences are broken (SPEC.md §8): degrade to null.
        inc.has("sleep_plan") && isToday
          ? client.get("/coaching-service/v2/sleepneed").then(projectSleepNeedV2).catch(() => null)
          : undefined,
        isToday ? client.get("/activities-service/v1/user-state").catch(() => null) : undefined,
      ]);
      let sleepDetails: unknown;
      if (inc.has("sleep")) {
        const main = mainSleepTile(activityTiles(home));
        if (main) sleepDetails = await client.get(`/core-details-bff/v2/sleep-details/${main.id}`).catch(() => null);
      }
      const projected = projectDay({ date: d, isToday, include: inc, home, recovery, strain, sleepDetails, sleepNeed, userState });
      if (inc.has("hr")) {
        // Asked for by name, so a failed read is an error here, not a silently missing section.
        const [from, to] = explicit ?? dayHrSpan(projected.cycle, d, now);
        if (!(from < to)) throw new Error(`${d} hasn't started yet, so there is no heart rate to read.`);
        const step = hrStepFor(to - from);
        projected.hr = hrWindow(await (explicitHr ?? readHeartRate(client, from, to, step)), from, to, step);
      }
      return respond(NAME, DayOut, projected);
    },
  );
}
