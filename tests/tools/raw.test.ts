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
    // The one write entry point: POST answers 201 with a body, PUT and DELETE 204 with none.
    write: vi.fn(async (method: string) => (method === "POST" ? { status: 201, body: { created: true } } : { status: 204, body: undefined })),
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
    expect(whoop.write).not.toHaveBeenCalled();
  });
  it("previews a write until confirm is true, then sends it", async () => {
    const { whoop, call } = await setup();
    const preview = await call({ path: "/followers-service/v1/following/1", method: "POST", body: { source: "x" }, allow_write: true });
    expect(JSON.parse(preview.text).preview).toBe(true);
    expect(whoop.write).not.toHaveBeenCalled();
    const sent = await call({ path: "/followers-service/v1/following/1", method: "POST", body: { source: "x" }, allow_write: true, confirm: true });
    expect(sent.isError).toBe(false);
    expect(whoop.write).toHaveBeenCalledWith("POST", "/followers-service/v1/following/1", { source: "x" }, {});
    // The status shown is the one WHOOP answered with, not an assumed 200.
    expect(JSON.parse(sent.text)).toMatchObject({ status: 201, response: { created: true } });
    const deleted = await call({ path: "/ai-conversation-service/v1/conversation/abc", method: "DELETE", allow_write: true, confirm: true });
    expect(JSON.parse(deleted.text)).toMatchObject({ method: "DELETE", status: 204 });
    // PATCH (activity merge, Smart Alarm timezone) goes through the same gate.
    const patched = await call({ path: "/core-details-bff/v1/activities/merge", method: "PATCH", body: ["a", "b"], query: { startTime: "s", endTime: "e" }, allow_write: true, confirm: true });
    expect(whoop.write).toHaveBeenLastCalledWith("PATCH", "/core-details-bff/v1/activities/merge", ["a", "b"], { startTime: "s", endTime: "e" });
    expect(JSON.parse(patched.text)).toMatchObject({ method: "PATCH", status: 204 });
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
    expect(whoop.write).not.toHaveBeenCalled();
  });
  it("refuses a denylisted write spelled so the literal path dodges the denylist", async () => {
    // Each of these is sent by `new URL()` (or routed by WHOOP) as a denylisted
    // endpoint, while the string itself matched none of the denylist patterns.
    const { whoop, call } = await setup();
    for (const path of [
      "/x/../auth-service/v3/whoop",                              // dot segment → /auth-service/v3/whoop
      "/x/%2e%2e/auth-service/v3/whoop",                          // encoded dot segment
      "/./membership-service/v1/membership-management/cancel",
      "/users-service/v1/users?",                                 // account deletion: `$` no longer matched
      "/users-service/v1/users#",
      "/users-service/v1/users/.",
      "/users-service/v1/users;x=1",                              // servlet path parameter
      "//users-service/v1/users",
      "/users-service/v1/users/p%61ssword",                       // percent-encoded keyword
      "/users-service/v1/users/pass\tword",                       // the URL parser drops tabs and newlines
      "/auth-\nservice/v3/whoop",
      "/\\auth-service/v3/whoop",
      "/AUTH-SERVICE/v3/whoop",
    ]) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const out = await call({ path, method, body: {}, allow_write: true, confirm: true });
        expect(out.isError, `${method} ${JSON.stringify(path)}`).toBe(true);
      }
    }
    expect(whoop.write).not.toHaveBeenCalled();
  });
  it("still sends an allowed write whose path carries a query string", async () => {
    const { whoop, call } = await setup();
    const out = await call({ path: "/followers-service/v1/following/1?source=x", method: "POST", body: {}, allow_write: true, confirm: true });
    expect(out.isError).toBe(false);
    expect(whoop.write).toHaveBeenCalledWith("POST", "/followers-service/v1/following/1?source=x", {}, {});
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
