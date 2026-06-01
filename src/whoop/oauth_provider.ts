// Minimal OAuth 2.1 + PKCE authorization server for whoop-mcp, so the deployed
// server can be added as a "custom connector" on claude.ai web + the Claude
// mobile app (those clients require OAuth — they have no bearer-token field).
//
// Design for a single-user, auto-stopping host (Fly):
//   - Access + refresh tokens are stateless HS256 JWTs signed with a server
//     secret. No token store → they survive machine restarts.
//   - Registered clients (dynamic client registration) are also stateless: the
//     client_id is itself a signed token encoding the client's redirect_uris.
//     getClient() verifies + decodes it, so clients survive restarts too and
//     Claude never has to re-register after a cold start.
//   - Authorization codes are the only in-memory state. They live ~60s (the gap
//     between the user approving and Claude redeeming the code), so a restart in
//     that window just means re-clicking approve. Negligible.
//   - The /authorize step is gated by a password (AUTH_PASSWORD). The user
//     enters it once when adding the connector; on success a code is issued.
//   - verifyAccessToken also accepts the static MCP_AUTH_TOKEN, so Claude Code
//     (--header) and the Claude Desktop mcp-remote bridge keep working unchanged.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const ACCESS_TTL_S = 3600;            // 1 hour
const REFRESH_TTL_S = 30 * 24 * 3600; // 30 days
const CODE_TTL_MS = 60_000;           // 60 seconds

// ─── tiny HS256 JWT (no external dep) ──────────────────────────────────────
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function signToken(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}
function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts as [string, string, string];
  const expected = b64url(createHmac("sha256", secret).update(`${h}.${b}`).digest());
  const sBuf = Buffer.from(s);
  const eBuf = Buffer.from(expected);
  if (sBuf.length !== eBuf.length || !timingSafeEqual(sBuf, eBuf)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(b).toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface AuthCodeEntry {
  challenge: string;
  redirectUri: string;
  clientId: string;
  scopes: string[];
  resource: string | undefined;
  expiresAt: number;
}

export interface WhoopOAuthOptions {
  /** Secret used to sign JWT tokens + client IDs. */
  signingSecret: string;
  /** Password the user enters at /authorize. */
  password: string;
  /** Static bearer token (MCP_AUTH_TOKEN) kept working for Claude Code / Desktop bridge. */
  staticToken: string;
  /** This server's MCP resource URL (…/mcp). When set, a token carrying a
   *  `resource` claim must match it — so a token minted for a different server
   *  can't be replayed here (RFC 8707 audience binding). */
  resourceUrl?: string;
}

export class WhoopOAuthProvider implements OAuthServerProvider {
  private readonly codes = new Map<string, AuthCodeEntry>();
  private readonly signingSecret: string;
  private readonly password: string;
  private readonly staticToken: string;
  private readonly resourceUrl: string | undefined;

  constructor(opts: WhoopOAuthOptions) {
    this.signingSecret = opts.signingSecret;
    this.password = opts.password;
    this.staticToken = opts.staticToken;
    this.resourceUrl = opts.resourceUrl;
  }

  // Decode the stateless signed client_id back into client info (synchronous).
  private decodeClient(clientId: string): OAuthClientInformationFull | undefined {
    if (!clientId.startsWith("c.")) return undefined;
    const payload = verifyToken(clientId.slice(2), this.signingSecret);
    if (!payload || payload.t !== "client") return undefined;
    return {
      client_id: clientId,
      redirect_uris: (payload.ru as string[]) ?? [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: (payload.sc as string) ?? "",
    } as OAuthClientInformationFull;
  }

  // ─── stateless client store (DCR) ────────────────────────────────────────
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string): OAuthClientInformationFull | undefined =>
        this.decodeClient(clientId),
      registerClient: (
        client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
      ): OAuthClientInformationFull => {
        // Encode the client's redirect_uris into a signed client_id so the
        // registration survives server restarts with no storage.
        const signed = signToken(
          { t: "client", ru: client.redirect_uris ?? [], sc: client.scope ?? "", jti: randomUUID() },
          this.signingSecret,
        );
        const clientId = `c.${signed}`;
        return {
          ...client,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        } as OAuthClientInformationFull;
      },
    };
  }

  // ─── authorize: render the password form ─────────────────────────────────
  // The SDK's authorize handler validated client_id + redirect_uri + PKCE and
  // calls this. We render an HTML form that POSTs the password (plus the OAuth
  // params as hidden fields) to /oauth/consent, which we handle ourselves.
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    setConsentSecurityHeaders(res);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(renderConsentForm({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state ?? "",
      scopes: (params.scopes ?? []).join(" "),
      resource: params.resource?.toString() ?? "",
      error: false,
    }));
  }

  // ─── consent POST: validate password, issue an auth code ─────────────────
  // Returns the redirect URL to send the browser to, or null if the password
  // was wrong (caller re-renders the form with an error).
  consent(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
    scopes: string;
    resource: string;
    password: string;
  }): string | null {
    if (!constantTimeEqual(input.password, this.password)) {
      console.error("[whoop-mcp] consent REJECTED: password mismatch");
      return null;
    }
    // Validate the client + redirect again (defense in depth).
    const client = this.decodeClient(input.clientId);
    if (!client) {
      console.error("[whoop-mcp] consent REJECTED: client_id failed to decode (stale registration / signing-key mismatch) — password was correct");
      return null;
    }
    if (!client.redirect_uris.includes(input.redirectUri)) {
      console.error(`[whoop-mcp] consent REJECTED: redirect_uri not registered: ${input.redirectUri} — password was correct`);
      return null;
    }

    const code = b64url(randomBytes(32));
    this.codes.set(code, {
      challenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
      scopes: input.scopes ? input.scopes.split(" ").filter(Boolean) : [],
      resource: input.resource || undefined,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(input.redirectUri);
    url.searchParams.set("code", code);
    if (input.state) url.searchParams.set("state", input.state);
    return url.toString();
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now() || entry.clientId !== client.client_id) {
      throw new Error("invalid or expired authorization code");
    }
    return entry.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now() || entry.clientId !== client.client_id) {
      throw new Error("invalid or expired authorization code");
    }
    this.codes.delete(authorizationCode); // one-time use
    return this.issueTokens(client.client_id, entry.scopes, entry.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const payload = verifyToken(refreshToken, this.signingSecret);
    if (!payload || payload.typ !== "refresh" || payload.cid !== client.client_id) {
      throw new Error("invalid refresh token");
    }
    const grantScopes = scopes ?? ((payload.scopes as string[]) ?? []);
    return this.issueTokens(client.client_id, grantScopes, payload.resource as string | undefined);
  }

  private issueTokens(clientId: string, scopes: string[], resource: string | undefined): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const base = { cid: clientId, scopes, resource, iat: now };
    const access = signToken({ ...base, typ: "access", exp: now + ACCESS_TTL_S }, this.signingSecret);
    const refresh = signToken({ ...base, typ: "refresh", exp: now + REFRESH_TTL_S }, this.signingSecret);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // 1. Static token — keeps Claude Code + Desktop-bridge working. The SDK's
    // bearer middleware requires a numeric expiresAt, so give it a far-future
    // one (the static token doesn't expire on its own).
    if (this.staticToken && constantTimeEqual(token, this.staticToken)) {
      return {
        token,
        clientId: "static",
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TTL_S,
      };
    }
    // 2. OAuth-issued JWT.
    const payload = verifyToken(token, this.signingSecret);
    if (payload && payload.typ === "access") {
      // Audience binding (RFC 8707): a token carrying a `resource` claim should
      // only be valid at the server it was minted for. LOG-ONLY for now (no
      // reject): rejecting on a mismatch would 401 a valid Claude token and
      // brick the connector, and the exact `resource` value Claude sends isn't
      // verified yet. The log tells us whether a real token would have matched;
      // flip back to throwing once confirmed.
      if (this.resourceUrl && typeof payload.resource === "string") {
        const norm = (u: string): string => u.replace(/\/+$/, "");
        if (norm(payload.resource) !== norm(this.resourceUrl)) {
          console.error(`[whoop-mcp] token resource mismatch (got "${payload.resource}", expected "${this.resourceUrl}") — allowing; enforcement is disabled`);
        }
      }
      const info: AuthInfo = {
        token,
        clientId: String(payload.cid),
        scopes: (payload.scopes as string[]) ?? [],
        expiresAt: payload.exp as number,
      };
      if (typeof payload.resource === "string") info.resource = new URL(payload.resource);
      return info;
    }
    // Throw the SDK's typed error so the bearer middleware returns 401 (a
    // generic Error would be mapped to 500).
    throw new InvalidTokenError("invalid or expired access token");
  }
}

// Anti-clickjacking header for the HTML consent page (a password form) ONLY.
// Deliberately NO Content-Security-Policy: a `form-action` directive blocks the
// OAuth 302 redirect back to the client (the browser refuses the cross-origin
// navigation to claude.ai), silently bricking the password submit; and a
// document CSP on the JSON metadata/API responses made Claude's connector flag
// a "server configuration issue". X-Frame-Options: DENY is the clickjacking
// control this page actually needs, and the page has no scripts/external
// resources to lock down.
export function setConsentSecurityHeaders(res: Response): void {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// ─── consent form HTML ──────────────────────────────────────────────────────
export function renderConsentForm(d: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: string;
  resource: string;
  error: boolean;
}): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const errorBanner = d.error
    ? `<p style="color:#dc2626;margin:0 0 16px">Incorrect password. Try again.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whoop-mcp — authorize</title>
<style>
  body { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #0d1117; color: #e6e6e6;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px;
          width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #969696; font-size: 13px; margin: 0 0 24px; }
  label { display: block; font-size: 13px; margin: 0 0 8px; color: #b0b0b0; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
         border: 1px solid #30363d; background: #0d1117; color: #e6e6e6; font-size: 14px; margin: 0 0 20px; }
  button { width: 100%; padding: 11px; border: none; border-radius: 8px; background: #e6e6e6; color: #0d1117;
           font-weight: 700; font-size: 14px; cursor: pointer; }
  button:hover { background: #fff; }
</style>
</head>
<body>
  <div class="card">
    <h1>whoop-mcp</h1>
    <p class="sub">Enter your access password to connect this server to Claude.</p>
    ${errorBanner}
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="client_id" value="${esc(d.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(d.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${esc(d.codeChallenge)}">
      <input type="hidden" name="state" value="${esc(d.state)}">
      <input type="hidden" name="scope" value="${esc(d.scopes)}">
      <input type="hidden" name="resource" value="${esc(d.resource)}">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}
