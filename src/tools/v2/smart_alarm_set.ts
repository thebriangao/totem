import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { SmartAlarmSetOut } from "../../schemas/smart_alarm.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { normalizeClockTime } from "../../lib/clock.js";
import { projectSmartAlarm } from "../../projections/smart_alarm.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";

const TIMEZONE_OFFSET_RE = /^[+-](?:[01]\d|2[0-3]):?[0-5]\d$/;
const ClockTime = z.string().trim().transform((value, ctx) => {
  const normalized = normalizeClockTime(value);
  if (normalized) return normalized;
  ctx.addIssue({ code: "custom", message: "Use a clock time such as 07:30, 07:30:00, or 7:30 AM." });
  return z.NEVER;
});

const ScheduleShape = z.object({
  enabled: z.boolean(),
  days_of_week: z.array(z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"])).min(1),
  latest_wake_time: ClockTime,
  alarm_mode: z.enum(["IN_THE_GREEN", "EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP"]),
  sleep_goal: z.string().default(""),
  timezone_offset: z.string().regex(TIMEZONE_OFFSET_RE),
}).superRefine((schedule, ctx) => {
  if (new Set(schedule.days_of_week).size !== schedule.days_of_week.length) {
    ctx.addIssue({ code: "custom", path: ["days_of_week"], message: "days_of_week must not contain duplicates" });
  }
});

const PreferencesShape = z.object({
  lower_time_bound: ClockTime,
  upper_time_bound: ClockTime,
  goal: z.enum(["EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP", "IN_THE_GREEN"]),
  enabled: z.boolean(),
  schedule_enabled: z.boolean(),
  timezone_offset: z.string().regex(TIMEZONE_OFFSET_RE),
  weekly_plan_goal: z.number().int().min(0).default(0),
});

export function registerSmartAlarmSet(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_smart_alarm_set",
    "WRITE: update Smart Alarm. To change WHEN the alarm wakes you, use mode=schedule (needs schedule_id + latest_wake_time) — that's the setting that actually controls the wake time. mode=preferences sets the global goal + enable flags, but its lower/upper_time_bound are ignored by the server whenever an explicit schedule exists, so don't use it to set a wake time. master_enable / master_disable turn the whole system on/off. For schedule/preferences, call whoop_smart_alarm first for the schedule_id + current values, then resend with your edits (these replace, not merge).",
    {
      mode: z.enum(["schedule", "preferences", "master_enable", "master_disable"]),
      schedule_id: z.string().optional(),
      schedule: ScheduleShape.optional(),
      preferences: PreferencesShape.optional(),
      confirm: z.boolean().default(false),
    },
    WRITE_DESTRUCTIVE,
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
      if (mode === "schedule" && schedule_id && schedule) {
        const [schedules, currentPreferences] = await Promise.all([
          client.get("/smart-alarm-bff/v1/schedule/all"),
          client.get("/smart-alarm-service/v1/smartalarm/preferences").catch(() => null),
        ]);
        const current = projectSmartAlarm({ schedules, preferences: currentPreferences }).schedules
          .find((entry) => entry.schedule_id === schedule_id);
        const noChange = Boolean(current
          && current.enabled === schedule.enabled
          && current.latest_wake_time === schedule.latest_wake_time
          && current.alarm_mode === schedule.alarm_mode
          && current.sleep_goal === schedule.sleep_goal
          && current.timezone_offset === schedule.timezone_offset
          && current.days_of_week.length === schedule.days_of_week.length
          && current.days_of_week.every((day, index) => day === schedule.days_of_week[index]));
        if (noChange) {
          const out = SmartAlarmSetOut.parse({ updated: false, no_change: true, mode });
          return { content: [{ type: "text", text: jsonOut(out) }] };
        }
      }
      if (mode === "preferences" && preferences) {
        const raw = await client.get("/smart-alarm-service/v1/smartalarm/preferences");
        const current = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
        const noChange = Boolean(current
          && normalizeClockTime(typeof current.lower_time_bound === "string" ? current.lower_time_bound : "") === preferences.lower_time_bound
          && normalizeClockTime(typeof current.upper_time_bound === "string" ? current.upper_time_bound : "") === preferences.upper_time_bound
          && current.goal === preferences.goal
          && current.enabled === preferences.enabled
          && current.schedule_enabled === preferences.schedule_enabled
          && current.time_zone_offset === preferences.timezone_offset
          && current.weekly_plan_goal === preferences.weekly_plan_goal);
        if (noChange) {
          const out = SmartAlarmSetOut.parse({ updated: false, no_change: true, mode });
          return { content: [{ type: "text", text: jsonOut(out) }] };
        }
      }
      if (mode === "master_enable" || mode === "master_disable") {
        const schedules = await client.get("/smart-alarm-bff/v1/schedule/all");
        const enabled = projectSmartAlarm({ schedules, preferences: null }).enabled;
        if (enabled === (mode === "master_enable")) {
          const out = SmartAlarmSetOut.parse({ updated: false, no_change: true, mode });
          return { content: [{ type: "text", text: jsonOut(out) }] };
        }
      }
      await client.put(path, body);
      const out = SmartAlarmSetOut.parse({ updated: true, no_change: false, mode });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
