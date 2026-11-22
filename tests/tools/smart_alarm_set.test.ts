// Unit tests only: no live Smart Alarm writes (the test account's alarm prefs are broken).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { minusMinutes, registerSmartAlarm } from "../../src/tools/v2/smart_alarm.js";
import { registerSmartAlarmSet } from "../../src/tools/v2/smart_alarm_set.js";
import { WhoopApiError, WhoopServerError } from "../../src/whoop/errors.js";
import { call, connect, fx, mockClient, routedGet, seq } from "./health_plans_helpers.js";

const SA = "/smart-alarm-service/v1";
const BFF = "/smart-alarm-bff/v1";
const ROWS = `${SA}/alarm-schedule`;
const ALL = `${BFF}/schedule/all`;
const PREFS = `${SA}/smartalarm/preferences`;
const GREEN = "876be9f6-c413-4ea5-9fcf-b45ffc073baa";
const SLEEP = "9e06f7da-7261-4ba1-b0a2-ec2d41f2f14d";

beforeAll(() => { process.env.WHOOP_TIMEZONE = "America/Los_Angeles"; });

const r = (id: string, day: string, goal: string, upper: string, enabled = true) =>
  ({ schedule_id: id, day_of_week: day, upper_time_bound: upper, goal, enabled, deleted: false });
const baseRows = () => fx("alarm_schedule_rows.json") as unknown[];
const e500 = (p: string) => new WhoopServerError(500, p, "Error 500 Internal Server Error");

/** Healthy account: rows + schedule/all + preferences. */
function healthy(rows: unknown[] | ReturnType<typeof seq>, prefs: unknown = fx("alarm_preferences.json")) {
  return routedGet({ [ROWS]: rows, [ALL]: fx("alarm_schedule_all.json"), [PREFS]: prefs });
}
/** The damaged test account: preferences and schedule/all 500. */
function damaged(rows: unknown[] | ReturnType<typeof seq>) {
  return routedGet({ [ROWS]: rows, [ALL]: e500(ALL), [PREFS]: e500(PREFS) });
}

describe("whoop_smart_alarm", () => {
  it("reads alarm-schedule as truth and the switch + next alarm from the others", async () => {
    const client = await connect((s) => registerSmartAlarm(s, mockClient({ get: healthy(baseRows()) })));
    const { out } = await call(client, "whoop_smart_alarm", {});
    expect(out.master_switch).toBe(true);
    expect(out.schedules[1]).toMatchObject({ id: SLEEP, mode: "SLEEP_GOAL", sleep_goal: "PERFORM", wake: "06:45" });
    expect(out.next_alarm).toMatchObject({ date: "2026-11-22", goal: "SLEEP_HEALTH_GET_BY" });
    expect(out.note).toBeUndefined();
  });

  it("adds the wake window and, for goal modes only, the earliest buzz", async () => {
    const get = routedGet({ [ROWS]: baseRows(), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json"), [`${SA}/user-info/default-wake-window`]: { default_wake_window_minutes: 60 } });
    const client = await connect((s) => registerSmartAlarm(s, mockClient({ get })));
    const { out } = await call(client, "whoop_smart_alarm", {});
    expect(out.wake_window_min).toBe(60);
    expect(out.schedules[1]).toMatchObject({ mode: "SLEEP_GOAL", wake: "06:45", earliest: "05:45" });
    for (const sc of out.schedules) {
      if (sc.mode === "IN_THE_GREEN" || sc.mode === "SLEEP_GOAL") expect(sc.earliest).toBe(minusMinutes(sc.wake, 60));
      else expect(sc.earliest).toBeUndefined();
    }
    expect(minusMinutes("00:30", 60)).toBe("23:30");
    expect(minusMinutes("07:35", 45)).toBe("06:50");
  });

  it("leaves the window out when WHOOP doesn't answer it", async () => {
    const client = await connect((s) => registerSmartAlarm(s, mockClient({ get: healthy(baseRows()) })));
    const { out } = await call(client, "whoop_smart_alarm", {});
    expect(out.wake_window_min).toBeUndefined();
    expect(out.schedules.every((sc: { earliest?: string }) => sc.earliest === undefined)).toBe(true);
  });

  it("returns 'unavailable' when preferences and schedule/all 500", async () => {
    const client = await connect((s) => registerSmartAlarm(s, mockClient({ get: damaged(baseRows()) })));
    const { out, isError } = await call(client, "whoop_smart_alarm", {});
    expect(isError).toBe(false);
    expect(out).toMatchObject({ master_switch: "unavailable", next_alarm: "unavailable" });
    expect(out.schedules).toHaveLength(2);
    expect(out.note).toMatch(/open Smart Alarm in the WHOOP app/);
  });
});

describe("whoop_smart_alarm_set validation (S1, S2)", () => {
  it.each(["ALARM_OFF_PEAK", "EXACT_TIME_WEEKLY_PLAN", "EXACT_TIME_SLEEP_HOURS", "EXACT_TIME_GET_BY", "ALARM_OFF_PERFORM", "ALARM_OFF_GET_BY", "NOT_A_GOAL"])(
    "never accepts preferences goal %s", async (goal) => {
      const put = vi.fn();
      const get = healthy(baseRows());
      const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get, put })));
      const res = await client.callTool({ name: "whoop_smart_alarm_set", arguments: { action: "single_alarm", wake_time: "07:00", goal, confirm: true } });
      expect(res.isError).toBe(true);
      expect(put).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

  it.each(["EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP"])("rejects the legacy value %s as a schedule mode", async (mode) => {
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: healthy(baseRows()) })));
    const res = await client.callTool({ name: "whoop_smart_alarm_set", arguments: { action: "create", days: ["FRI"], mode, wake_time: "07:00" } });
    expect(res.isError).toBe(true);
  });

  it.each([
    [{ action: "create", days: ["FRI"], mode: "SLEEP_GOAL", wake_time: "07:00" }, /needs sleep_goal/],
    [{ action: "create", days: ["FRI"], mode: "EXACT_TIME", sleep_goal: "PEAK", wake_time: "07:00" }, /only applies to mode SLEEP_GOAL/],
    [{ action: "create", days: ["FRI"], mode: "NO_ALARM", enabled: true, wake_time: "07:00" }, /off state/],
    [{ action: "create", days: ["FRI"], mode: "EXACT_TIME" }, /needs wake_time/],
    [{ action: "create", days: ["FRI", "FRI"], mode: "EXACT_TIME", wake_time: "07:00" }, /duplicates/],
    [{ action: "create", days: ["FRI"], mode: "EXACT_TIME", wake_time: "9:75" }, /isn't a clock time/],
    [{ action: "edit", schedule_id: "aaaaaaaa-0000", wake_time: "07:00" }, /PUT is an upsert/],
    [{ action: "delete", schedule_id: "aaaaaaaa-0000" }, /204 to any delete/],
    [{ action: "edit", wake_time: "07:00" }, /needs schedule_id/],
    [{ action: "enable", days: ["MON"] }, /takes no days/],
    [{ action: "create", days: ["FRI"], mode: "EXACT_TIME", wake_time: "07:00", goal: "IN_THE_GREEN" }, /only for single_alarm/],
  ])("%j", async (args, re) => {
    const put = vi.fn();
    const post = vi.fn();
    const del = vi.fn();
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: healthy(baseRows()), put, post, delete: del })));
    const { isError, out } = await call(client, "whoop_smart_alarm_set", { ...args, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(re);
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});

describe("whoop_smart_alarm_set schedules", () => {
  it("create: all six fields, sleep_goal \"\", warns when a day moves and about the master switch; reads back the new id", async () => {
    const created = [r("new-sched-1", "MONDAY", "EXACT_TIME_PERFORM", "06:15:00"), r("new-sched-1", "FRIDAY", "EXACT_TIME_PERFORM", "06:15:00")];
    const after = [...baseRows().filter((x) => (x as { day_of_week: string }).day_of_week !== "MONDAY"), ...created];
    const post = vi.fn().mockResolvedValue(created);
    const get = healthy(seq(baseRows(), baseRows(), after));
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get, post })));
    const args = { action: "create", days: ["MON", "FRI"], mode: "EXACT_TIME", wake_time: "06:15" };
    const preview = await call(client, "whoop_smart_alarm_set", args);
    const body = preview.out.will_execute.body_summary;
    expect(preview.out.will_execute).toMatchObject({ method: "POST", path: `${BFF}/schedule` });
    expect(body).toEqual({ day_of_week_list: ["MONDAY", "FRIDAY"], latest_wake_time: "06:15:00", alarm_mode: "EXACT_TIME", time_zone_offset: expect.stringMatching(/^[+-]\d{4}$/), sleep_goal: "", enabled: true });
    expect(preview.out.warnings.join(" ")).toMatch(new RegExp(`MON moves off schedule ${GREEN} \\(IN_THE_GREEN 07:35\\)`));
    expect(preview.out.warnings.join(" ")).toMatch(/Open the WHOOP app/);
    expect(post).not.toHaveBeenCalled();

    const { out } = await call(client, "whoop_smart_alarm_set", { ...args, confirm: true });
    expect(post).toHaveBeenCalledWith(`${BFF}/schedule`, body);
    expect(out).toMatchObject({ action: "create", schedule_id: "new-sched-1", verified: true, no_change: false });
    expect(out.warnings.join(" ")).toMatch(/strap/);
  });

  it("create SLEEP_GOAL sends the sleep goal; NO_ALARM forces enabled:false", async () => {
    const post = vi.fn().mockResolvedValue([]);
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: healthy(baseRows()), post })));
    const sleep = await call(client, "whoop_smart_alarm_set", { action: "create", days: ["SAT", "SUN"], mode: "SLEEP_GOAL", sleep_goal: "GET_BY", wake_time: "08:10" });
    expect(sleep.out.will_execute.body_summary).toMatchObject({ alarm_mode: "SLEEP_GOAL", sleep_goal: "GET_BY", enabled: true });
    const off = await call(client, "whoop_smart_alarm_set", { action: "create", days: ["FRI"], mode: "NO_ALARM", wake_time: "09:00" });
    expect(off.out.will_execute.body_summary).toMatchObject({ alarm_mode: "NO_ALARM", sleep_goal: "", enabled: false });
  });

  it("edit merges onto the current schedule and PUTs the full body", async () => {
    const put = vi.fn().mockResolvedValue([]);
    const after = baseRows().map((x) => ((x as { schedule_id: string }).schedule_id === SLEEP ? { ...(x as object), upper_time_bound: "06:30:00" } : x));
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: healthy(seq(baseRows(), after)), put })));
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: SLEEP, wake_time: "06:30", confirm: true });
    expect(put).toHaveBeenCalledWith(`${BFF}/schedule/${SLEEP}`, expect.objectContaining({
      day_of_week_list: ["WEDNESDAY", "THURSDAY"], latest_wake_time: "06:30:00", alarm_mode: "SLEEP_GOAL", sleep_goal: "PERFORM", enabled: true,
    }));
    expect(out.verified).toBe(true);
  });

  it("edit that drops a day says it becomes unscheduled", async () => {
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: healthy(baseRows()) })));
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: GREEN, days: ["MON"] });
    expect(out.warnings.join(" ")).toMatch(/TUE leaves this schedule and becomes unscheduled/);
  });

  it("a schedule PUT that saves then 500s (damaged account) is read back, never retried", async () => {
    const put = vi.fn().mockRejectedValue(e500(`${BFF}/schedule/${GREEN}`));
    const saved = baseRows().map((x) => ((x as { schedule_id: string }).schedule_id === GREEN ? { ...(x as object), upper_time_bound: "07:40:00" } : x));
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: damaged(seq(baseRows(), saved)), put })));
    const { out, isError } = await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: GREEN, wake_time: "07:40", confirm: true });
    expect(isError).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ verified: true, master_switch: "unavailable", next_alarm: "unavailable" });
    expect(out.warnings.join(" ")).toMatch(/never retries/);
  });

  it("a 422 is a structured error", async () => {
    const put = vi.fn().mockRejectedValue(new WhoopApiError(422, `${BFF}/schedule/${GREEN}`, ""));
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: healthy(baseRows()), put })));
    const { isError, out } = await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: GREEN, wake_time: "07:40", confirm: true });
    expect(isError).toBe(true);
    expect(out.status).toBe(422);
  });

  it("delete uses the service path and verifies GET by id → []", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const get = routedGet({ [ROWS]: seq(baseRows(), baseRows().slice(0, 1)), [`${ROWS}/${SLEEP}`]: [], [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") });
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get, delete: del })));
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "delete", schedule_id: SLEEP, confirm: true });
    expect(del).toHaveBeenCalledWith(`${ROWS}/${SLEEP}`);
    expect(get).toHaveBeenCalledWith(`${ROWS}/${SLEEP}`, {}, { fresh: true });
    expect(out).toMatchObject({ action: "delete", verified: true });
    expect(out.warnings.join(" ")).toMatch(/WED, THU become unscheduled/);
  });
});

describe("whoop_smart_alarm_set master switch and single alarm", () => {
  it("disable PUTs with no body; already-on enable is a no-op", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const offAll = { ...(fx("alarm_schedule_all.json") as object), schedule_enabled: false };
    // settings §2.1: disable sets preferences schedule_enabled:false AND enabled:false.
    const offPrefs = { ...(fx("alarm_preferences.json") as object), schedule_enabled: false, enabled: false, day_of_week: null };
    const get = routedGet({ [ROWS]: baseRows(), [ALL]: seq(fx("alarm_schedule_all.json"), offAll), [PREFS]: seq(fx("alarm_preferences.json"), offPrefs) });
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get, put })));
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "disable", confirm: true });
    expect(put).toHaveBeenCalledWith(`${SA}/alarm-schedule/disable`, undefined);
    expect(out).toMatchObject({ verified: true, master_switch: false, next_alarm: { enabled: false } });
    expect(out.warnings.join(" ")).toMatch(/also turns off the next alarm/);

    const again = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: healthy(baseRows()), put: vi.fn() })));
    expect((await call(again, "whoop_smart_alarm_set", { action: "enable", confirm: true })).out).toMatchObject({ no_change: true, verified: true });
  });

  it("single_alarm: allowlisted goal, schedule_enabled:false, no weekly_plan_goal/default; read back from preferences", async () => {
    const put = vi.fn().mockResolvedValue({});
    const prefsAfter = { ...(fx("alarm_preferences.json") as object), goal: "EXACT_TIME_PERFORM", upper_time_bound: "07:00:00", lower_time_bound: "06:00:00", alarm_bounds: "['2026-11-22T06:00:00.000-08','2026-11-22T07:00:00.000-08']", schedule_enabled: false, enabled: true };
    const allAfter = { ...(fx("alarm_schedule_all.json") as object), schedule_enabled: false };
    const get = routedGet({ [ROWS]: baseRows(), [ALL]: seq(fx("alarm_schedule_all.json"), fx("alarm_schedule_all.json"), allAfter), [PREFS]: seq(fx("alarm_preferences.json"), fx("alarm_preferences.json"), prefsAfter) });
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get, put })));
    const preview = await call(client, "whoop_smart_alarm_set", { action: "single_alarm", wake_time: "7:00 AM" });
    expect(preview.out.warnings.join(" ")).toMatch(/turns the recurring master switch off/);
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "single_alarm", wake_time: "7:00 AM", confirm: true });
    const body = put.mock.calls[0]![1] as Record<string, unknown>;
    expect(put.mock.calls[0]![0]).toBe(PREFS);
    expect(body).toEqual({ upper_time_bound: "07:00:00", goal: "EXACT_TIME_PERFORM", time_zone_offset: expect.stringMatching(/^[+-]\d{4}$/), schedule_enabled: false, enabled: true });
    expect(body).not.toHaveProperty("weekly_plan_goal");
    expect(body).not.toHaveProperty("default");
    expect(out).toMatchObject({ action: "single_alarm", verified: true, master_switch: false });
  });

  it("single_alarm on the damaged account: warns, sends once, reports unverified on 500", async () => {
    const put = vi.fn().mockRejectedValue(e500(PREFS));
    const client = await connect((s) => registerSmartAlarmSet(s, mockClient({ get: damaged(baseRows()), put })));
    const preview = await call(client, "whoop_smart_alarm_set", { action: "single_alarm", wake_time: "07:00", goal: "SLEEP_HEALTH_PEAK" });
    expect(preview.out.warnings.join(" ")).toMatch(/can't currently read this account's alarm preferences/);
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "single_alarm", wake_time: "07:00", goal: "SLEEP_HEALTH_PEAK", confirm: true });
    expect(put).toHaveBeenCalledTimes(1);
    expect(out.verified).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/never retries/);
  });
});
