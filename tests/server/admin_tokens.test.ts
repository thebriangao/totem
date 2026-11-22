// POST/GET /admin/tokens: how `totem auth` pushes a login to a deployment.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { bearerMatches, mountAdminTokens, parsePushBody } from "../../src/server-admin.js";
import { startHttpServer } from "../../src/server-http.js";
import type { TokenRecord } from "../../src/whoop/token_store.js";
import type { TokenStatus } from "../../src/whoop/token_manager.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { WEB_CLIENT_ID } from "../../src/whoop/constants.js";
import { jwt } from "../whoop/jwt_helper.js";

const TOKEN = "f".repeat(64);
const access = jwt({ client_id: WEB_CLIENT_ID });
const body = { access_token: access, refresh_token: "r".repeat(48), source: "browser", user_id: 44 };

function fakeTokens(current: TokenRecord | null = null) {
  const status: TokenStatus = { state: current ? "ok" : "no-login", role: "owner", store: "/data/tokens.json" };
  return {
    adopt: vi.fn((r: TokenRecord) => { current = r; status.state = "ok"; status.source = r.source; }),
    status: vi.fn(() => ({ ...status })),
    current: vi.fn(() => current),
  };
}

let server: Server;
let base: string;
let tokens: ReturnType<typeof fakeTokens>;

beforeAll(async () => {
  const app = express();
  // Indirection so each test can swap the fake.
  mountAdminTokens(app, {
    authToken: TOKEN,
    tokens: { adopt: (r) => tokens.adopt(r), status: () => tokens.status(), current: () => tokens.current() },
    installationId: () => "SERVER-IID",
  });
  server = await new Promise<Server>((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((res) => server.close(() => res())));
beforeEach(() => { tokens = fakeTokens(); });

const post = (b: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
  fetch(`${base}/admin/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(b),
  });

describe("POST /admin/tokens", () => {
  it("rejects a request without the MCP_AUTH_TOKEN", async () => {
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, "Bearer wrong")).status).toBe(401);
    expect((await post(body, `Basic ${TOKEN}`)).status).toBe(401);
    expect(tokens.adopt).not.toHaveBeenCalled();
  });

  it("installs the login and never echoes token values", async () => {
    const r = await post(body);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(body.refresh_token);
    expect(text).not.toContain(access);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, state: "ok", source: "browser" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(tokens.adopt).toHaveBeenCalledWith(expect.objectContaining({
      access_token: access,
      refresh_token: body.refresh_token,
      client_id: WEB_CLIENT_ID, // inferred from the JWT
      source: "browser",
      user_id: 44,
      installation_id: "SERVER-IID",
    }));
  });

  it("keeps the server's existing installation id across logins", async () => {
    tokens = fakeTokens({ access_token: access, refresh_token: "x".repeat(30), client_id: WEB_CLIENT_ID, source: "push", saved_at: "t", installation_id: "KEEP-ME" });
    await post(body);
    expect(tokens.adopt.mock.calls[0]![0].installation_id).toBe("KEEP-ME");
  });

  it("validates the body", async () => {
    expect((await post({ ...body, access_token: "not-a-jwt" })).status).toBe(400);
    expect((await post({ ...body, refresh_token: "short" })).status).toBe(400);
    expect((await post({ ...body, user_id: -1 })).status).toBe(400);
    expect(tokens.adopt).not.toHaveBeenCalled();
  });

  it("reports a failed write as 500 and keeps the old login", async () => {
    tokens.adopt.mockImplementation(() => { throw new Error("EROFS"); });
    const r = await post(body);
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error_description: string }).error_description).toMatch(/EROFS/);
  });
});

describe("GET /admin/tokens", () => {
  it("returns the login status behind the same gate", async () => {
    expect((await fetch(`${base}/admin/tokens`)).status).toBe(401);
    const r = await fetch(`${base}/admin/tokens`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "no-login", role: "owner", store: "/data/tokens.json" });
  });
});

describe("failed-auth ceiling", () => {
  it("answers 429 after 20 bad tokens in 15 minutes, for every client", async () => {
    let clock = 0;
    const app = express();
    mountAdminTokens(app, { authToken: TOKEN, tokens: fakeTokens(), now: () => clock });
    const s = await new Promise<Server>((res) => { const x = app.listen(0, "127.0.0.1", () => res(x)); });
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/admin/tokens`;
    try {
      for (let i = 0; i < 20; i++) expect((await fetch(url, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(429);
      clock += 15 * 60_000 + 1;
      expect((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    } finally {
      await new Promise<void>((res) => s.close(() => res()));
    }
  });
});

describe("admin helpers", () => {
  it("bearerMatches compares in constant time against the static token", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });

  it("parsePushBody explains what's wrong", () => {
    expect(parsePushBody(null)).toBe("expected a JSON object");
    expect(parsePushBody({ access_token: access })).toMatch(/refresh_token/);
    expect(parsePushBody(body)).toMatchObject({ access_token: access, user_id: 44 });
  });
});

describe("startHttpServer mounts /admin/tokens when given the token manager", () => {
  it("serves it behind MCP_AUTH_TOKEN, and only the static token", async () => {
    const port = 39853;
    const t = fakeTokens();
    await startHttpServer({} as WhoopClient, { authToken: TOKEN, port, host: "127.0.0.1", tokens: t });
    await new Promise((r) => setTimeout(r, 50));
    const url = `http://127.0.0.1:${port}/admin/tokens`;
    expect((await fetch(url)).status).toBe(401);
    const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    expect(t.adopt).toHaveBeenCalledOnce();
  });
});
