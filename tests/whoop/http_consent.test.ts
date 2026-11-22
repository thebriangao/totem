// The password gate (/oauth/consent) and the server's error responses. Both are
// reachable without credentials, so neither may trust the request's shape.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startHttpServer, type HttpServerHandle } from "../../src/server-http.js";
import type { WhoopClient } from "../../src/whoop/client.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery staple";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const stubClient = { get: async () => ({}), post: async () => ({}), put: async () => ({}), delete: async () => ({}) } as unknown as WhoopClient;

describe("HTTP transport: password gate and error responses", () => {
  let server: HttpServerHandle;
  let base = "";
  let clientId = "";
  let errors: ReturnType<typeof vi.spyOn>;
  const previousPassword = process.env.AUTH_PASSWORD;

  beforeAll(async () => {
    process.env.AUTH_PASSWORD = PASSWORD;
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startHttpServer(stubClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${server.port}`;
    const registered = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    clientId = ((await registered.json()) as { client_id: string }).client_id;
  });

  afterAll(async () => {
    await server.close();
    errors.mockRestore();
    if (previousPassword === undefined) delete process.env.AUTH_PASSWORD;
    else process.env.AUTH_PASSWORD = previousPassword;
  });

  // Each request gets its own client address so the per-IP limiter (10 per
  // 15 min) doesn't bleed between tests; `trust proxy` reads it from this header.
  let caller = 0;
  const consent = (body: string | undefined, contentType?: string) => fetch(`${base}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "x-forwarded-for": `198.51.100.${++caller}`, ...(contentType ? { "content-type": contentType } : {}) },
    ...(body === undefined ? {} : { body }),
  });
  const FORM = "application/x-www-form-urlencoded";
  const expectLoginForm = async (r: Response): Promise<void> => {
    const html = await r.text();
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(html).toContain("Incorrect password");
    expect(html).not.toMatch(/TypeError|\bat .*\.(ts|js):\d+/);
  };

  it("answers a body that isn't a form with the login page, not a 500", async () => {
    await expectLoginForm(await consent("{}", "application/json"));
    await expectLoginForm(await consent(undefined));
  });

  it("answers repeated form fields with the login page, not a 500", async () => {
    await expectLoginForm(await consent("client_id=a&client_id=b&password=x&password=y&state=1&state=2", FORM));
  });

  it("does not accept the password spelled as repeated numeric fields", async () => {
    // Buffer.from(["99","111",…]) is the password's bytes, so an array used to
    // compare equal to it. Not a bypass (it needs the password) but not a string either.
    const asBytes = [...Buffer.from(PASSWORD)].map((byte) => `password=${byte}`).join("&");
    const form = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: "x" });
    await expectLoginForm(await consent(`${form.toString()}&${asBytes}`, FORM));
  });

  it("re-renders the form uncacheable, and never echoes the password", async () => {
    const form = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: "x", password: "wrong-guess-123" });
    const r = await consent(form.toString(), FORM);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const html = await r.text();
    expect(html).not.toContain("wrong-guess-123");
  });

  it("still issues a code for the right password", async () => {
    const form = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: "x", state: "s1", password: PASSWORD });
    const r = await consent(form.toString(), FORM);
    expect(r.status).toBe(302);
    const location = new URL(r.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("s1");
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  it("answers malformed and oversized /mcp bodies as JSON, without a stack trace", async () => {
    const post = (body: string) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
    });
    const malformed = await post("not json");
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toMatch(/application\/json/);
    expect(await malformed.json()).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: expect.stringMatching(/parse error/i) }, id: null });

    const oversized = await post(JSON.stringify({ padding: "a".repeat(200_000) }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ jsonrpc: "2.0", error: { code: -32600, message: expect.stringMatching(/too large/i) }, id: null });
  });
});
