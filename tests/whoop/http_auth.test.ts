// Verifies the HTTP transport boots, rejects unauthenticated requests, and
// accepts authenticated ones. Also checks JSON stream cleanup through the
// application's MCP request handler with a stub client.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { startHttpServer } from "../../src/server-http.js";
import type { WhoopClient } from "../../src/whoop/client.js";

const PORT = 39812;
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = `http://127.0.0.1:${PORT}`;

// Minimal stub — these tests never reach the Whoop API. The HTTP gate sits
// in front of every MCP call, so we don't need a real client to test it.
const stubClient = {
  get: async () => ({}),
  post: async () => ({}),
  put: async () => ({}),
  delete: async () => ({}),
} as unknown as WhoopClient;

describe("HTTP transport: bearer-auth gate", () => {
  beforeAll(async () => {
    await startHttpServer(stubClient, { authToken: TOKEN, port: PORT, host: "127.0.0.1" });
    // Give the listener a tick to bind
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => {
    // The HTTP server runs until process exit; vitest tears it down with the
    // process. We don't expose a close handle.
  });

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

describe("HTTP transport: misconfiguration", () => {
  it("refuses to start with a missing auth token", async () => {
    await expect(
      startHttpServer(stubClient, { authToken: "", port: PORT + 1 }),
    ).rejects.toThrow(/MCP_AUTH_TOKEN/);
  });

  it("refuses to start with a too-short auth token", async () => {
    await expect(
      startHttpServer(stubClient, { authToken: "short", port: PORT + 2 }),
    ).rejects.toThrow(/16 chars/);
  });
});
