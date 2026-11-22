import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerWeeklyPlan } from "../../src/tools/v2/weekly_plan.js";
import { registerPreferences } from "../../src/tools/v2/preferences.js";

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

describe("compact helper tools", () => {
  it("projects weekly-plan goals without exposing the raw tile", async () => {
    const get = vi.fn().mockResolvedValue({ tile: { type: "WEEKLY_PLAN_HOME_TILE", content: {
      title: "CUSTOM PLAN", days_left_display: "7 days left", progress_bar: { percent_value: 5 },
      items: [{ id: "STEPS", title: "1,600+ Steps", circular_progress_indicator: { current_progress_steps: { text_display: "1/7", current_step: 1, total_steps: 7 } } }],
    } } });
    const client = await connect((server) => registerWeeklyPlan(server, { get } as unknown as WhoopClient));
    const result = await client.callTool({ name: "whoop_weekly_plan", arguments: { date: "2026-08-24" } });
    const output = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(result.isError).not.toBe(true);
    // v2 shape (whoop_weekly_plan): parsed target and days met, no display strings.
    expect(output).toMatchObject({ has_plan: true, plan: "CUSTOM PLAN", pct: 5, days_left: 7 });
    expect(output.goals).toEqual([expect.objectContaining({ type: "STEPS", target: 1600, days_met: [1, 7] })]);
    expect(get).toHaveBeenCalledWith("/progression-service/v2/weekly-plan/home-tile/2026-08-24", {}, { fresh: false });
  });

  it("preferences fetches only the explicitly selected preference category", async () => {
    const get = vi.fn().mockResolvedValue({ journal_enabled: true });
    const client = await connect((server) => registerPreferences(server, { get } as unknown as WhoopClient));
    const result = await client.callTool({ name: "whoop_preferences", arguments: { include: ["journal"] } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("journal_enabled");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/journal-service/v1/journals/preferences");
  });
});
