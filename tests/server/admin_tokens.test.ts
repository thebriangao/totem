// POST/GET /admin/tokens: how `totem auth` pushes a login to a deployment.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createHmac } from "node:crypto";
import { inspect } from "node:util";
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

  it("an unset or short MCP_AUTH_TOKEN never opens the endpoint", () => {
    // `Bearer <NBSP><NBSP>` trims to "", which would equal an empty token.
    expect(bearerMatches("Bearer   ", "")).toBe(false);
    expect(bearerMatches("Bearer x", "")).toBe(false);
    expect(() => mountAdminTokens(express(), { authToken: "", tokens: fakeTokens() })).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => mountAdminTokens(express(), { authToken: "short-token", tokens: fakeTokens() })).toThrow(/MCP_AUTH_TOKEN/);
  });
});

describe("bodies the endpoint must not parse, echo or log", () => {
  // Express logs unhandled errors unless NODE_ENV is "test" (vitest's default),
  // so run this app the way the Docker image does.
  let s: Server;
  let url: string;
  let t: ReturnType<typeof fakeTokens>;
  beforeAll(async () => {
    const app = express();
    app.set("env", "production");
    mountAdminTokens(app, { authToken: TOKEN, tokens: { adopt: (r) => t.adopt(r), status: () => t.status(), current: () => t.current() } });
    s = await new Promise<Server>((res) => { const x = app.listen(0, "127.0.0.1", () => res(x)); });
    url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/admin/tokens`;
  });
  afterAll(() => new Promise<void>((res) => s.close(() => res())));
  beforeEach(() => { t = fakeTokens(); });

  const raw = (payload: string, auth: string | null) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: payload });
  const secret = `rt-${"s".repeat(60)}`;
  const malformed = `{"access_token": "${access}", refresh_token: "${secret}"}`; // a quoting slip in a hand-written push
  const oversized = JSON.stringify({ ...body, pad: "x".repeat(40_000) });

  it("checks the token before it reads a body", async () => {
    expect((await raw(oversized, null)).status).toBe(401);
    expect((await raw(malformed, "Bearer wrong")).status).toBe(401);
  });

  it("answers a malformed or oversized body in JSON, without echoing or logging it", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => inspect(a)).join(" ")); });
    try {
      const bad = await raw(malformed, `Bearer ${TOKEN}`);
      expect(bad.status).toBe(400);
      expect(bad.headers.get("content-type")).toMatch(/application\/json/);
      const badText = await bad.text();
      expect(JSON.parse(badText)).toMatchObject({ error: "invalid_request" });
      const big = await raw(oversized, `Bearer ${TOKEN}`);
      expect(big.status).toBe(413);
      expect(JSON.parse(await big.text())).toMatchObject({ error: "invalid_request" });
      for (const text of [badText, ...logged]) {
        expect(text).not.toContain(secret); // the body held a refresh token
        expect(text).not.toContain(access);
      }
      expect(t.adopt).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
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

    // An OAuth access token (what claude.ai holds) opens /mcp but not the login.
    const b64u = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    const signingSecret = createHmac("sha256", TOKEN).update("totem/oauth-jwt-signing/v1").digest("hex");
    const nowS = Math.floor(Date.now() / 1000);
    const data = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ cid: "c.test", scopes: [], iat: nowS, typ: "access", exp: nowS + 3600 })}`;
    const oauth = `${data}.${createHmac("sha256", signingSecret).update(data).digest("base64url")}`;
    const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${oauth}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(mcp.status).toBe(200); // the token is genuine
    expect((await fetch(url, { headers: { authorization: `Bearer ${oauth}` } })).status).toBe(401);
    const push = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${oauth}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(push.status).toBe(401);
    expect(t.adopt).toHaveBeenCalledOnce(); // still only the static-token push
  });
});
