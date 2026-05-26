import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { SmartAlarmSetOut } from "../../schemas/smart_alarm.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

const ScheduleShape = z.object({
  enabled: z.boolean(),
  days_of_week: z.array(z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"])),
  latest_wake_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  alarm_mode: z.enum(["IN_THE_GREEN", "EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP"]),
  sleep_goal: z.string().default(""),
  timezone_offset: z.string(),
});

const PreferencesShape = z.object({
  lower_time_bound: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  upper_time_bound: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  goal: z.enum(["EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP", "IN_THE_GREEN"]),
  enabled: z.boolean(),
  schedule_enabled: z.boolean(),
  timezone_offset: z.string(),
  weekly_plan_goal: z.number().int().default(0),
});

export function registerSmartAlarmSet(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_smart_alarm_set",
    "WRITE: update one Smart Alarm schedule, the global preferences, or the master enable/disable switch.",
    {
      mode: z.enum(["schedule", "preferences", "master_enable", "master_disable"]),
      schedule_id: z.string().optional(),
      schedule: ScheduleShape.optional(),
      preferences: PreferencesShape.optional(),
      confirm: z.boolean().default(false),
    },
    async ({ mode, schedule_id, schedule, preferences, confirm }) => {
      let path: string;
      let body: unknown;
      switch (mode) {
        case "schedule":
          if (!schedule_id || !schedule) {
            return {
              content: [
                { type: "text", text: jsonOut({ error: "mode=schedule requires schedule_id + schedule" }) },
              ],
              isError: true,
            };
          }
          path = `/smart-alarm-bff/v1/schedule/${schedule_id}`;
          body = {
            sleep_goal: schedule.sleep_goal,
            day_of_week_list: schedule.days_of_week,
            time_zone_offset: schedule.timezone_offset,
            enabled: schedule.enabled,
            latest_wake_time: schedule.latest_wake_time,
            alarm_mode: schedule.alarm_mode,
          };
          break;
        case "preferences":
          if (!preferences) {
            return {
              content: [
                { type: "text", text: jsonOut({ error: "mode=preferences requires preferences" }) },
              ],
              isError: true,
            };
          }
          path = "/smart-alarm-service/v1/smartalarm/preferences";
          body = {
            lower_time_bound: preferences.lower_time_bound,
            upper_time_bound: preferences.upper_time_bound,
            goal: preferences.goal,
            enabled: preferences.enabled,
            schedule_enabled: preferences.schedule_enabled,
            time_zone_offset: preferences.timezone_offset,
            weekly_plan_goal: preferences.weekly_plan_goal,
            default: false,
          };
          break;
        case "master_enable":
          path = "/smart-alarm-service/v1/alarm-schedule/enable";
          body = undefined;
          break;
        case "master_disable":
          path = "/smart-alarm-service/v1/alarm-schedule/disable";
          body = undefined;
          break;
      }
      if (!confirm) {
        return {
          content: [
            { type: "text", text: jsonOut(preview("PUT", path, { mode, summary: body ?? "(no body)" })) },
          ],
        };
      }
      await client.put(path, body);
      const out = SmartAlarmSetOut.parse({ updated: true as const, mode });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
