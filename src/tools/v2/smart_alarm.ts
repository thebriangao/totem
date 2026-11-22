import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { SmartAlarmOut } from "../../schemas/alarm_schedule.js";
import { masterSwitch, projectAlarmSchedules, projectNextAlarm } from "../../projections/alarm_schedule.js";
import { WhoopAuthExpiredError } from "../../whoop/errors.js";
import { get } from "../../whoop/bff.js";

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

/** "07:35" minus 60 → "06:35", across midnight. */
export function minusMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (((h! * 60 + m! - minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// IN_THE_GREEN and SLEEP_GOAL buzz inside a window that ends at the latest wake
// time. The app's schedule screen (smart-alarm-bff/v1/schedule/components) says
// "Alarm will vibrate between %s - %s" for those two modes only; the window is
// GET /smart-alarm-service/v1/user-info/default-wake-window
// {default_wake_window_minutes} (route from @Acetone1's Android list; 60 on the
// test account, 2026-11-22).
export function registerSmartAlarm(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_smart_alarm",
    description:
      "Smart Alarm: recurring schedules (id, days, mode, sleep goal, latest wake time, enabled), unscheduled days, the master switch " +
      "and the next alarm WHOOP will set. Server state only: it doesn't prove the strap has synced.",
    input: {},
    annotations: READ_ONLY,
  }, async () => {
    const [state, window] = await Promise.all([readSmartAlarm(client), tolerate(client.get(`${SA}/user-info/default-wake-window`))]);
    const min = get(window, "default_wake_window_minutes");
    const wakeWindow = typeof min === "number" && Number.isInteger(min) && min > 0 && min < 1440 ? min : null;
    const schedules = wakeWindow === null ? state.schedules : state.schedules.map((sc) =>
      sc.mode === "IN_THE_GREEN" || sc.mode === "SLEEP_GOAL" ? { ...sc, earliest: minusMinutes(sc.wake, wakeWindow) } : sc);
    return respond("whoop_smart_alarm", SmartAlarmOut, { ...state, schedules, wake_window_min: wakeWindow });
  });
}
