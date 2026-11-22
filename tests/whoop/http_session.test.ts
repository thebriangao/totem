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

// Port 0: the OS picks a free port (no collisions between parallel runs).
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let BASE = "";
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
    const server = await startHttpServer(stubClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    BASE = `http://127.0.0.1:${server.port}`;
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

  const INIT = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  const initialize = async (): Promise<string> => {
    const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: HEADERS, body: INIT });
    await r.text();
    return r.headers.get("mcp-session-id")!;
  };
  const toolsList = (sid: string) => fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });

  // The transport turns this initialize down (406), so the session id is never
  // handed out. The session built for it used to stay in memory until the
  // 30-minute idle sweep, one full McpServer per bad attempt.
  it("drops the session at once when the transport rejects the initialize", async () => {
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const closed = vi.spyOn(StreamableHTTPServerTransport.prototype, "close");
    try {
      const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...HEADERS, accept: "application/json" }, body: INIT });
      expect(r.status).toBe(406);
      expect(r.headers.get("mcp-session-id")).toBeNull();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
      // A good initialize is left alone.
      const sid = await initialize();
      expect((await toolsList(sid)).status).toBe(200);
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      closed.mockRestore();
    }
  });

  // ~2.7 MB of heap per session and no ceiling on how many: a client that
  // re-initializes on every request could exhaust a 256 MB VM within the sweep window.
  it("caps live sessions, evicting the least recently used", async () => {
    const first = await initialize();
    const second = await initialize();
    const rest: string[] = [];
    for (let i = 0; i < 29; i++) rest.push(await initialize());
    expect((await toolsList(first)).status).toBe(200); // touch: `second` is now the oldest
    for (let i = 0; i < 12; i++) rest.push(await initialize()); // well past the cap of 32
    const evicted = await toolsList(second);
    expect(evicted.status).toBe(404);
    expect(((await evicted.json()) as { error: { message: string } }).error.message).toMatch(/session not found/i);
    expect((await toolsList(first)).status).toBe(200); // recently used, so kept
    expect((await toolsList(rest.at(-1)!)).status).toBe(200);
  });
});
