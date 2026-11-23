// Verifies the HTTP transport boots, rejects unauthenticated requests, and
// accepts authenticated ones. Checks the auth gate, the health probe, the route
// shape, session routing, and JSON stream cleanup through the application's MCP
// request handler with a stub client.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { startHttpServer, resolvePort, type HttpServerHandle } from "../../src/server-http.js";
import type { WhoopClient } from "../../src/whoop/client.js";

// Port 0: the OS picks a free port, so parallel runs (other worktrees, a stale
// server) never collide on a fixed one.
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let BASE = "";

// Minimal stub — these tests never reach the Whoop API. The HTTP gate sits
// in front of every MCP call, so we don't need a real client to test it.
const stubClient = {
  get: async () => ({}),
  post: async () => ({}),
  put: async () => ({}),
  delete: async () => ({}),
} as unknown as WhoopClient;

describe("HTTP transport: bearer-auth gate", () => {
  let server: HttpServerHandle;
  beforeAll(async () => {
    server = await startHttpServer(stubClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    BASE = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.close());

  it("rejects /mcp with no Authorization header (401)", async () => {
    const r = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("rejects /mcp with wrong token (401)", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token-but-same-length-as-the-real-one-pad-pad" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });

  it("rejects /mcp with a wrong-length token (401, constant-time path)", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer short" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });

  it("rejects malformed JSON body (400)", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "not json",
    });
    expect(r.status).toBe(400);
  });

  it("serves /health without auth (200)", async () => {
    const r = await fetch(`${BASE}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("returns 404 for unknown paths even with valid auth", async () => {
    const r = await fetch(`${BASE}/random`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(404);
  });

  it("responds to OPTIONS preflight with CORS headers (204)", async () => {
    const r = await fetch(`${BASE}/mcp`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-methods")).toMatch(/POST/);
    const allow = (r.headers.get("access-control-allow-headers") ?? "").split(/,\s*/);
    for (const h of ["authorization", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
      expect(allow).toContain(h);
    }
    expect(r.headers.get("access-control-expose-headers")).toMatch(/mcp-session-id/);
  });

  it("releases JSON streams through the MCP request handler", async () => {
    const handled = vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest");
    try {
      const post = (body: unknown, sid?: string) => fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          ...(sid ? { "mcp-session-id": sid } : {}),
        },
        body: JSON.stringify(body),
      });
      const init = await post({
        jsonrpc: "2.0", id: 0, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      expect(init.status).toBe(200);
      const sid = init.headers.get("mcp-session-id");
      expect(sid).toBeTruthy();
      await init.text();
      await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid!)).text();
      for (let id = 1; id <= 3; id++) {
        const response = await post({ jsonrpc: "2.0", id, method: "tools/list" }, sid!);
        expect(response.status).toBe(200);
        expect((await response.json()).result.tools.length).toBeGreaterThan(0);
      }
      const transport = handled.mock.contexts[0] as unknown as {
        _webStandardTransport: { _streamMapping: Map<string, unknown> };
      };
      await vi.waitFor(() => expect(transport._webStandardTransport._streamMapping.size).toBe(0));
    } finally {
      handled.mockRestore();
    }
  });
});

describe("HTTP transport: startup", () => {
  it("resolves once bound, and reports the port the OS assigned", async () => {
    const server = await startHttpServer(stubClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    try {
      expect(server.port).toBeGreaterThan(0);
      // No "give the listener a tick" sleep: it is already accepting.
      expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("rejects when the port is taken instead of logging that it is listening", async () => {
    const first = await startHttpServer(stubClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        startHttpServer(stubClient, { authToken: TOKEN, port: first.port, host: "127.0.0.1" }),
      ).rejects.toThrow(/already in use/);
      expect(logged.mock.calls.flat().join("\n")).not.toMatch(/listening on/);
    } finally {
      logged.mockRestore();
      await first.close();
    }
  });

  it("close() stops the listener and frees the port", async () => {
    const server = await startHttpServer(stubClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    await server.close();
    await expect(fetch(`http://127.0.0.1:${server.port}/health`)).rejects.toThrow();
    const again = await startHttpServer(stubClient, { authToken: TOKEN, port: server.port, host: "127.0.0.1" });
    await again.close();
  });

  // Every connected client holds GET /mcp open. server.close() waits for all
  // connections, so shutdown used to sit out the 5s grace and exit 1.
  it("close() finishes promptly while a client holds its event stream open", async () => {
    const server = await startHttpServer(stubClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();
    const stream = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream", "mcp-session-id": sid } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toMatch(/text\/event-stream/);

    const closed = await Promise.race([
      server.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open after 2s"), 2000)),
    ]);
    expect(closed).toBe("closed");
    await stream.body?.cancel().catch(() => {});
  });
});

describe("resolvePort", () => {
  it("falls back past an empty PORT instead of binding a random port", () => {
    expect(resolvePort({ PORT: "" })).toBe(3000); // was Number("") = 0
    expect(resolvePort({ PORT: "", MCP_HTTP_PORT: "8123" })).toBe(8123);
    expect(resolvePort({})).toBe(3000);
    expect(resolvePort({ PORT: "8080", MCP_HTTP_PORT: "8123" })).toBe(8080);
  });

  it("names the variable when the value isn't a port", () => {
    for (const PORT of ["abc", "80a", "-1", "70000", "3000.5"]) {
      expect(() => resolvePort({ PORT }), PORT).toThrow(/Invalid port .*PORT/);
    }
  });
});

describe("HTTP transport: misconfiguration", () => {
  it("refuses to start with a missing auth token", async () => {
    await expect(
      startHttpServer(stubClient, { authToken: "", port: 0 }),
    ).rejects.toThrow(/MCP_AUTH_TOKEN/);
  });

  it("refuses to start with a too-short auth token", async () => {
    await expect(
      startHttpServer(stubClient, { authToken: "short", port: 0 }),
    ).rejects.toThrow(/at least 32 characters/);
  });
});

describe("HTTP transport: session lifecycle", () => {
  let server: HttpServerHandle;
  let base = "";
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  beforeAll(async () => {
    server = await startHttpServer(stubClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.close());

  it("issues a session id on initialize and accepts it on follow-up calls", async () => {
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();

    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
  });

  // Ids are dropped by the idle sweep and on restart; see mcpHandler for why 404.
  it("answers 404 Session not found for an unknown session id", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/session not found/i);
  });
});
