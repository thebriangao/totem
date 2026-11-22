import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { SmartAlarmOut } from "../../schemas/alarm_schedule.js";
import { masterSwitch, projectAlarmSchedules, projectNextAlarm } from "../../projections/alarm_schedule.js";
import { WhoopAuthExpiredError } from "../../whoop/errors.js";

export const SA = "/smart-alarm-service/v1";
export const SA_BFF = "/smart-alarm-bff/v1";
export const UNAVAILABLE_NOTE =
  "WHOOP returned an error for the Smart Alarm preferences/schedule list (on some accounts they 500 permanently). Schedules above are read from the per-day rows; open Smart Alarm in the WHOOP app to check the next alarm.";

/** Optional reads that may 500: null on any failure except an expired login. */
export const tolerate = <T>(p: Promise<T>): Promise<T | null> =>
  p.catch((e: unknown) => {
    if (e instanceof WhoopAuthExpiredError) throw e;
    return null;
  });

export async function readSmartAlarm(client: WhoopClient, fresh = false) {
  const [rows, all, prefs] = await Promise.all([
    client.get(`${SA}/alarm-schedule`, {}, { fresh }),
    tolerate(client.get(`${SA_BFF}/schedule/all`, {}, { fresh })),
    tolerate(client.get(`${SA}/smartalarm/preferences`, {}, { fresh })),
  ]);
  const { schedules, unscheduled } = projectAlarmSchedules(rows);
  return {
    master_switch: masterSwitch(all, prefs),
    schedules,
    unscheduled,
    next_alarm: prefs === null ? ("unavailable" as const) : projectNextAlarm(prefs),
    note: prefs === null || all === null ? UNAVAILABLE_NOTE : null,
  };
}

export function registerSmartAlarm(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_smart_alarm",
    description:
      "Smart Alarm: the recurring schedules (id, days, mode, sleep_goal, latest wake time 24h, enabled; enabled:false shows as ALARM OFF in the app), unscheduled days, " +
      "the recurring-schedule master switch, and the next alarm WHOOP will set (date, window, goal). Fields WHOOP fails to return come back as \"unavailable\". " +
      "Server state only: it doesn't prove the strap has synced.",
    input: {},
    annotations: READ_ONLY,
  }, async () => respond("whoop_smart_alarm", SmartAlarmOut, await readSmartAlarm(client)));
}
