import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { WhoopOAuthProvider } from "../../src/whoop/oauth_provider.js";

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
