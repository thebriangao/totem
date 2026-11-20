// Session lifecycle on /mcp: only an initialize request may create a session.
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { WhoopClient } from "../../src/whoop/client.js";

const registerCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/tools/register.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/register.js")>();
  return {
    ...actual,
    registerTools: (...args: Parameters<typeof actual.registerTools>) => {
      registerCalls.count++;
      return actual.registerTools(...args);
    },
  };
});

const { startHttpServer } = await import("../../src/server-http.js");

const PORT = 39822;
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const stubClient = {
  get: async () => ({}),
  post: async () => ({}),
  put: async () => ({}),
  delete: async () => ({}),
} as unknown as WhoopClient;

describe("HTTP transport: session creation", () => {
  beforeAll(async () => {
    await startHttpServer(stubClient, { authToken: TOKEN, port: PORT, host: "127.0.0.1" });
    await new Promise((r) => setTimeout(r, 50));
  });

  it("a non-initialize POST with no mcp-session-id gets 400 and builds no session", async () => {
    const before = registerCalls.count;
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(registerCalls.count).toBe(before);
  });

  it("a GET with no mcp-session-id gets 400 and builds no session", async () => {
    const before = registerCalls.count;
    const r = await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" } });
    expect(r.status).toBe(400);
    expect(registerCalls.count).toBe(before);
  });

  it("initialize still gets 200 + mcp-session-id, and the session is reusable", async () => {
    const before = registerCalls.count;
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    });
    expect(r.status).toBe(200);
    const sid = r.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    expect(registerCalls.count).toBe(before + 1);

    const list = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { ...HEADERS, "mcp-session-id": sid!, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(list.status).toBe(200);
    expect(registerCalls.count).toBe(before + 1);
  });
});
