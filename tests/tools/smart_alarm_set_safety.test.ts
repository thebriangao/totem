// S1/S2 proof for whoop_smart_alarm_set: whatever the input (every action, every
// server goal, junk values, passthrough fields) and whatever is stored on the
// account (all 13 server goals, unknown ones), every request the tool sends is one
// of the five verified writes with a verified body, and none is sent twice.
// No live Smart Alarm writes: a bad one permanently breaks an account's alarm settings.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerSmartAlarmSet } from "../../src/tools/v2/smart_alarm_set.js";
import { WhoopClient } from "../../src/whoop/client.js";
import { WhoopApiError, WhoopServerError } from "../../src/whoop/errors.js";
import { call, connect, fx, mockClient, routedGet, seq } from "./health_plans_helpers.js";

const SA = "/smart-alarm-service/v1";
const BFF = "/smart-alarm-bff/v1";
const ROWS = `${SA}/alarm-schedule`;
const ALL = `${BFF}/schedule/all`;
const PREFS = `${SA}/smartalarm/preferences`;
const A = "876be9f6-c413-4ea5-9fcf-b45ffc073baa";
const B = "9e06f7da-7261-4ba1-b0a2-ec2d41f2f14d";

const SAFE_GOALS = ["EXACT_TIME_PERFORM", "EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP", "IN_THE_GREEN", "SLEEP_HEALTH_PEAK", "SLEEP_HEALTH_PERFORM", "SLEEP_HEALTH_GET_BY"];
/** The rest of WHOOP's own SmartAlarmGoal enum: three of these broke the test account. */
const UNSAFE_GOALS = ["ALARM_OFF_PEAK", "ALARM_OFF_PERFORM", "ALARM_OFF_GET_BY", "EXACT_TIME_WEEKLY_PLAN", "EXACT_TIME_SLEEP_HOURS", "EXACT_TIME_GET_BY"];
const MODES = ["EXACT_TIME", "SLEEP_GOAL", "IN_THE_GREEN", "NO_ALARM"];
const WIRE_DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const SHORT_DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

beforeAll(() => { process.env.WHOOP_TIMEZONE = "America/Los_Angeles"; });

type Write = { method: "PUT" | "POST" | "DELETE"; path: string; body: unknown };
const row = (id: string, day: string, goal: string, upper = "07:35:00", enabled = true) =>
  ({ schedule_id: id, day_of_week: day, upper_time_bound: upper, goal, enabled, deleted: false });
const e500 = (p: string) => new WhoopServerError(500, p, "Error 500 Internal Server Error");

/** The whole safety contract for one request. Throws (fails the test) on any violation. */
function assertSafeWrite(w: Write): void {
  const body = w.body as Record<string, unknown>;
  if (w.path === PREFS) {
    expect(w.method).toBe("PUT");
    // Exactly the body verified on a healthy account: no weekly_plan_goal, no default, nothing else.
    expect(Object.keys(body).sort()).toEqual(["enabled", "goal", "schedule_enabled", "time_zone_offset", "upper_time_bound"]);
    expect(SAFE_GOALS).toContain(body.goal);
    expect(body.schedule_enabled).toBe(false);
    expect(body.enabled).toBe(true);
    expect(body.upper_time_bound).toMatch(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/);
    expect(body.time_zone_offset).toMatch(/^[+-]\d{4}$/);
    return;
  }
  if (w.path === `${BFF}/schedule` || w.path.startsWith(`${BFF}/schedule/`)) {
    expect(w.method).toBe(w.path === `${BFF}/schedule` ? "POST" : "PUT");
    if (w.method === "PUT") expect(w.path).toMatch(new RegExp(`^${BFF}/schedule/[0-9a-f-]{36}$`));
    expect(Object.keys(body).sort()).toEqual(["alarm_mode", "day_of_week_list", "enabled", "latest_wake_time", "sleep_goal", "time_zone_offset"]);
    expect(MODES).toContain(body.alarm_mode);
    if (body.alarm_mode === "SLEEP_GOAL") expect(["PEAK", "PERFORM", "GET_BY"]).toContain(body.sleep_goal);
    else expect(body.sleep_goal).toBe("");
    expect(typeof body.enabled).toBe("boolean");
    if (body.alarm_mode === "NO_ALARM") expect(body.enabled).toBe(false);
    expect(body.latest_wake_time).toMatch(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/);
    expect(body.time_zone_offset).toMatch(/^[+-]\d{4}$/);
    const days = body.day_of_week_list as string[];
    expect(days.length).toBeGreaterThan(0);
    expect(new Set(days).size).toBe(days.length);
    for (const d of days) expect(WIRE_DAYS).toContain(d);
    return;
  }
  if (w.path === `${ROWS}/enable` || w.path === `${ROWS}/disable`) {
    expect(w.method).toBe("PUT");
    expect(w.body).toBeUndefined();
    return;
  }
  expect(w.method).toBe("DELETE");
  expect(w.path).toMatch(new RegExp(`^${ROWS}/[0-9a-f-]{36}$`));
}

/** A mocked WHOOP client that records every write and answers as `outcome` says. */
function recorder(getRoutes: Parameters<typeof routedGet>[0], outcome: (w: Write) => unknown = () => []) {
  const writes: Write[] = [];
  const send = (method: Write["method"]) => vi.fn(async (path: string, body?: unknown) => {
    const w: Write = { method, path, body: method === "DELETE" ? undefined : body };
    writes.push(w);
    const r = outcome(w);
    if (r instanceof Error) throw r;
    return r;
  });
  const get = routedGet(getRoutes);
  return { writes, get, client: mockClient({ get, put: send("PUT"), post: send("POST"), delete: send("DELETE") }) };
}

// Small deterministic PRNG so a failure reproduces.
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("whoop_smart_alarm_set: no input can produce an unverified write", () => {
  it("3,000 random calls (junk goals/modes, passthrough fields, dangerous stored goals, 500s): every write is safe and sent once", async () => {
    const rnd = prng(20261121);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const maybe = <T>(v: T, p = 0.5): T | undefined => (rnd() < p ? v : undefined);
    const STORED = [...SAFE_GOALS, ...UNSAFE_GOALS, "SOMETHING_NEW", ""];
    let rows: unknown[] = [];
    let healthy = true;
    let outcome: (w: Write) => unknown = () => [];
    const rec = recorder({
      [ROWS]: () => rows,
      [`${ROWS}/${A}`]: () => rows.filter((r) => (r as { schedule_id: string }).schedule_id === A),
      [`${ROWS}/${B}`]: () => rows.filter((r) => (r as { schedule_id: string }).schedule_id === B),
      [ALL]: () => (healthy ? { schedule_enabled: rnd() < 0.5 } : e500(ALL)),
      [PREFS]: () => (healthy ? { ...(fx("alarm_preferences.json") as object), goal: pick(STORED), enabled: rnd() < 0.5, schedule_enabled: rnd() < 0.5 } : e500(PREFS)),
    }, (w) => outcome(w));
    const client: Client = await connect((s) => registerSmartAlarmSet(s, rec.client));

    const sent: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) {
      rows = WIRE_DAYS.flatMap((day) => (rnd() < 0.6 ? [row(pick([A, B]), day, pick(STORED), pick(["07:35:00", "06:45:00"]), rnd() < 0.7)] : []));
      healthy = rnd() < 0.6;
      const result = pick(["ok", "ok", "500", "422"]);
      outcome = (w) => (result === "500" ? e500(w.path) : result === "422" ? new WhoopApiError(422, w.path, "") : w.method === "POST" ? [row(B, "FRIDAY", "EXACT_TIME_PERFORM")] : []);
      // A valid call for a random action…
      const action = pick(["create", "edit", "edit", "delete", "enable", "disable", "single_alarm", "single_alarm"]);
      const args: Record<string, unknown> = { action, confirm: rnd() < 0.9 };
      const someDays = () => SHORT_DAYS.filter(() => rnd() < 0.35).concat(pick(SHORT_DAYS)).filter((d, n, xs) => xs.indexOf(d) === n);
      const wake = () => pick(["06:45", "7:00 AM", "23:59:59", "00:00", "12:30 pm"]);
      if (action === "create" || action === "edit") {
        if (action === "edit") args.schedule_id = pick([A, B]);
        if (action === "create" || rnd() < 0.5) args.days = someDays();
        if (action === "create" || rnd() < 0.6) {
          args.mode = pick(MODES);
          if (args.mode === "SLEEP_GOAL") args.sleep_goal = pick(["PEAK", "PERFORM", "GET_BY"]);
        }
        if (action === "create" || rnd() < 0.6) args.wake_time = wake();
        if (rnd() < 0.4 && args.mode !== "NO_ALARM") args.enabled = rnd() < 0.5;
      } else if (action === "delete") {
        args.schedule_id = pick([A, B]);
      } else if (action === "single_alarm") {
        args.wake_time = wake();
        if (rnd() < 0.7) args.goal = pick(SAFE_GOALS);
      }
      // …then, often, one field replaced by something hostile…
      if (rnd() < 0.4) {
        const [k, v] = pick<[string, unknown]>([
          ...UNSAFE_GOALS.map((g): [string, unknown] => ["goal", g]),
          ["goal", "NOT_A_GOAL"], ["goal", null], ["goal", pick(SAFE_GOALS)],
          ["mode", "EXACT_TIME_PEAK"], ["mode", "ALARM_OFF_PEAK"], ["mode", "EXACT_TIME_WEEKLY_PLAN"], ["mode", "NO_ALARM"], ["mode", "SLEEP_GOAL"], ["mode", ""],
          ["sleep_goal", "WEEKLY_PLAN"], ["sleep_goal", ""], ["sleep_goal", "PEAK"], ["sleep_goal", null],
          ["wake_time", "25:00"], ["wake_time", "9:75"], ["wake_time", ""], ["wake_time", "06:45:00.000"],
          ["enabled", true], ["enabled", false], ["enabled", "true"], ["enabled", null],
          ["schedule_id", "00000000-0000-4000-8000-000000000000"], ["schedule_id", "../preferences"], ["schedule_id", A],
          ["days", []], ["days", ["WED", "WED"]], ["days", ["MONDAY"]], ["days", SHORT_DAYS],
          ["action", "preferences"], ["action", pick(["create", "edit", "delete", "enable", "disable", "single_alarm"])],
        ]);
        args[k] = v;
      }
      // …and WHOOP's own preference/schedule keys the tool doesn't have, including the two S1 bans.
      const put = (k: string, v: unknown) => { if (v !== undefined) args[k] = v; };
      put("weekly_plan_goal", maybe(pick([0, 85]), 0.3));
      put("default", maybe(pick([true, false]), 0.3));
      put("weekly_plan_sleep_hours_goal_in_minutes", maybe(480, 0.2));
      put("lower_time_bound", maybe("06:00:00", 0.2));
      put("alarm_mode", maybe("EXACT_TIME_PEAK", 0.2));
      put("schedule_enabled", maybe(true, 0.2));

      rec.writes.length = 0;
      await client.callTool({ name: "whoop_smart_alarm_set", arguments: args });
      for (const w of rec.writes) assertSafeWrite(w);
      // S1: never retried, whatever WHOOP answered. (delete/enable/disable/edit/create/single = one request each.)
      expect(rec.writes.length, JSON.stringify(args)).toBeLessThanOrEqual(1);
      for (const w of rec.writes) {
        const kind = w.path === PREFS ? "single_alarm" : w.method === "POST" ? "create" : w.method === "DELETE" ? "delete" : w.path.startsWith(BFF) ? "edit" : w.path.slice(ROWS.length + 1);
        sent[kind] = (sent[kind] ?? 0) + 1;
      }
    }
    // The sweep is meaningful only if every kind of write was actually sent, many times.
    for (const kind of ["single_alarm", "create", "edit", "delete", "enable", "disable"]) {
      expect(sent[kind] ?? 0, `${kind}: ${JSON.stringify(sent)}`).toBeGreaterThan(80);
    }
  }, 60_000);

  it.each(SAFE_GOALS)("single_alarm sends allowlisted goal %s in the verified five-key body", async (goal) => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") }, () => ({}));
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    await call(client, "whoop_smart_alarm_set", { action: "single_alarm", wake_time: "07:00", goal, confirm: true });
    expect(rec.writes).toEqual([{ method: "PUT", path: PREFS, body: { upper_time_bound: "07:00:00", goal, time_zone_offset: "-0800", schedule_enabled: false, enabled: true } }]);
  });

  it.each([...UNSAFE_GOALS, "NOT_A_GOAL", "exact_time_perform", " EXACT_TIME_PERFORM"])("single_alarm refuses goal %j before any request, with or without confirm", async (goal) => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") });
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    for (const confirm of [true, false]) {
      const res = await client.callTool({ name: "whoop_smart_alarm_set", arguments: { action: "single_alarm", wake_time: "07:00", goal, confirm } });
      expect(res.isError).toBe(true);
    }
    expect(rec.writes).toEqual([]);
    expect(rec.get).not.toHaveBeenCalled();
  });

  it("passthrough fields never reach WHOOP: weekly_plan_goal, default and friends are dropped or refused", async () => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") }, () => ({}));
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const extra = { weekly_plan_goal: 85, default: true, weekly_plan_sleep_hours_goal_in_minutes: 480, lower_time_bound: "06:00:00", schedule_enabled: true, day_of_week: "SUNDAY" };
    await client.callTool({ name: "whoop_smart_alarm_set", arguments: { action: "single_alarm", wake_time: "07:00", confirm: true, ...extra } });
    await client.callTool({ name: "whoop_smart_alarm_set", arguments: { action: "create", days: ["FRI"], mode: "EXACT_TIME", wake_time: "07:00", confirm: true, ...extra, alarm_mode: "EXACT_TIME_PEAK", sleep_goal_value: "PEAK" } });
    await client.callTool({ name: "whoop_smart_alarm_set", arguments: { action: "edit", schedule_id: A, wake_time: "07:40", confirm: true, ...extra, goal_override: "ALARM_OFF_PEAK" } });
    // Unknown arguments are stripped by the input schema, so all three writes go out, clean.
    expect(rec.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`PUT ${PREFS}`, `POST ${BFF}/schedule`, `PUT ${BFF}/schedule/${A}`]);
    for (const w of rec.writes) {
      assertSafeWrite(w);
      expect(JSON.stringify(w.body)).not.toMatch(/weekly_plan|default|lower_time_bound|ALARM_OFF|EXACT_TIME_PEAK/);
    }
  });
});

describe("whoop_smart_alarm_set: schedule edits can't carry a stored goal or a stale sleep goal", () => {
  const stored = (goal: string, enabled = true) => [row(A, "MONDAY", goal, "07:35:00", enabled), row(A, "TUESDAY", goal, "07:35:00", enabled)];

  it.each([...UNSAFE_GOALS, "SOMETHING_NEW"])("editing a schedule stored with %s never writes that goal", async (goal) => {
    const rec = recorder({ [ROWS]: stored(goal), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") });
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const wakeOnly = await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: A, wake_time: "07:40", confirm: true });
    const withMode = await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: A, mode: "IN_THE_GREEN", wake_time: "07:40", confirm: true });
    if (!goal.startsWith("EXACT_TIME_")) {
      // No schedule mode stores this goal, so totem won't guess one.
      expect(wakeOnly.isError).toBe(true);
      expect(wakeOnly.out.error).toMatch(/pass mode explicitly/);
    }
    expect(withMode.isError).toBe(false);
    expect(rec.writes.length).toBeGreaterThan(0);
    for (const w of rec.writes) {
      assertSafeWrite(w);
      expect(JSON.stringify(w.body)).not.toContain(goal);
    }
  });

  it("SLEEP_GOAL → another mode sends sleep_goal \"\" (the old PERFORM is not carried)", async () => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") });
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    for (const mode of ["EXACT_TIME", "IN_THE_GREEN", "NO_ALARM"]) {
      await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: B, mode, confirm: true });
    }
    expect(rec.writes.map((w) => (w.body as { sleep_goal: string }).sleep_goal)).toEqual(["", "", ""]);
    expect(rec.writes.map((w) => (w.body as { enabled: boolean }).enabled)).toEqual([true, true, false]);
    for (const w of rec.writes) assertSafeWrite(w);
  });

  it("NO_ALARM forces enabled:false on an enabled schedule; enabled:true with NO_ALARM is refused", async () => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") });
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const refused = await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: A, mode: "NO_ALARM", enabled: true, confirm: true });
    expect(refused.isError).toBe(true);
    expect(rec.writes).toEqual([]);
    await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: A, mode: "NO_ALARM", confirm: true });
    expect(rec.writes[0]!.body).toMatchObject({ alarm_mode: "NO_ALARM", sleep_goal: "", enabled: false, day_of_week_list: ["MONDAY", "TUESDAY"], latest_wake_time: "07:35:00" });
  });

  it("an edit that claims another schedule's day says so in the preview and in the receipt", async () => {
    const after = (fx("alarm_schedule_rows.json") as Array<Record<string, unknown>>).map((r) => (r.day_of_week === "WEDNESDAY" ? { ...r, schedule_id: A, goal: "IN_THE_GREEN", upper_time_bound: "07:35:00" } : r));
    const rec = recorder({ [ROWS]: seq(fx("alarm_schedule_rows.json"), fx("alarm_schedule_rows.json"), after), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") });
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const args = { action: "edit", schedule_id: A, days: ["MON", "TUE", "WED"] };
    const preview = await call(client, "whoop_smart_alarm_set", args);
    expect(preview.out.preview).toBe(true);
    expect(preview.out.warnings.join(" ")).toMatch(new RegExp(`WED moves off schedule ${B} \\(SLEEP_GOAL PERFORM 06:45\\)`));
    expect(rec.writes).toEqual([]);
    const { out } = await call(client, "whoop_smart_alarm_set", { ...args, confirm: true });
    expect(out.verified).toBe(true);
    expect(out.warnings.join(" ")).toMatch(new RegExp(`WED moves off schedule ${B}`));
  });
});

describe("whoop_smart_alarm_set: a 500 is read back, never retried", () => {
  it("create that saved the rows and then answered 500 reports the new schedule from the rows", async () => {
    const NEW = "11111111-2222-4333-8444-555555555555";
    const saved = [...(fx("alarm_schedule_rows.json") as unknown[]), row(NEW, "FRIDAY", "EXACT_TIME_PERFORM", "06:15:00")];
    const rec = recorder({ [ROWS]: seq(fx("alarm_schedule_rows.json"), saved), [ALL]: e500(ALL), [PREFS]: e500(PREFS) }, (w) => e500(w.path));
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const { out, isError } = await call(client, "whoop_smart_alarm_set", { action: "create", days: ["FRI"], mode: "EXACT_TIME", wake_time: "06:15", confirm: true });
    expect(isError).toBe(false);
    expect(rec.writes).toHaveLength(1);
    expect(out).toMatchObject({ action: "create", schedule_id: NEW, verified: true });
    expect(out.warnings.join(" ")).toMatch(/never retries/);
  });

  it("create that answered 500 and saved nothing is verified:false, sent once", async () => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: e500(ALL), [PREFS]: e500(PREFS) }, (w) => e500(w.path));
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "create", days: ["FRI"], mode: "EXACT_TIME", wake_time: "06:15", confirm: true });
    expect(rec.writes).toHaveLength(1);
    expect(out.verified).toBe(false);
    expect(out.schedule_id).toBeUndefined();
  });

  it.each(["enable", "disable"])("%s that answers 500 is sent once and reported unverified", async (action) => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: e500(ALL), [PREFS]: e500(PREFS) }, (w) => e500(w.path));
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const { out, isError } = await call(client, "whoop_smart_alarm_set", { action, confirm: true });
    expect(isError).toBe(false);
    expect(rec.writes).toEqual([{ method: "PUT", path: `${ROWS}/${action}`, body: undefined }]);
    expect(out).toMatchObject({ verified: false, master_switch: "unavailable" });
    expect(out.warnings.join(" ")).toMatch(/never retries/);
  });

  it("delete that answers 500 is sent once; the rows decide verified", async () => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [`${ROWS}/${B}`]: (fx("alarm_schedule_rows.json") as Array<{ schedule_id: string }>).filter((r) => r.schedule_id === B), [ALL]: e500(ALL), [PREFS]: e500(PREFS) }, (w) => e500(w.path));
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "delete", schedule_id: B, confirm: true });
    expect(rec.writes).toEqual([{ method: "DELETE", path: `${ROWS}/${B}`, body: undefined }]);
    expect(out.verified).toBe(false);
  });

  it("through the real WhoopClient: the schedule PUT that 500s after saving goes out exactly once", async () => {
    const rows = fx("alarm_schedule_rows.json") as Array<Record<string, unknown>>;
    let saved = false;
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      requests.push(`${method} ${url.pathname}`);
      if (method === "PUT") {
        saved = true; // WHOOP stores the rows, then fails rewriting the broken preferences.
        return new Response("<html><title>Error 500 Internal Server Error</title></html>", { status: 500 });
      }
      if (url.pathname === ROWS) {
        return Response.json(saved ? rows.map((r) => (r.schedule_id === A ? { ...r, upper_time_bound: "07:40:00" } : r)) : rows);
      }
      return new Response("<html><title>Error 500 Internal Server Error</title></html>", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const whoop = new WhoopClient({ getToken: async () => "t", sleep: async () => {} });
    const client = await connect((s) => registerSmartAlarmSet(s, whoop));
    const { out, isError } = await call(client, "whoop_smart_alarm_set", { action: "edit", schedule_id: A, wake_time: "07:40", confirm: true });
    expect(isError).toBe(false);
    expect(requests.filter((r) => r.startsWith("PUT"))).toEqual([`PUT ${BFF}/schedule/${A}`]);
    expect(out).toMatchObject({ verified: true, master_switch: "unavailable", next_alarm: "unavailable" });
    expect(out.schedules[0]).toMatchObject({ id: A, wake: "07:40" });
    expect(out.warnings.join(" ")).toMatch(/never retries/);
  });
});

describe("whoop_smart_alarm_set: turning the next alarm off uses the verified switch, not an unverified preferences body", () => {
  it("single_alarm with enabled:false is refused (no healthy account ever accepted that body)", async () => {
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: fx("alarm_schedule_all.json"), [PREFS]: fx("alarm_preferences.json") });
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const { isError, out } = await call(client, "whoop_smart_alarm_set", { action: "single_alarm", wake_time: "07:00", enabled: false, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/action:disable/);
    expect(rec.writes).toEqual([]);
  });

  it("disable still sends when the master switch is already off but a single alarm is on", async () => {
    const single = { ...(fx("alarm_preferences.json") as object), schedule_enabled: false, enabled: true };
    const off = { ...single, enabled: false };
    const allOff = { ...(fx("alarm_schedule_all.json") as object), schedule_enabled: false };
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: allOff, [PREFS]: seq(single, off) }, () => undefined);
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "disable", confirm: true });
    expect(rec.writes).toEqual([{ method: "PUT", path: `${ROWS}/disable`, body: undefined }]);
    expect(out).toMatchObject({ verified: true, no_change: false, master_switch: false, next_alarm: { enabled: false } });
  });

  it("disable is a no-op only when both the master switch and the next alarm are off", async () => {
    const off = { ...(fx("alarm_preferences.json") as object), schedule_enabled: false, enabled: false };
    const allOff = { ...(fx("alarm_schedule_all.json") as object), schedule_enabled: false };
    const rec = recorder({ [ROWS]: fx("alarm_schedule_rows.json"), [ALL]: allOff, [PREFS]: off });
    const client = await connect((s) => registerSmartAlarmSet(s, rec.client));
    const { out } = await call(client, "whoop_smart_alarm_set", { action: "disable", confirm: true });
    expect(rec.writes).toEqual([]);
    expect(out).toMatchObject({ verified: true, no_change: true });
  });
});

afterEach(() => { vi.unstubAllGlobals(); });
