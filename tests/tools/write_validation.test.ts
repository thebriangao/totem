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

  // v2 smart alarm (SPEC.md D11): the v1 schedule/preferences shapes were replaced; these keep
  // the original intents (bad clock rejected, human time normalized, no-op skipped).
  const alarmRows = [
    { schedule_id: "11111111-aaaa", day_of_week: "MONDAY", upper_time_bound: "07:05:00", goal: "EXACT_TIME_PERFORM", enabled: true, deleted: false },
  ];
  const alarmGet = () => vi.fn(async (path: string) => {
    if (path === "/smart-alarm-service/v1/alarm-schedule") return alarmRows;
    throw new WhoopApiError(500, path, "");
  });

  it("rejects impossible Smart Alarm clock values before mutation", async () => {
    const put = vi.fn();
    const whoop = { put, get: alarmGet() } as unknown as WhoopClient;
    const client = await connect((server) => registerSmartAlarmSet(server, whoop));
    const result = await client.callTool({
      name: "whoop_smart_alarm_set",
      arguments: { action: "edit", schedule_id: "11111111-aaaa", wake_time: "29:99:00", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("normalizes a human-friendly Smart Alarm time before writing", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const whoop = { get: alarmGet(), put } as unknown as WhoopClient;
    const client = await connect((server) => registerSmartAlarmSet(server, whoop));
    const result = await client.callTool({
      name: "whoop_smart_alarm_set",
      arguments: { action: "edit", schedule_id: "11111111-aaaa", wake_time: "7:35 AM", confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(put.mock.calls[0]?.[1]).toMatchObject({ latest_wake_time: "07:35:00" });
  });

  it("recognizes an unchanged Smart Alarm schedule without a PUT", async () => {
    const put = vi.fn();
    const whoop = { get: alarmGet(), put } as unknown as WhoopClient;
    const client = await connect((server) => registerSmartAlarmSet(server, whoop));
    const result = await client.callTool({
      name: "whoop_smart_alarm_set",
      arguments: { action: "edit", schedule_id: "11111111-aaaa", wake_time: "7:05 AM", days: ["MON"], mode: "EXACT_TIME", confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(put).not.toHaveBeenCalled();
    const output = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(output).toMatchObject({ no_change: true, verified: true, action: "edit" });
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

  it("still writes when the hidden-metric status can't be read", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    const del = vi.fn().mockResolvedValue(undefined);
    const whoop = { get, delete: del } as unknown as WhoopClient;
    const client = await connect((server) => registerHiddenMetric(server, whoop));
    const result = await client.callTool({
      name: "whoop_hidden_metric",
      arguments: { metric: "BODY_COMP", action: "show", confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(del).toHaveBeenCalledOnce();
  });

  it("drops the old state when the country changes, and reads the profile fresh", async () => {
    const get = vi.fn().mockResolvedValue({
      user: { first_name: "A", last_name: "B", city: "Austin", admin_division: "TX", country: "US" },
      profile: { gender: "MALE", weight: 80, height: 1.8, unit_system: "metric" },
      account: { email: "a@b.com" },
    });
    const put = vi.fn().mockResolvedValue({});
    const whoop = { get, put } as unknown as WhoopClient;
    const client = await connect((server) => registerProfileUpdate(server, whoop));
    const result = await client.callTool({
      name: "whoop_profile_update",
      arguments: { country: "ca", city: "Toronto", confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(get.mock.calls[0]![2]).toEqual({ fresh: true });
    expect(put.mock.calls[0]![1]).toMatchObject({ country: "CA", city: "Toronto" });
    expect(put.mock.calls[0]![1]).not.toHaveProperty("state");
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
