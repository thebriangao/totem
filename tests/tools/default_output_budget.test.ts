// Default outputs are paid for on every call, so each read tool's answer to a
// call with only its required arguments has a budget: about 1.5 KB against
// populated fixtures. Heavy parts belong behind include[]. To print the table:
//   TOTEM_PRINT_SIZES=1 npx vitest run tests/tools/default_output_budget.test.ts --silent=false
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { READ_TOOLS } from "../../src/tools/register.js";
import { pinToday, unpinToday } from "./reads_core_harness.js";

const BUDGET = 1500;
/**
 * Lists whose size is rows × row length, measured on deliberately heavy fixtures.
 * Both go out as columnar rows; what is left is ids and timestamps a caller needs.
 *  - whoop_workouts: 16 activities in one day at ~113 characters each (11 rows fit the budget).
 *  - whoop_lift_sessions: three sessions of 8 exercises, ~690 characters a session (two fit).
 */
const OVER_BUDGET: Record<string, number> = { whoop_workouts: 2000, whoop_lift_sessions: 2200 };
const fx =(name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));
const core = (name: string): unknown => fx(`v2-core/${name}.json`);

const TODAY = "2026-11-21";
const WH = "/womens-health-service/v1";
const SA = "/smart-alarm-service/v1";
const LIFT = "5364dc07-c229-481f-b92f-0d7ee402fbbf";

/** Three scored lifts on three days: the home fixture's lift with a different id per day. */
const liftHome = (date: string): unknown =>
  [TODAY, "2026-11-20", "2026-11-19"].includes(date)
    ? JSON.parse(JSON.stringify(fx("home.json")).replaceAll(LIFT, `${LIFT.slice(0, -2)}${date.slice(-2)}`))
    : {};

type Route = unknown | ((query: Record<string, unknown>, path: string) => unknown);

/** Exact paths first, then `prefix*` routes. Unrouted GETs throw. */
function routed(table: Record<string, Route>): WhoopClient {
  const get = vi.fn(async (path: string, query: Record<string, unknown> = {}) => {
    const key = path in table ? path : Object.keys(table).find((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)));
    if (key === undefined) throw new Error(`unexpected GET ${path}`);
    const v = table[key];
    const out = typeof v === "function" ? (v as (q: Record<string, unknown>, p: string) => unknown)(query, path) : v;
    if (out instanceof Error) throw out;
    return structuredClone(out);
  });
  return { get } as unknown as WhoopClient;
}

const DAY = {
  "/home-service/v1/home": core("home_populated"),
  "/home-service/v1/deep-dive/recovery": core("recovery_dd_populated"),
  "/home-service/v1/deep-dive/strain": core("strain_dd_populated"),
  "/home-service/v1/deep-dive/sleep/last-night": core("lastnight_populated"),
  "/activities-service/v1/user-state": core("userstate"),
  "/coaching-service/v2/sleepneed": core("sleepneed"),
  "/coaching-service/v1/health/bff/monitor": core("monitor_populated"),
  "/sleep-service/v1/heart-rate/baseline": 56.6,
  "/core-details-bff/v2/sleep-details/*": core("sleep_details_complete"),
  "/health-service/v2/stress-bff/*": fx("stress_bff.json"),
  "/home-service/v1/widget/overview": core("widget"),
};

/** Per tool: the arguments a default call needs (required ones only) and its routes. */
const CASES: Record<string, { args?: Record<string, unknown>; routes: Record<string, Route> }> = {
  whoop_day: { routes: DAY },
  whoop_recovery: { routes: DAY },
  whoop_sleep: { routes: DAY },
  whoop_strain: { routes: DAY },
  whoop_stress: { routes: DAY },
  // With the latest heart rate, so the measured default is the full one.
  whoop_now: {
    routes: {
      ...DAY,
      "/users-service/v2/bootstrap": { user: { id: 10000001 } },
      "/metrics-service/v1/metrics/user/10000001": core("hr_60s"),
    },
  },
  whoop_trend: { args: { metrics: ["HRV"] }, routes: { "/progression-service/v3/trends/HRV": fx("trend_hrv.json") } },
  whoop_calendar: { routes: { "/home-service/v1/calendar/recovery": core("cal_recovery") } },
  whoop_workouts: {
    routes: {
      "/home-service/v1/calendar/overview": fx("activities/calendar_overview_2026-11.json"),
      "/home-service/v1/home": (q: Record<string, unknown>) => (q.date === TODAY ? fx("activities/home_2026-11-21.json") : {}),
    },
  },
  whoop_lift_sessions: {
    routes: {
      "/home-service/v1/calendar/overview": { days_of_month: [19, 20, 21].map((d) => ({ date_value_display: String(d), has_data: true })) },
      "/home-service/v1/home": (q: Record<string, unknown>) => liftHome(String(q.date)),
      "/core-details-bff/v1/cardio-details": fx("cardio_details.json"),
    },
  },
  whoop_lift_exercise: {
    routes: {
      "/weightlifting-service/v3/prs": (q: Record<string, unknown>) => fx(`strength_v2/prs_page${Number(q.offset ?? 0) / 10}.json`),
    },
  },
  whoop_lift_library: { routes: { "/weightlifting-service/v3/workout-library": fx("strength_v2/library.json") } },
  whoop_journal: { routes: { [`/journal-service/v3/journals/drafts/mobile/${TODAY}`]: fx("v2/journal_draft_2026-11-21.json") } },
  whoop_coach_history: { routes: { "/ai-conversation-bff/v1/conversations": fx("coach/conversations.json") } },
  whoop_memory: { routes: { "/context-hub-bff/v1/context-hub/items": fx("memory/items_goals.json") } },
  whoop_weight: { routes: { "/progression-service/v3/trends/WEIGHT/readings": fx("weight_readings.json") } },
  whoop_cycle: { routes: { [`${WH}/hormonal-insights/overview`]: fx("hi_overview_cycle_day.json") } },
  whoop_weekly_plan: {
    routes: {
      "/progression-service/v1/weekly-plan": fx("weekly_plan_v1_two_goals.json"),
      [`/progression-service/v2/weekly-plan/home-tile/${TODAY}`]: fx("weekly_plan_tile_two_goals.json"),
    },
  },
  whoop_milestones: {
    routes: {
      "/milestones-service/v1/bff/milestones/hub": fx("milestones_hub.json"),
      "/streaks-service/v1/bff/streaks/data-streak": fx("data_streak.json"),
    },
  },
  whoop_smart_alarm: {
    routes: {
      [`${SA}/alarm-schedule`]: fx("alarm_schedule_rows.json"),
      "/smart-alarm-bff/v1/schedule/all": fx("alarm_schedule_all.json"),
      [`${SA}/smartalarm/preferences`]: fx("alarm_preferences.json"),
    },
  },
  whoop_profile: {
    routes: {
      // Synthetic, shaped like the 2026-11 responses (as in profile.test.ts).
      "/users-service/v2/bootstrap": {
        account: { id: 9, username: "tester", email: "tester@example.com", user_id: 7 },
        user: { id: 7, first_name: "Test", last_name: "User", country: "US", city: "Springfield", admin_division: "IL" },
        profile: { height: 1.8, weight: 80.5, gender: "i prefer not to choose", unit_system: "metric", birthday: "1990-05-05T07:00:00.000Z", timezone_offset: "-0800", physiological_baseline: null, fitness_level: "recreational_enthusiast" },
        membership: { status: "active", in_effect: true },
        bio_data: { max_heart_rate: 185, min_heart_rate: 50, resting_heart_rate: 52 },
      },
      "/profile-service/v1/profile/bff/edit": {
        first_name: "Test", last_name: "User", email: "tester@example.com", city: "Springfield", country: "US", state: "IL",
        height: 1.8, weight: 80.5, birthday: "1990-05-05", unit_system: "metric", gender: "PREFER_NOT", physiological_baseline: "FEMALE",
        locked_fields: [], countries: [{ name: "Afghanistan", country_code: "AF" }],
      },
      "/users-service/v1/stealth-mode": true,
      "/users-service/v1/hidden-metrics/*": { is_hidden: false },
    },
  },
  whoop_preferences: {
    routes: {
      "/journal-service/v1/journals/preferences": fx("v2/journal_preferences.json"),
      "/notification-service/v1/notifications/user-settings/bff": fx("v2/notification_settings.json"),
      "/ai-conversation-service/v1/settings": fx("v2/ai_settings.json"),
      "/home-service/v2/home/dashboard/customize": fx("v2/dashboard_customize.json"),
      "/journal-service/v3/journals/behaviors": {
        grouped_toggles: [{ title: "NOT SELECTED", toggles: [{ id: "1", title: "Alcohol", internal_name: "alcohol", selected: true, custom: false }] }],
      },
    },
  },
  whoop_community: {
    routes: {
      "/users-service/v2/bootstrap": fx("bootstrap.json"),
      "/community-service/v1/communities/memberships": fx("community/memberships.json"),
    },
  },
};

async function defaultOutput(register: (server: McpServer, client: WhoopClient) => void): Promise<{ name: string; text: string }> {
  const server = new McpServer({ name: "t", version: "0" });
  // Each register function adds one tool; the client is swapped in once its name is known.
  let whoop: WhoopClient = {} as WhoopClient;
  register(server, new Proxy({} as WhoopClient, { get: (_t, prop) => (whoop as unknown as Record<string | symbol, unknown>)[prop] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  const name = (await client.listTools()).tools[0]!.name;
  const spec = CASES[name];
  if (!spec) throw new Error(`no default-output case for ${name}`);
  whoop = routed(spec.routes);
  const res = await client.callTool({ name, arguments: spec.args ?? {} });
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  await client.close();
  await server.close();
  if (res.isError) throw new Error(`${name}: ${text}`);
  return { name, text };
}

describe("default output budget", () => {
  const savedUserId = process.env.WHOOP_USER_ID;
  beforeAll(() => {
    pinToday();
    delete process.env.WHOOP_USER_ID;
  });
  afterAll(() => {
    unpinToday();
    if (savedUserId !== undefined) process.env.WHOOP_USER_ID = savedUserId;
  });
  afterEach(() => vi.clearAllMocks());

  it(`every read tool answers a default call in ≤ ${BUDGET} characters (two list tools excepted, on heavy fixtures)`, async () => {
    const sizes: Array<[string, number]> = [];
    for (const register of READ_TOOLS) {
      const { name, text } = await defaultOutput(register);
      sizes.push([name, text.length]);
    }
    if (process.env.TOTEM_PRINT_SIZES) console.log(sizes.map(([n, s]) => `${n.padEnd(22)} ${s}`).join("\n"));
    expect(sizes.map(([n]) => n).sort()).toEqual(Object.keys(CASES).sort());
    for (const [name, size] of sizes) expect(size, `${name} default output`).toBeLessThanOrEqual(OVER_BUDGET[name] ?? BUDGET);
  });
});
