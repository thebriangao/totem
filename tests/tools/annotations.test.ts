import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerTools } from "../../src/tools/register.js";

// Every write is listed here on purpose: a new tool that mutates Whoop must be
// classified when it's added, or this test fails.
const ADDITIVE_WRITES = [
  "whoop_activity_create",
  "whoop_coach_ask",
  "whoop_lift_custom_exercise",
  "whoop_lift_log",
  "whoop_lift_template_save",
];
const DESTRUCTIVE_WRITES = [
  "whoop_activity_delete",
  "whoop_cycle_log",
  "whoop_hidden_metric",
  "whoop_hr_zones_set",
  "whoop_journal_autopop",
  "whoop_journal_log",
  "whoop_profile_update",
  "whoop_raw",
  "whoop_sleep_edit",
  "whoop_smart_alarm_set",
  "whoop_symptom_log",
];

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

// List tools over MCP, i.e. exactly what a client like claude.ai receives.
async function listTools(): Promise<Tool[]> {
  const server = new McpServer({ name: "test-server", version: "1" });
  registerTools(server, {} as WhoopClient);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return (await client.listTools()).tools;
}

describe("tool annotations", () => {
  it("gives every tool an explicit readOnlyHint", async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(55);
    const missing = tools.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean").map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("marks exactly the write tools as not read-only, split by destructiveness", async () => {
    const tools = await listTools();
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false);
    const additive = writes.filter((t) => t.annotations?.destructiveHint === false).map((t) => t.name).sort();
    const destructive = writes.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name).sort();
    expect(additive).toEqual(ADDITIVE_WRITES);
    expect(destructive).toEqual(DESTRUCTIVE_WRITES);
    expect(writes).toHaveLength(ADDITIVE_WRITES.length + DESTRUCTIVE_WRITES.length);
  });

  it("labels every tool whose description says WRITE as a write", async () => {
    const tools = await listTools();
    const mislabeled = tools
      .filter((t) => /^WRITE\b/.test(t.description ?? "") && t.annotations?.readOnlyHint !== false)
      .map((t) => t.name);
    expect(mislabeled).toEqual([]);
  });
});
