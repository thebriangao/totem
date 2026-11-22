import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerWorkouts } from "../../src/tools/v2/workouts.js";
import { registerDailyBrief } from "../../src/tools/v2/daily_brief.js";
import { registerCompare } from "../../src/tools/v2/compare.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

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

function paramsFor(get: ReturnType<typeof vi.fn>, path: string): Record<string, unknown> {
  const call = get.mock.calls.find((c) => c[0] === path);
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

describe("read tool date windows", () => {
  it("workouts anchors the default 30-day window on `end` when only end is given", async () => {
    const get = vi.fn().mockResolvedValue({});
    const client = await connect((server) => registerWorkouts(server, { get } as unknown as WhoopClient));
    await client.callTool({ name: "whoop_workouts", arguments: { end: "2026-01-31T00:00:00.000Z" } });
    const p = paramsFor(get, "/developer/v2/activity/workout");
    expect(p.end).toBe("2026-01-31T00:00:00.000Z");
    expect(p.start).toBe("2026-01-01T00:00:00.000Z");
  });

  it("workouts with only `start` keeps start and ends now", async () => {
    const get = vi.fn().mockResolvedValue({});
    const client = await connect((server) => registerWorkouts(server, { get } as unknown as WhoopClient));
    await client.callTool({ name: "whoop_workouts", arguments: { start: "2026-01-01T00:00:00.000Z" } });
    const p = paramsFor(get, "/developer/v2/activity/workout");
    expect(p.start).toBe("2026-01-01T00:00:00.000Z");
    expect(Date.parse(p.end as string)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("daily_brief windows the activity-sleep request around a past date", async () => {
    const get = vi.fn().mockResolvedValue({});
    const client = await connect((server) => registerDailyBrief(server, { get } as unknown as WhoopClient));
    const result = await client.callTool({ name: "whoop_daily_brief", arguments: { date: "2026-05-22", sections: ["sleep"] } });
    expect(result.isError).not.toBe(true);
    const p = paramsFor(get, "/developer/v2/activity/sleep");
    expect(p.start).toBe("2026-05-21T00:00:00.000Z");
    expect(p.end).toBe("2026-05-24T00:00:00.000Z");
  });

  it("compare reports inclusive 7-day windows that don't overlap", async () => {
    const get = vi.fn().mockResolvedValue({});
    const client = await connect((server) => registerCompare(server, { get } as unknown as WhoopClient));
    const result = await client.callTool({ name: "whoop_compare", arguments: { window: "week", end_a: "2026-05-23", metrics: ["HRV"] } });
    expect(result.isError).not.toBe(true);
    const out = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(out.a).toEqual({ start_date: "2026-05-17", end_date: "2026-05-23" });
    expect(out.b).toEqual({ start_date: "2026-05-10", end_date: "2026-05-16" });
  });
});
