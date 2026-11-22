// whoop_day (v2): replaces whoop_today, whoop_day and whoop_daily_brief.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { DayOut } from "../../schemas/v2/day.js";
import { DAY_SECTIONS, projectDay, type DaySection } from "../../projections/v2/day.js";
import { activityTiles } from "../../projections/v2/core_home.js";
import { mainSleepTile } from "../../projections/v2/sleep.js";
import { projectSleepNeedV2 } from "../../projections/v2/core_sleep_need.js";

const NAME = "whoop_day";
const DEFAULT_SECTIONS: DaySection[] = ["scores", "sleep", "strain", "activities"];

export function registerDay(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "One cycle day at a glance (default today): cycle (its id is informational; it changes when sleeps are edited, never reuse it), " +
        "scores, main sleep summary, strain with calories and steps, the day's activities grouped CARDIO/RECOVERY/SLEEP with status, " +
        "workouts_count (CARDIO only), WHOOP coach activity recommendations, and the live state today. " +
        "Opt-in sections: key_stats (dashboard stats by trend key) and sleep_plan (tonight's sleep need; today only, null when WHOOP's sleep coach errors). " +
        "Scores are null while WHOOP is calibrating. Durations are minutes.",
      input: {
        date: z.iso.date().optional().describe("Cycle day YYYY-MM-DD; defaults to today"),
        include: z.array(z.enum(DAY_SECTIONS)).min(1).optional()
          .describe("Sections to return; default scores, sleep, strain, activities"),
      },
      annotations: READ_ONLY,
    },
    async ({ date, include }) => {
      const today = todayIso();
      const d = date ?? today;
      const isToday = d === today;
      const inc = new Set<DaySection>(include ?? DEFAULT_SECTIONS);
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
      return respond(NAME, DayOut, projected);
    },
  );
}
