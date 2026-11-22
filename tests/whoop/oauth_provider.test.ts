import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { WhoopOAuthProvider, renderConsentForm, redirectDestination } from "../../src/whoop/oauth_provider.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "hunter2-correct-horse";
const STATIC = SECRET;

function provider(): WhoopOAuthProvider {
  return new WhoopOAuthProvider({ signingSecret: SECRET, password: PASSWORD, staticToken: STATIC });
}

// PKCE S256: code_challenge = base64url(sha256(code_verifier))
function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function registerClient(p: WhoopOAuthProvider, redirectUri: string) {
  const store = p.clientsStore;
  return store.registerClient!({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "",
  } as never);
}

describe("WhoopOAuthProvider — dynamic client registration (stateless)", () => {
  it("registers a client and can read it back via getClient", async () => {
    const p = provider();
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const client = await registerClient(p, redirect);
    expect(client.client_id).toMatch(/^c\./);
    const fetched = await p.clientsStore.getClient(client.client_id);
    expect(fetched?.redirect_uris).toEqual([redirect]);
  });

  it("a client_id from one provider instance survives in a fresh instance (no shared state)", async () => {
    // Simulates a server restart: the signed client_id must still decode under
    // the same signing secret, so Claude never has to re-register.
    const client = await registerClient(provider(), "https://claude.ai/cb");
    const afterRestart = provider();
    const fetched = await afterRestart.clientsStore.getClient(client.client_id);
    expect(fetched?.redirect_uris).toEqual(["https://claude.ai/cb"]);
  });

  it("rejects a forged client_id", async () => {
    const p = provider();
    expect(await p.clientsStore.getClient("c.not-a-real-signed-token")).toBeUndefined();
    expect(await p.clientsStore.getClient("random")).toBeUndefined();
  });
});

describe("WhoopOAuthProvider — authorization code flow + PKCE", () => {
  it("full flow: consent → code → token, with correct PKCE", async () => {
    const p = provider();
    const redirect = "https://claude.ai/cb";
    const client = await registerClient(p, redirect);
    const verifier = "a".repeat(64);
    const challenge = challengeFor(verifier);

    const redirectUrl = p.consent({
      clientId: client.client_id,
      redirectUri: redirect,
      codeChallenge: challenge,
      state: "xyz",
      scopes: "",
      resource: "",
      password: PASSWORD,
    });
    expect(redirectUrl).not.toBeNull();
    const url = new URL(redirectUrl!);
    expect(url.searchParams.get("state")).toBe("xyz");
    const code = url.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // The SDK validates PKCE using challengeForAuthorizationCode.
    expect(await p.challengeForAuthorizationCode(client, code)).toBe(challenge);

    const tokens = await p.exchangeAuthorizationCode(client, code);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // The issued access token verifies.
    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
  });

  it("rejects consent with the wrong password", () => {
    const p = provider();
    const redirect = "https://claude.ai/cb";
    // Need a registered client for the redirect check to pass that far.
    // (Even with a valid client, wrong password returns null.)
    const result = p.consent({
      clientId: "c.whatever",
      redirectUri: redirect,
      codeChallenge: "x",
      state: "",
      scopes: "",
      resource: "",
      password: "wrong",
    });
    expect(result).toBeNull();
  });

  it("accepts a loopback redirect_uri on a different port (RFC 8252, same rule as the SDK's /authorize)", async () => {
    const p = provider();
    const client = await registerClient(p, "http://127.0.0.1:33418/callback");
    const redirectUrl = p.consent({
      clientId: client.client_id, redirectUri: "http://127.0.0.1:51234/callback", codeChallenge: "x",
      state: "", scopes: "", resource: "", password: PASSWORD,
    });
    expect(redirectUrl).not.toBeNull();
    expect(new URL(redirectUrl!).port).toBe("51234");
  });

  it("still rejects a non-loopback or different-path redirect_uri", async () => {
    const p = provider();
    const loop = await registerClient(p, "http://127.0.0.1:33418/callback");
    const web = await registerClient(p, "https://claude.ai/cb");
    const base = { codeChallenge: "x", state: "", scopes: "", resource: "", password: PASSWORD };
    expect(p.consent({ ...base, clientId: loop.client_id, redirectUri: "http://127.0.0.1:1/other" })).toBeNull();
    expect(p.consent({ ...base, clientId: loop.client_id, redirectUri: "http://localhost:33418/callback" })).toBeNull();
    expect(p.consent({ ...base, clientId: web.client_id, redirectUri: "https://claude.ai:8443/cb" })).toBeNull();
  });

  it("checkPassword distinguishes a wrong password from other consent failures", () => {
    const p = provider();
    expect(p.checkPassword(PASSWORD)).toBe(true);
    expect(p.checkPassword("wrong")).toBe(false);
    expect(p.checkPassword("")).toBe(false);
  });

  it("issues no code when no password is configured, even for an empty password", async () => {
    const p = new WhoopOAuthProvider({ signingSecret: SECRET, password: "", staticToken: STATIC });
    const client = await registerClient(p, "https://claude.ai/cb");
    expect(p.checkPassword("")).toBe(false);
    expect(p.consent({
      clientId: client.client_id, redirectUri: "https://claude.ai/cb", codeChallenge: "x",
      state: "", scopes: "", resource: "", password: "",
    })).toBeNull();
  });

  it("a resource that isn't a URL doesn't mint a token that fails verification", async () => {
    const p = provider();
    const client = await registerClient(p, "https://claude.ai/cb");
    const tokensFor = async (resource: string) => {
      const code = new URL(p.consent({
        clientId: client.client_id, redirectUri: "https://claude.ai/cb", codeChallenge: "x",
        state: "", scopes: "", resource, password: PASSWORD,
      })!).searchParams.get("code")!;
      return p.exchangeAuthorizationCode(client, code);
    };
    // Used to throw TypeError: Invalid URL on every request → 500 from the bearer middleware.
    const info = await p.verifyAccessToken((await tokensFor("not a url")).access_token);
    expect(info.resource).toBeUndefined();
    const withResource = await p.verifyAccessToken((await tokensFor("https://totem.example/mcp")).access_token);
    expect(withResource.resource?.href).toBe("https://totem.example/mcp");
  });

  it("forgets authorization codes that were never redeemed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const p = provider();
      const client = await registerClient(p, "https://claude.ai/cb");
      const approve = () => p.consent({
        clientId: client.client_id, redirectUri: "https://claude.ai/cb", codeChallenge: "x",
        state: "", scopes: "", resource: "", password: PASSWORD,
      });
      const held = (p as unknown as { codes: Map<string, unknown> }).codes;
      for (let i = 0; i < 5; i++) approve();
      expect(held.size).toBe(5);
      vi.setSystemTime(Date.now() + 61_000);
      approve();
      expect(held.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an authorization code is single-use", async () => {
    const p = provider();
    const redirect = "https://claude.ai/cb";
    const client = await registerClient(p, redirect);
    const code = new URL(p.consent({
      clientId: client.client_id, redirectUri: redirect, codeChallenge: challengeFor("v".repeat(64)),
      state: "", scopes: "", resource: "", password: PASSWORD,
    })!).searchParams.get("code")!;

    await p.exchangeAuthorizationCode(client, code);
    await expect(p.exchangeAuthorizationCode(client, code)).rejects.toThrow();
  });
});

describe("WhoopOAuthProvider — token verification", () => {
  it("accepts the static token (Claude Code / Desktop bridge) with a far-future expiry", async () => {
    const info = await provider().verifyAccessToken(STATIC);
    expect(info.clientId).toBe("static");
    expect(typeof info.expiresAt).toBe("number");
    expect(info.expiresAt!).toBeGreaterThan(Date.now() / 1000);
  });

  it("rejects a garbage token with InvalidTokenError (→ 401, not 500)", async () => {
    await expect(provider().verifyAccessToken("garbage")).rejects.toMatchObject({
      errorCode: "invalid_token",
    });
  });

  it("refresh token exchange issues a fresh access token", async () => {
    const p = provider();
    const client = await registerClient(p, "https://claude.ai/cb");
    const code = new URL(p.consent({
      clientId: client.client_id, redirectUri: "https://claude.ai/cb",
      codeChallenge: challengeFor("z".repeat(64)), state: "", scopes: "", resource: "", password: PASSWORD,
    })!).searchParams.get("code")!;
    const tokens = await p.exchangeAuthorizationCode(client, code);
    const refreshed = await p.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(refreshed.access_token).toBeTruthy();
    const info = await p.verifyAccessToken(refreshed.access_token);
    expect(info.clientId).toBe(client.client_id);
  });
});

// Registration is open, so anyone can mint a client whose redirect is their own
// site and send the owner a link to the owner's own /authorize. The page has to
// say where the code is going; it used to read "connect this server to Claude"
// for every client.
describe("consent page — names who receives access", () => {
  const page = (redirectUri: string) => renderConsentForm({
    clientId: "c.x", redirectUri, codeChallenge: "x", state: "", scopes: "", resource: "", error: false,
  });

  it("shows the redirect host for the real connector and for anyone else", () => {
    expect(page("https://claude.ai/api/mcp/auth_callback")).toContain("Access will be sent to <b>claude.ai</b>.");
    const phishing = page("https://claude.ai.evil.example/api/mcp/auth_callback");
    expect(phishing).toContain("Access will be sent to <b>claude.ai.evil.example</b>.");
    expect(phishing).toContain("<h1>Allow claude.ai.evil.example to access WHOOP</h1>");
    expect(phishing).not.toMatch(/Allow Claude\b|from Claude\b/);
  });

  it("describes loopback, plain-http and custom-scheme destinations", () => {
    expect(redirectDestination("http://127.0.0.1:33418/callback")).toBe("an app on this device (127.0.0.1:33418)");
    expect(redirectDestination("http://localhost:1/cb")).toBe("an app on this device (localhost:1)");
    expect(redirectDestination("http://intranet.example/cb")).toBe("http://intranet.example");
    expect(redirectDestination("cursor://anysphere.cursor-mcp/oauth/callback")).toBe("cursor://anysphere.cursor-mcp");
    expect(redirectDestination("https://xn--clude-0qa.ai/cb")).toBe("xn--clude-0qa.ai"); // lookalike shown in punycode
    expect(redirectDestination("not a url")).toBe("an unrecognised address");
  });

  it("escapes everything it reflects", () => {
    const html = renderConsentForm({
      clientId: '"><script>1</script>', redirectUri: '"><img src=x onerror=1>', codeChallenge: "x",
      state: "'\"<>&", scopes: "", resource: "", error: true,
    });
    expect(html).not.toMatch(/<script>|<img/);
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

// The SDK's /token handler answers 400 only for its own OAuthError types; any
// other throw becomes 500 `server_error`. Clients re-run /authorize on
// `invalid_grant` and treat a 500 as an outage.
describe("WhoopOAuthProvider — /token answers invalid_grant for a dead grant", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function tokenEndpoint(p: WhoopOAuthProvider) {
    const app = express();
    app.use(mcpAuthRouter({ provider: p, issuerUrl: new URL("http://localhost") }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    const post = async (form: Record<string, string>) => {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams(form) });
      return { status: r.status, body: (await r.json()) as { error?: string; scope?: string } };
    };
    return { post, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  async function issue(p: WhoopOAuthProvider, scopes = "") {
    const redirect = "https://claude.ai/cb";
    const client = await registerClient(p, redirect);
    const verifier = "q".repeat(64);
    const code = new URL(p.consent({
      clientId: client.client_id, redirectUri: redirect, codeChallenge: challengeFor(verifier),
      state: "", scopes, resource: "", password: PASSWORD,
    })!).searchParams.get("code")!;
    return { client, verifier, code, redirect };
  }

  const invalidGrant = { status: 400, body: expect.objectContaining({ error: "invalid_grant" }) };

  it("a replayed or unknown authorization code is 400 invalid_grant, not 500", async () => {
    const p = provider();
    const { client, verifier, code } = await issue(p);
    const { post, close } = await tokenEndpoint(p);
    try {
      const grant = { grant_type: "authorization_code", client_id: client.client_id, code_verifier: verifier };
      expect((await post({ ...grant, code })).status).toBe(200);
      expect(await post({ ...grant, code })).toEqual(invalidGrant);
      expect(await post({ ...grant, code: "never-issued" })).toEqual(invalidGrant);
    } finally {
      await close();
    }
  });

  it("a bad refresh token is 400 invalid_grant, not 500", async () => {
    const p = provider();
    const { client, code } = await issue(p);
    const tokens = await p.exchangeAuthorizationCode(client, code);
    const { post, close } = await tokenEndpoint(p);
    try {
      const grant = { grant_type: "refresh_token", client_id: client.client_id };
      for (const refresh_token of ["garbage", tokens.access_token]) {
        expect(await post({ ...grant, refresh_token })).toEqual(invalidGrant);
      }
      expect((await post({ ...grant, refresh_token: tokens.refresh_token! })).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("a refresh can narrow the granted scope but not widen it", async () => {
    const p = provider();
    const { client, code } = await issue(p, "read write");
    const tokens = await p.exchangeAuthorizationCode(client, code);
    const { post, close } = await tokenEndpoint(p);
    try {
      const grant = { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token! };
      expect(await post({ ...grant, scope: "read admin" })).toEqual({ status: 400, body: expect.objectContaining({ error: "invalid_scope" }) });
      expect(await post({ ...grant, scope: "read" })).toEqual({ status: 200, body: expect.objectContaining({ scope: "read" }) });
      expect(await post(grant)).toEqual({ status: 200, body: expect.objectContaining({ scope: "read write" }) });
    } finally {
      await close();
    }
  });

  it("an expired refresh token or authorization code rejects with invalid_grant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = provider();
    const first = await issue(p);
    const tokens = await p.exchangeAuthorizationCode(first.client, first.code);
    const second = await issue(p);
    vi.setSystemTime(Date.now() + 61_000); // codes live 60s
    await expect(p.challengeForAuthorizationCode(second.client, second.code)).rejects.toMatchObject({ errorCode: "invalid_grant" });
    await expect(p.exchangeAuthorizationCode(second.client, second.code)).rejects.toMatchObject({ errorCode: "invalid_grant" });
    vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000); // refresh tokens live 30 days
    await expect(p.exchangeRefreshToken(first.client, tokens.refresh_token!)).rejects.toMatchObject({ errorCode: "invalid_grant" });
  });
});
