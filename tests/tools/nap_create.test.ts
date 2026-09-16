import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerNapCreate } from "../../src/tools/v2/nap_create.js";
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

function napReceipt(id = "nap-1") {
  return { activity: { id, cycle_id: 42, type: "nap", score_state: "pending" }, strength_trainer_linkable: false };
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

describe("whoop_nap_create through MCP", () => {
  it("rejects a sub-minute window before preview or mutation", async () => {
    const post = vi.fn();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerNapCreate(server, whoop));
    const result = await client.callTool({
      name: "whoop_nap_create",
      arguments: { start: "2026-09-07T12:00:00-04:00", end: "2026-09-07T12:00:30-04:00", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("previews without mutating, then sends the app's v2 nap body as canonical UTC", async () => {
    const post = vi.fn().mockResolvedValue(napReceipt());
    const get = vi.fn().mockResolvedValue({ title_bar: { title_display: "NAP" } });
    const whoop = { post, get } as unknown as WhoopClient;
    const client = await connect((server) => registerNapCreate(server, whoop));
    const args = { start: "2026-09-07T12:00:00-04:00", end: "2026-09-07T12:20:00-04:00" };

    const preview = await client.callTool({ name: "whoop_nap_create", arguments: args });
    expect(preview.isError).not.toBe(true);
    expect(post).not.toHaveBeenCalled();

    const result = await client.callTool({ name: "whoop_nap_create", arguments: { ...args, confirm: true } });
    expect(result.isError).not.toBe(true);
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toBe("/core-details-bff/v2/create-activity");
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      activity_internal_name: "nap",
      start_time: "2026-09-07T16:00:00.000Z",
      end_time: "2026-09-07T16:20:00.000Z",
      gps_enabled: false,
    });
    expect(textOf(result)).toMatchObject({ created: true, activity_id: "nap-1", type: "nap", verified: true });
  });

  it("logs a main sleep when nap:false", async () => {
    const post = vi.fn().mockResolvedValue({ activity: { id: "sleep-1", cycle_id: 7, type: "sleep", score_state: "pending" } });
    const get = vi.fn().mockResolvedValue({ title_bar: { title_display: "SLEEP" } });
    const whoop = { post, get } as unknown as WhoopClient;
    const client = await connect((server) => registerNapCreate(server, whoop));
    const result = await client.callTool({
      name: "whoop_nap_create",
      arguments: { start: "2026-09-07T02:00:00Z", end: "2026-09-07T03:00:00Z", nap: false, confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ activity_internal_name: "sleep" });
    expect(textOf(result)).toMatchObject({ verified: true, type: "sleep" });
  });

  it("reports verified:false when the read-back does not confirm the activity", async () => {
    const post = vi.fn().mockResolvedValue(napReceipt("nap-2"));
    const get = vi.fn().mockRejectedValue(new WhoopApiError(404, "/core-details-bff/v1/cardio-details", "not found"));
    const whoop = { post, get } as unknown as WhoopClient;
    const client = await connect((server) => registerNapCreate(server, whoop));
    const result = await client.callTool({
      name: "whoop_nap_create",
      arguments: { start: "2026-09-07T12:00:00Z", end: "2026-09-07T12:20:00Z", confirm: true },
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toMatchObject({ created: true, activity_id: "nap-2", verified: false });
  });

  it("surfaces a structured WHOOP rejection", async () => {
    const post = vi.fn().mockRejectedValue(new WhoopApiError(422, "/core-details-bff/v2/create-activity", JSON.stringify({ message: "overlap" }), "overlap"));
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerNapCreate(server, whoop));
    const result = await client.callTool({
      name: "whoop_nap_create",
      arguments: { start: "2026-09-07T12:00:00Z", end: "2026-09-07T12:20:00Z", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("overlap");
  });
});
