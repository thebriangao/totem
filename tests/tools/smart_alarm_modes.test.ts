// Failure cases, written before the fix: current modes are rejected on input,
// valid schedules are reported as IN_THE_GREEN, preferences goals become null,
// preview mutates state, or invalid Sleep Goal values reach the upstream API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SmartAlarmOut } from "../../src/schemas/smart_alarm.js";

// Exercise the source handlers in a separate, real stdio MCP server. No credentials,
// network requests or account mutations: only the Whoop client is replaced.
const serverSource = `
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSmartAlarm } from "./src/tools/v2/smart_alarm.ts";
import { registerSmartAlarmSet } from "./src/tools/v2/smart_alarm_set.ts";
import { registerRaw } from "./src/tools/v2/raw.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/smart_alarm_current.json", "utf8"));
const entry = fixture.schedules.alarm_schedule_list[0];
const requests = [];
const client = {
  async get(path) {
    if (path === "/test-requests") return requests;
    if (path.endsWith("/schedule/all")) return fixture.schedules;
    if (path.endsWith("/preferences")) return fixture.preferences;
    throw new Error("Unexpected GET " + path);
  },
  async put(path, body) {
    requests.push(body);
    if (path !== "/smart-alarm-bff/v1/schedule/" + entry.schedule_id) throw new Error("Unexpected PUT");
    if (!["EXACT_TIME", "SLEEP_GOAL", "IN_THE_GREEN", "NO_ALARM"].includes(body.alarm_mode)) throw new Error("API 422: invalid mode");
    if (body.latest_wake_time === "00:01:00") throw new Error("API 422: fixture rejection");
    Object.assign(entry, { alarm_mode: body.alarm_mode, latest_wake_time: body.latest_wake_time,
      sleep_goal: body.sleep_goal, alarm_on: body.enabled, scheduled_days: body.day_of_week_list });
  },
};
const server = new McpServer({ name: "smart-alarm-fixture", version: "1" });
registerSmartAlarm(server, client);
registerSmartAlarmSet(server, client);
registerRaw(server, client);
await server.connect(new StdioServerTransport());
`;

let client: Client;
const schedule = {
  enabled: true,
  days_of_week: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  latest_wake_time: "07:30:00",
  alarm_mode: "EXACT_TIME",
  sleep_goal: "",
  timezone_offset: "-0400",
};

function parse(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}
const set = (edits: Record<string, unknown> = {}, confirm = true) => client.callTool({
  name: "whoop_smart_alarm_set",
  arguments: { mode: "schedule", schedule_id: "00000000-0000-4000-8000-000000000001", schedule: { ...schedule, ...edits }, confirm },
});
const read = async () => SmartAlarmOut.parse(parse(await client.callTool({ name: "whoop_smart_alarm", arguments: {} })));
const requests = async () => parse(await client.callTool({ name: "whoop_raw", arguments: { path: "/test-requests" } }));

beforeEach(async () => {
  client = new Client({ name: "smart-alarm-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "--input-type=module", "-e", serverSource],
    stderr: "pipe",
  }));
});
afterEach(async () => { await client.close(); });

describe("Smart Alarm modes over stdio MCP", () => {
  it("preserves current schedule and preferences values from the API", async () => {
    const state = await read();
    expect(state.schedules[0]?.alarm_mode).toBe("EXACT_TIME");
    expect(state.preferences.goal).toBe("EXACT_TIME_PERFORM");
  });

  it("previews Exact Time without writing, then preserves time and days on write/read", async () => {
    expect(parse(await set({}, false))).toMatchObject({ preview: true });
    expect(await requests()).toMatchObject({ response: [] });
    expect(parse(await set())).toMatchObject({ updated: true });
    expect((await read()).schedules[0]).toMatchObject(schedule);
    expect(parse(await set())).toMatchObject({ updated: false, no_change: true });
    expect(await requests()).toMatchObject({ response: [expect.objectContaining({ alarm_mode: "EXACT_TIME" })] });
  });

  it.each(["PEAK", "PERFORM", "GET_BY"])("round trips Sleep Goal %s", async (sleep_goal) => {
    expect(parse(await set({ alarm_mode: "SLEEP_GOAL", sleep_goal }))).toMatchObject({ updated: true });
    expect((await read()).schedules[0]).toMatchObject({ ...schedule, alarm_mode: "SLEEP_GOAL", sleep_goal });
  });

  it.each(["EXACT_TIME_PEAK", "EXACT_TIME_OPTIMIZE_SLEEP"])("rejects legacy preferences goal %s as a schedule mode", async (alarm_mode) => {
    expect((await set({ alarm_mode })).isError).toBe(true);
    expect(await requests()).toMatchObject({ response: [] });
  });

  it.each(["", "INVALID"])("rejects missing or invalid Sleep Goal (%s) without writing", async (sleep_goal) => {
    expect((await set({ alarm_mode: "SLEEP_GOAL", sleep_goal })).isError).toBe(true);
    expect(await requests()).toMatchObject({ response: [] });
  });

  it("reports upstream rejection as an error", async () => {
    expect((await set({ latest_wake_time: "00:01:00" })).isError).toBe(true);
    expect(await requests()).toMatchObject({ response: [expect.objectContaining({ latest_wake_time: "00:01:00" })] });
  });
});
