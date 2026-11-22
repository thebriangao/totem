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
        "One cycle day at a glance (default today): scores, main sleep, strain, calories, steps, activities and, today, the live state. " +
        "sleep_plan (tonight's sleep need) is today only. Scores are null while WHOOP is calibrating. Never reuse the cycle id: it " +
        "changes when sleeps are edited.",
      input: {
        date: z.iso.date().optional(),
        include: z.array(z.enum(DAY_SECTIONS)).min(1).optional()
          .describe("Default scores, sleep, strain, activities"),
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
