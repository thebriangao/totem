// whoop_sleep (v2): replaces whoop_sleep and whoop_sleep_need, and covers the
// proposed sleep_details (any past sleep or nap by id). App-native only (D1).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { SleepV2Out } from "../../schemas/v2/sleep.js";
import { mainSleepId, projectSleepV2, type SleepInclude } from "../../projections/v2/sleep.js";
import { projectSleepNeedV2 } from "../../projections/v2/core_sleep_need.js";
import { activityRecordPath, recordFromActivity } from "../../lib/activity_records.js";

const NAME = "whoop_sleep";
const INCLUDES = ["hypnogram", "need", "naps"] as const;

export function registerSleep(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "Sleep for a cycle day (default today = last night's main sleep) or one sleep or nap by activity_id: window, minutes asleep and " +
        "in bed, efficiency, stages, disturbances, HR and performance, plus the day's naps (with ids) and tonight's sleep need (today " +
        "only).",
      input: {
        date: z.iso.date().optional(),
        activity_id: z.string().uuid().optional(),
        include: z.array(z.enum(INCLUDES)).optional().describe("Default naps, need"),
      },
      annotations: READ_ONLY,
    },
    async ({ date, activity_id, include }) => {
      const inc = new Set<SleepInclude>(include ?? ["naps", "need"]);
      const baseline = client.get("/sleep-service/v1/heart-rate/baseline").catch(() => null);
      if (activity_id) {
        // One sleep or nap by id: no date context, so no naps list or sleep need.
        inc.delete("naps");
        inc.delete("need");
        // WHOOP's sleep-details answers 200 for ANY activity id: a workout comes back as an
        // empty "SLEEP" screen. The activity record says what the id really is.
        const [details, record] = await Promise.all([
          client.get(`/core-details-bff/v2/sleep-details/${activity_id}`),
          client.get(activityRecordPath(activity_id)).then(recordFromActivity).catch(() => null),
        ]);
        if (record?.score_type && record.score_type !== "SLEEP") {
          throw new Error(`Activity ${activity_id} is a ${record.type ?? record.score_type} activity, not a sleep or nap. Use whoop_workouts for it.`);
        }
        return respond(NAME, SleepV2Out, projectSleepV2({ date: null, activityId: activity_id, include: inc, details, baseline: await baseline }));
      }
      const today = todayIso();
      const d = date ?? today;
      const [home, lastNight, need] = await Promise.all([
        client.get("/home-service/v1/home", { date: d }),
        client.get("/home-service/v1/deep-dive/sleep/last-night", { date: d }).catch(() => null),
        // sleepneed is tonight's plan and 500s when Smart Alarm preferences are broken: degrade to null.
        inc.has("need") && d === today
          ? client.get("/coaching-service/v2/sleepneed").then(projectSleepNeedV2).catch(() => null)
          : null,
      ]);
      const id = mainSleepId(lastNight, home);
      // A pending sleep's details 400; the projection falls back to the tile/last-night window.
      const details = id ? await client.get(`/core-details-bff/v2/sleep-details/${id}`).catch(() => null) : null;
      return respond(NAME, SleepV2Out, projectSleepV2({ date: d, include: inc, details, lastNight, home, need, baseline: await baseline }));
    },
  );
}
