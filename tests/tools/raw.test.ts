// whoop_raw (D14): GET by default; writes need allow_write + confirm and pass a denylist.
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRaw, rawWriteRefusal, SAFE_ALARM_GOALS } from "../../src/tools/v2/raw.js";
import type { WhoopClient } from "../../src/whoop/client.js";

async function setup() {
  const whoop = {
    get: vi.fn().mockResolvedValue({ ok: true }),
    post: vi.fn().mockResolvedValue({ created: true }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerRaw(server, whoop as unknown as WhoopClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "whoop_raw", arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    return { isError: Boolean(res.isError), text };
  };
  return { whoop, client, call };
}

describe("whoop_raw", () => {
  it("is annotated destructive + open-world", async () => {
    const { client } = await setup();
    const tool = (await client.listTools()).tools.find((t) => t.name === "whoop_raw")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });
  it("GETs without any flags", async () => {
    const { whoop, call } = await setup();
    const out = await call({ path: "home-service/v1/home", query: { date: "2026-11-21" } });
    expect(out.isError).toBe(false);
    expect(whoop.get).toHaveBeenCalledWith("/home-service/v1/home", { date: "2026-11-21" });
  });
  it("refuses a write without allow_write", async () => {
    const { whoop, call } = await setup();
    const out = await call({ path: "/x", method: "POST", body: {}, confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/allow_write/);
    expect(whoop.post).not.toHaveBeenCalled();
  });
  it("previews a write until confirm is true, then sends it", async () => {
    const { whoop, call } = await setup();
    const preview = await call({ path: "/followers-service/v1/following/1", method: "POST", body: { source: "x" }, allow_write: true });
    expect(JSON.parse(preview.text).preview).toBe(true);
    expect(whoop.post).not.toHaveBeenCalled();
    const sent = await call({ path: "/followers-service/v1/following/1", method: "POST", body: { source: "x" }, allow_write: true, confirm: true });
    expect(sent.isError).toBe(false);
    expect(whoop.post).toHaveBeenCalledWith("/followers-service/v1/following/1", { source: "x" }, {});
  });
  it("refuses denylisted writes even with allow_write + confirm", async () => {
    const { whoop, call } = await setup();
    for (const path of [
      "/auth-service/v3/whoop",
      "/membership-service/v1/membership-management/cancel",
      "/users-service/v1/users/password",
      "/privacy-service/v1/community/privacy/settings/access_clinical_study",
      "/smart-alarm-service/v1/strap-status",
      "/integrations-bff/v1/integrations/strava/connect",
    ]) {
      const out = await call({ path, method: "PUT", body: {}, allow_write: true, confirm: true });
      expect(out.isError, path).toBe(true);
    }
    expect(whoop.put).not.toHaveBeenCalled();
  });
});

describe("rawWriteRefusal", () => {
  it("only lets the 7 safe Smart Alarm goals through", () => {
    const path = "/smart-alarm-service/v1/smartalarm/preferences";
    for (const goal of SAFE_ALARM_GOALS) expect(rawWriteRefusal(path, { goal })).toBeNull();
    expect(rawWriteRefusal(path, { goal: "EXACT_TIME_WEEKLY_PLAN" })).toMatch(/permanently/);
    expect(rawWriteRefusal(path, { enabled: false })).toBeNull();
  });
  it("allows ordinary own-data writes", () => {
    expect(rawWriteRefusal("/privacy-service/v1/community/privacy/settings/sleep", { value: "friends" })).toBeNull();
    expect(rawWriteRefusal("/progression-service/v3/trends/WEIGHT/readings", {})).toBeNull();
  });
});
