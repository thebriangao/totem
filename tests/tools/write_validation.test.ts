import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerSportsCatalog } from "../../src/tools/v2/sports_catalog.js";
import { registerActivityCreate } from "../../src/tools/v2/activity_create.js";
import { registerHrZonesSet } from "../../src/tools/v2/hr_zones_set.js";
import { registerLiftCatalog } from "../../src/tools/v2/lift_catalog.js";
import { registerLiftLog } from "../../src/tools/v2/lift_log.js";
import { registerSmartAlarmSet } from "../../src/tools/v2/smart_alarm_set.js";
import { registerProfileUpdate } from "../../src/tools/v2/profile_update.js";
import { registerHiddenMetric } from "../../src/tools/v2/hidden_metric.js";
import { registerJournalLog } from "../../src/tools/v2/journal_log.js";
import { EXERCISES } from "../../src/data/exercises.js";
import { WhoopApiError } from "../../src/whoop/errors.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  register(server);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("write-tool validation through MCP", () => {
  it("rejects short activity windows before preview or mutation", async () => {
    const post = vi.fn();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => {
      registerSportsCatalog(server, whoop);
      registerActivityCreate(server, whoop);
    });
    await client.callTool({ name: "whoop_sports_catalog", arguments: { search: "running" } });
    const result = await client.callTool({
      name: "whoop_activity_create",
      arguments: {
        sport_id: 0,
        start: "2026-08-24T12:00:00-04:00",
        end: "2026-08-24T12:00:30-04:00",
        confirm: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("returns a valid preview without mutating, then sends a confirmed activity", async () => {
    const post = vi.fn().mockResolvedValue({ id: "activity-1", cycle_id: 42 });
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => {
      registerSportsCatalog(server, whoop);
      registerActivityCreate(server, whoop);
    });
    await client.callTool({ name: "whoop_sports_catalog", arguments: {} });
    const args = {
      sport_id: 0,
      start: "2026-08-24T12:00:00-04:00",
      end: "2026-08-24T12:30:00-04:00",
    };
    const preview = await client.callTool({ name: "whoop_activity_create", arguments: args });
    expect(preview.isError).not.toBe(true);
    expect(post).not.toHaveBeenCalled();
    await client.callTool({ name: "whoop_activity_create", arguments: { ...args, confirm: true } });
    expect(post).toHaveBeenCalledOnce();
  });

  it("resolves an exact sport name without a catalog round trip", async () => {
    const post = vi.fn().mockResolvedValue({ id: "activity-1", cycle_id: 42 });
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerActivityCreate(server, whoop));
    const result = await client.callTool({
      name: "whoop_activity_create",
      arguments: { sport: "running", start: "2026-08-24T12:00:00-04:00", end: "2026-08-24T12:02:00-04:00", confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      start_time: "2026-08-24T16:00:00.000Z",
      end_time: "2026-08-24T16:02:00.000Z",
    });
  });

  it("returns a structured, actionable WHOOP write rejection", async () => {
    const post = vi.fn().mockRejectedValue(new WhoopApiError(400, "/core-details-bff/v0/create-activity", JSON.stringify({ message: "Window unavailable" }), "Window unavailable"));
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerActivityCreate(server, whoop));
    const result = await client.callTool({
      name: "whoop_activity_create",
      arguments: { sport: "Running", start: "2026-08-24T12:00:00-04:00", end: "2026-08-24T12:02:00-04:00", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Window unavailable");
    expect(JSON.stringify(result.content)).toContain("canonical UTC");
  });

  it("rejects duplicate or overlapping custom HR zones without mutation", async () => {
    const post = vi.fn();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerHrZonesSet(server, whoop));
    const result = await client.callTool({
      name: "whoop_hr_zones_set",
      arguments: {
        mode: "custom",
        zones: [
          { id: "ZONE_1", min: 50, max: 100 },
          { id: "ZONE_2", min: 90, max: 120 },
          { id: "ZONE_3", min: 120, max: 140 },
          { id: "ZONE_4", min: 140, max: 160 },
          { id: "ZONE_5", min: 160, max: 190 },
        ],
        confirm: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects reversed strength-workout windows before mutation", async () => {
    const post = vi.fn();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => {
      registerLiftCatalog(server, whoop);
      registerLiftLog(server, whoop);
    });
    await client.callTool({ name: "whoop_lift_catalog", arguments: { limit: 1 } });
    const result = await client.callTool({
      name: "whoop_lift_log",
      arguments: {
        start: "2026-08-24T13:00:00-04:00",
        end: "2026-08-24T12:00:00-04:00",
        exercises: [{ exercise_id: EXERCISES[0]!.exercise_id, sets: [{ reps: 5 }] }],
        confirm: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects impossible Smart Alarm clock values before mutation", async () => {
    const put = vi.fn();
    const whoop = { put } as unknown as WhoopClient;
    const client = await connect((server) => registerSmartAlarmSet(server, whoop));
    const result = await client.callTool({
      name: "whoop_smart_alarm_set",
      arguments: {
        mode: "schedule",
        schedule_id: "schedule-1",
        schedule: {
          enabled: true,
          days_of_week: ["MONDAY"],
          latest_wake_time: "29:99:00",
          alarm_mode: "EXACT_TIME_PEAK",
          timezone_offset: "-0400",
        },
        confirm: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("normalizes a human-friendly Smart Alarm time before writing", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({ alarm_schedule_list: [] });
    const whoop = { get, put } as unknown as WhoopClient;
    const client = await connect((server) => registerSmartAlarmSet(server, whoop));
    const result = await client.callTool({
      name: "whoop_smart_alarm_set",
      arguments: {
        mode: "schedule", schedule_id: "schedule-1",
        schedule: { enabled: true, days_of_week: ["MONDAY"], latest_wake_time: "7:05 AM", alarm_mode: "EXACT_TIME_PEAK", timezone_offset: "-0400" },
        confirm: true,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(put.mock.calls[0]?.[1]).toMatchObject({ latest_wake_time: "07:05:00" });
  });

  it("recognizes unchanged Smart Alarm preferences without a PUT", async () => {
    const get = vi.fn().mockResolvedValue({
      lower_time_bound: "05:25:00", upper_time_bound: "06:25:00",
      goal: "IN_THE_GREEN", enabled: true, schedule_enabled: true,
      time_zone_offset: "-0400", weekly_plan_goal: 0,
    });
    const put = vi.fn();
    const whoop = { get, put } as unknown as WhoopClient;
    const client = await connect((server) => registerSmartAlarmSet(server, whoop));
    const result = await client.callTool({
      name: "whoop_smart_alarm_set",
      arguments: { mode: "preferences", preferences: {
        lower_time_bound: "05:25", upper_time_bound: "06:25", goal: "IN_THE_GREEN",
        enabled: true, schedule_enabled: true, timezone_offset: "-0400", weekly_plan_goal: 0,
      }, confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(put).not.toHaveBeenCalled();
    const output = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(output).toMatchObject({ updated: false, no_change: true, mode: "preferences" });
  });

  it("rejects an empty profile update without even fetching the profile", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const whoop = { get, put } as unknown as WhoopClient;
    const client = await connect((server) => registerProfileUpdate(server, whoop));
    const result = await client.callTool({
      name: "whoop_profile_update",
      arguments: { confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("recognizes an already-visible metric without issuing a DELETE", async () => {
    const get = vi.fn().mockResolvedValue({ is_hidden: false });
    const del = vi.fn();
    const whoop = { get, delete: del } as unknown as WhoopClient;
    const client = await connect((server) => registerHiddenMetric(server, whoop));
    const result = await client.callTool({
      name: "whoop_hidden_metric",
      arguments: { metric: "BODY_COMP", action: "show", confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(del).not.toHaveBeenCalled();
    const output = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(output).toMatchObject({ updated: false, no_change: true, is_hidden: false });
  });

  it("blocks an empty journal replacement unless explicitly allowed", async () => {
    const put = vi.fn();
    const whoop = { put } as unknown as WhoopClient;
    const client = await connect((server) => registerJournalLog(server, whoop));
    const result = await client.callTool({ name: "whoop_journal_log", arguments: { behaviors: [], confirm: true } });
    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a journal behavior nobody can resolve", async () => {
    const put = vi.fn();
    const get = vi.fn().mockResolvedValue({});
    const whoop = { put, get } as unknown as WhoopClient;
    const client = await connect((server) => registerJournalLog(server, whoop));
    const result = await client.callTool({
      name: "whoop_journal_log",
      arguments: { behaviors: [{ behavior: "definitely not a behavior" }], confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });
});
