import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import {
  ALARM_MODES,
  DAYS,
  SAFE_ALARM_GOALS,
  SLEEP_GOALS,
  SmartAlarmSetOut,
  type AlarmScheduleT,
  type Day,
} from "../../schemas/alarm_schedule.js";
import { projectAlarmSchedules, wireDay } from "../../projections/alarm_schedule.js";
import { previewWith, toolError, writeRejected } from "../../lib/health_plans_write.js";
import { normalizeClockTime } from "../../lib/clock.js";
import { WhoopApiError, WhoopServerError } from "../../whoop/errors.js";
import { todayIso } from "../../lib/dates.js";
import { wallClockIso } from "../../lib/timezone.js";
import { readSmartAlarm, SA, SA_BFF } from "./smart_alarm.js";

const SYNC = "Open the WHOOP app so the strap picks up the change; totem can't push alarms to the strap.";
const NO_RETRY = "WHOOP answered 500. Totem never retries Smart Alarm writes (a bad one can break the account's alarm settings); the result below is what read back.";

/** The member's current UTC offset as "-0800" (required on schedule writes; not stored). */
export function tzOffset(): string {
  const iso = wallClockIso(todayIso(), 12, 0);
  return iso.slice(-6).replace(":", "");
}

type Mode = typeof ALARM_MODES[number];
type SleepGoal = typeof SLEEP_GOALS[number];
interface Target { days: Day[]; mode: Mode; sleep_goal: SleepGoal | null; wake: string; enabled: boolean }

/** The bff schedule body: all six fields, always (a missing one is a 422). */
export function scheduleBody(t: Target) {
  return {
    day_of_week_list: t.days.map(wireDay),
    latest_wake_time: t.wake,
    alarm_mode: t.mode,
    time_zone_offset: tzOffset(),
    sleep_goal: t.mode === "SLEEP_GOAL" ? t.sleep_goal! : "",
    enabled: t.mode === "NO_ALARM" ? false : t.enabled,
  };
}

/** Does a schedule read back as the target? (NO_ALARM is stored as EXACT_TIME, disabled.) */
export function scheduleMatches(groups: AlarmScheduleT[], t: Target): boolean {
  if (!groups.length) return false;
  const days = [...new Set(groups.flatMap((g) => g.days))];
  const wantMode = t.mode === "NO_ALARM" ? "EXACT_TIME" : t.mode;
  const wantEnabled = t.mode === "NO_ALARM" ? false : t.enabled;
  return days.length === t.days.length && t.days.every((d) => days.includes(d))
    && groups.every((g) => g.mode === wantMode && g.wake === t.wake.slice(0, 5) && g.enabled === wantEnabled
      && (t.mode === "SLEEP_GOAL" ? g.sleep_goal === t.sleep_goal : true));
}

const describe = (s: AlarmScheduleT): string =>
  `${s.mode ?? s.goal}${s.sleep_goal ? ` ${s.sleep_goal}` : ""} ${s.wake}${s.enabled ? "" : " (off)"}`;

export function registerSmartAlarmSet(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_smart_alarm_set",
    description:
      "WRITE Smart Alarm. create/edit a recurring schedule (days, mode, sleep_goal only for SLEEP_GOAL, wake_time 24h, enabled; NO_ALARM means off); edit merges onto the current schedule; " +
      "a day belongs to one schedule, so claiming it moves it off another. delete removes a schedule. enable/disable flip the recurring master switch. " +
      "single_alarm sets just the next alarm and turns the recurring schedules off. Changes reach the strap only after the WHOOP app syncs. Preview unless confirm:true.",
    input: {
      action: z.enum(["create", "edit", "delete", "enable", "disable", "single_alarm"]),
      schedule_id: z.string().regex(/^[0-9a-fA-F-]{8,64}$/).optional().describe("edit/delete: from whoop_smart_alarm."),
      days: z.array(z.enum(DAYS)).min(1).optional().describe("create/edit: the schedule's days."),
      mode: z.enum(ALARM_MODES).optional(),
      sleep_goal: z.enum(SLEEP_GOALS).optional().describe("Only with mode SLEEP_GOAL."),
      wake_time: z.string().optional().describe("Latest wake time, e.g. 06:45."),
      enabled: z.boolean().optional(),
      goal: z.enum(SAFE_ALARM_GOALS).optional().describe("single_alarm goal (default EXACT_TIME_PERFORM)."),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async (args) => {
    const { action, schedule_id, days, mode, sleep_goal, wake_time, enabled, goal, confirm } = args;
    const scheduleAction = action === "create" || action === "edit";
    if (!scheduleAction && (days || mode || sleep_goal)) return toolError(`action:${action} takes no days, mode or sleep_goal.`);
    if ((action === "edit" || action === "delete") && !schedule_id) return toolError(`action:${action} needs schedule_id (from whoop_smart_alarm).`);
    if ((action === "create" || action === "enable" || action === "disable" || action === "single_alarm") && schedule_id) {
      return toolError(`action:${action} takes no schedule_id.`);
    }
    if (goal && action !== "single_alarm") return toolError("goal is only for single_alarm; schedules use mode (+ sleep_goal).");
    if ((action === "delete" || action === "enable" || action === "disable") && (wake_time || enabled !== undefined)) {
      return toolError(`action:${action} takes no wake_time or enabled.`);
    }
    if (days && new Set(days).size !== days.length) return toolError("days has duplicates.");
    let wake: string | null = null;
    if (wake_time !== undefined) {
      wake = normalizeClockTime(wake_time);
      if (!wake) return toolError(`wake_time "${wake_time}" isn't a clock time; use 24h HH:MM, e.g. 06:45.`);
    }

    // Fresh pre-read: per-day rows (truth), master switch, next alarm.
    const before = await readSmartAlarm(client, true);
    const warnings: string[] = [];
    const respondReceipt = async (schedule: string | null, verified: boolean, noChange = false, after?: Awaited<ReturnType<typeof readSmartAlarm>>) => {
      const state = after ?? before;
      warnings.push(SYNC);
      return respond("whoop_smart_alarm_set", SmartAlarmSetOut, {
        action, schedule_id: schedule, verified, no_change: noChange,
        schedules: state.schedules, master_switch: state.master_switch, next_alarm: state.next_alarm, warnings,
      });
    };

    if (scheduleAction) {
      const current = action === "edit" ? before.schedules.filter((s) => s.id === schedule_id) : [];
      if (action === "edit" && !current.length) {
        return toolError(`No schedule ${schedule_id} (WHOOP's schedule PUT is an upsert and would create one). Use action:create.`);
      }
      const cur = current[0];
      const m: Mode | undefined = mode ?? (cur?.mode ?? undefined);
      if (!m) return toolError(action === "create" ? "create needs mode." : `Schedule ${schedule_id} has goal ${cur?.goal}; pass mode explicitly.`);
      if (sleep_goal && m !== "SLEEP_GOAL") return toolError("sleep_goal only applies to mode SLEEP_GOAL (WHOOP requires it empty otherwise).");
      const sg = m === "SLEEP_GOAL" ? sleep_goal ?? (cur?.mode === "SLEEP_GOAL" ? cur.sleep_goal : null) : null;
      if (m === "SLEEP_GOAL" && !sg) return toolError("mode SLEEP_GOAL needs sleep_goal.");
      if (m === "NO_ALARM" && enabled === true) return toolError("NO_ALARM is the off state; it can't be enabled:true (WHOOP rejects it).");
      const targetDays = days ?? [...new Set(current.flatMap((s) => s.days))];
      const w = wake ?? (cur ? `${cur.wake}:00` : null);
      if (!targetDays.length) return toolError("create needs days.");
      if (!w) return toolError("create needs wake_time.");
      const target: Target = {
        days: targetDays,
        mode: m,
        sleep_goal: sg,
        wake: w,
        enabled: m === "NO_ALARM" ? false : enabled ?? (mode ? true : cur?.enabled ?? true),
      };
      if (action === "edit" && scheduleMatches(current, target)) return respondReceipt(schedule_id!, true, true);

      for (const d of target.days) {
        const owner = before.schedules.find((s) => s.id !== schedule_id && s.days.includes(d));
        if (owner) warnings.push(`${d} moves off schedule ${owner.id} (${describe(owner)}).`);
      }
      for (const d of current.flatMap((s) => s.days)) {
        if (!target.days.includes(d)) warnings.push(`${d} leaves this schedule and becomes unscheduled.`);
      }
      if (action === "create" && before.master_switch !== true) warnings.push("Creating a schedule turns the recurring master switch on.");
      if (before.master_switch !== false) warnings.push("With the master switch on, schedule writes also reset the next alarm from tomorrow's schedule.");

      const body = scheduleBody(target);
      const path = action === "edit" ? `${SA_BFF}/schedule/${schedule_id}` : `${SA_BFF}/schedule`;
      const method = action === "edit" ? "PUT" : "POST";
      if (!confirm) return respond("whoop_smart_alarm_set", SmartAlarmSetOut, previewWith(method, path, body, [...warnings, SYNC], current.length ? current : undefined));

      let created: string | null = null;
      try {
        const res = action === "edit" ? await client.put(path, body) : await client.post(path, body);
        if (Array.isArray(res) && typeof res[0]?.schedule_id === "string") created = res[0].schedule_id;
      } catch (error) {
        if (error instanceof WhoopServerError) warnings.push(NO_RETRY);
        else if (error instanceof WhoopApiError) return writeRejected("schedule", path, error);
        else throw error;
      }
      const after = await readSmartAlarm(client, true);
      const id = action === "edit" ? schedule_id! : created;
      const verified = id !== null && scheduleMatches(after.schedules.filter((s) => s.id === id), target);
      if (!verified) warnings.push("The schedule didn't read back as requested; see schedules.");
      return respondReceipt(id, verified, false, after);
    }

    if (action === "delete") {
      const current = before.schedules.filter((s) => s.id === schedule_id);
      if (!current.length) return toolError(`No schedule ${schedule_id}. (WHOOP answers 204 to any delete, so totem won't send one it can't verify.)`);
      const freed = current.flatMap((s) => s.days);
      warnings.push(`${freed.join(", ")} become unscheduled.`);
      const path = `${SA}/alarm-schedule/${schedule_id}`;
      if (!confirm) return respond("whoop_smart_alarm_set", SmartAlarmSetOut, previewWith("DELETE", path, null, [...warnings, SYNC], current));
      try {
        await client.delete(path);
      } catch (error) {
        if (error instanceof WhoopServerError) warnings.push(NO_RETRY);
        else if (error instanceof WhoopApiError) return writeRejected("schedule delete", path, error);
        else throw error;
      }
      const gone = projectAlarmSchedules(await client.get(path, {}, { fresh: true })).schedules.length === 0;
      return respondReceipt(schedule_id!, gone, false, await readSmartAlarm(client, true));
    }

    if (action === "enable" || action === "disable") {
      const want = action === "enable";
      if (before.master_switch === want) return respondReceipt(null, true, true);
      warnings.push(want
        ? "Turning the master switch on resets the next alarm from tomorrow's schedule."
        : "Turning the master switch off also turns off the next alarm; each schedule keeps its own enabled flag.");
      const path = `${SA}/alarm-schedule/${action}`;
      if (!confirm) return respond("whoop_smart_alarm_set", SmartAlarmSetOut, previewWith("PUT", path, null, [...warnings, SYNC], { master_switch: before.master_switch }));
      try {
        await client.put(path, undefined);
      } catch (error) {
        if (error instanceof WhoopServerError) warnings.push(NO_RETRY);
        else if (error instanceof WhoopApiError) return writeRejected(`master ${action}`, path, error);
        else throw error;
      }
      const after = await readSmartAlarm(client, true);
      if (after.master_switch === "unavailable") warnings.push("The master switch couldn't be read back (WHOOP error).");
      return respondReceipt(null, after.master_switch === want, false, after);
    }

    // single_alarm: the next alarm only, via preferences. S1: allowlisted goals only, never anything else.
    if (!wake) return toolError("single_alarm needs wake_time.");
    const g = goal ?? "EXACT_TIME_PERFORM";
    if (!(SAFE_ALARM_GOALS as readonly string[]).includes(g)) return toolError(`goal ${g} isn't allowed.`);
    const on = enabled ?? true;
    const body = { upper_time_bound: wake, goal: g, time_zone_offset: tzOffset(), schedule_enabled: false, enabled: on };
    warnings.push("This turns the recurring master switch off: schedules stop setting alarms until you enable it again.");
    if (before.next_alarm === "unavailable") warnings.push("WHOOP can't currently read this account's alarm preferences (error); the write may fail. If so, fix Smart Alarm in the app.");
    const path = `${SA}/smartalarm/preferences`;
    if (!confirm) return respond("whoop_smart_alarm_set", SmartAlarmSetOut, previewWith("PUT", path, body, [...warnings, SYNC], { next_alarm: before.next_alarm, master_switch: before.master_switch }));
    try {
      await client.put(path, body);
    } catch (error) {
      if (error instanceof WhoopServerError) warnings.push(NO_RETRY);
      else if (error instanceof WhoopApiError) return writeRejected("single alarm", path, error);
      else throw error;
    }
    const after = await readSmartAlarm(client, true);
    const next = after.next_alarm;
    const verified = next !== "unavailable" && next.goal === g && next.to === wake.slice(0, 5) && next.enabled === on
      && after.master_switch === false;
    if (!verified) warnings.push(next === "unavailable" ? "The next alarm couldn't be read back (WHOOP error)." : "The next alarm didn't read back as requested.");
    return respondReceipt(null, verified, false, after);
  });
}
