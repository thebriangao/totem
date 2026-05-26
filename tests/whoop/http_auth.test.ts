// Verifies the HTTP transport boots, rejects unauthenticated requests, and
// accepts authenticated ones. Doesn't exercise the full MCP protocol — just
// the auth gate, the health probe, and the route shape.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
