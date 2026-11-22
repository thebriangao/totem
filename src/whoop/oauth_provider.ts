// Minimal OAuth 2.1 + PKCE authorization server for totem, so the deployed
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

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";

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
    if (!this.checkPassword(input.password)) {
      console.error("[totem] consent REJECTED: password mismatch");
      return null;
    }
    // Validate the client + redirect again (defense in depth).
    const client = this.decodeClient(input.clientId);
    if (!client) {
      console.error("[totem] consent REJECTED: client_id failed to decode (stale registration / signing-key mismatch) — password was correct");
      return null;
    }
    // Same rule as the SDK's /authorize (RFC 8252: any port on a loopback host),
    // so a redirect /authorize accepted isn't rejected here.
    if (!client.redirect_uris.some((registered) => redirectUriMatches(input.redirectUri, registered))) {
      console.error(`[totem] consent REJECTED: redirect_uri not registered: ${input.redirectUri} — password was correct`);
      return null;
    }

    // Codes are otherwise only removed when redeemed; drop the ones nobody came back for.
    const now = Date.now();
    for (const [stale, entry] of this.codes) if (entry.expiresAt < now) this.codes.delete(stale);

    const code = b64url(randomBytes(32));
    this.codes.set(code, {
      challenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
      scopes: input.scopes ? input.scopes.split(" ").filter(Boolean) : [],
      // The form posts this field back unchecked. A value that isn't a URL
      // would be signed into the tokens and then throw in verifyAccessToken.
      resource: URL.canParse(input.resource) ? input.resource : undefined,
      expiresAt: now + CODE_TTL_MS,
    });

    const url = new URL(input.redirectUri);
    url.searchParams.set("code", code);
    if (input.state) url.searchParams.set("state", input.state);
    return url.toString();
  }

  checkPassword(password: string): boolean {
    // No password configured means the OAuth path is off, not that the empty
    // password is correct ("" equals "" under the comparison below). The HTTP
    // route also refuses, but the gate shouldn't rest on one caller's `if`.
    return this.password.length > 0 && constantTimeEqual(password, this.password);
  }

  // A bad grant must be the SDK's InvalidGrantError: the token endpoint maps it
  // to 400 `invalid_grant`, the client's cue to send the user back through
  // /authorize. A plain Error became 500 `server_error`, which reads as an
  // outage, so an expired 30-day refresh token (or a rotated MCP_AUTH_TOKEN)
  // left the connector failing instead of asking to reconnect.
  private liveCode(client: OAuthClientInformationFull, authorizationCode: string): AuthCodeEntry {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now() || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    return entry;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.liveCode(client, authorizationCode).challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.liveCode(client, authorizationCode);
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
      throw new InvalidGrantError("invalid or expired refresh token");
    }
    // RFC 6749 §6: a refresh may narrow the scope, never widen it. Taking the
    // requested list as given let any refresh mint a token claiming scopes the
    // user never approved.
    const granted = Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [];
    const requested = scopes?.filter(Boolean);
    if (requested?.some((scope) => !granted.includes(scope))) {
      throw new InvalidScopeError("requested scope exceeds the scope originally granted");
    }
    return this.issueTokens(client.client_id, requested ?? granted, payload.resource as string | undefined);
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
          console.error(`[totem] token resource mismatch (got "${payload.resource}", expected "${this.resourceUrl}") — allowing; enforcement is disabled`);
        }
      }
      const info: AuthInfo = {
        token,
        clientId: String(payload.cid),
        scopes: (payload.scopes as string[]) ?? [],
        expiresAt: payload.exp as number,
      };
      // canParse: a token must never fail verification with a TypeError (the
      // bearer middleware answers anything but InvalidTokenError with a 500).
      if (typeof payload.resource === "string" && URL.canParse(payload.resource)) info.resource = new URL(payload.resource);
      return info;
    }
    // Throw the SDK's typed error so the bearer middleware returns 401 (a
    // generic Error would be mapped to 500).
    throw new InvalidTokenError("invalid or expired access token");
  }
}

// ─── consent page ───────────────────────────────────────────────────────────
// The one page of totem a person sees in a browser: a client (claude.ai,
// ChatGPT, an editor) has asked to connect, and the server asks its owner for
// the connector password before it hands out access to their health data.
//
// It is a password form on a public URL, so it is built to be boring and safe:
// one self-contained document, no scripts, no images, no fonts, nothing loaded
// from anywhere. Every value it shows or posts back goes through esc().

// The page's only stylesheet. Kept as one constant because the
// Content-Security-Policy below allows exactly this text (by its hash) and no
// other style, inline or external.
const CONSENT_CSS = `
:root {
  color-scheme: light dark;
  --page: #f3f4f6; --card: #ffffff; --text: #14171c; --muted: #5a6370; --line: #d8dce2;
  --field: #ffffff; --button: #14171c; --button-text: #ffffff; --focus: #1d5fd6;
  --dest: #f1f5fd; --dest-line: #c3d2f3; --error: #b3261e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d1014; --card: #171b21; --text: #eceff3; --muted: #9ba5b2; --line: #2c333c;
    --field: #0f1317; --button: #eceff3; --button-text: #12161b; --focus: #8ab4ff;
    --dest: #141c2c; --dest-line: #2d3f66; --error: #ff8f85;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; min-height: 100dvh; padding: 24px 16px;
  display: flex; align-items: center; justify-content: center;
  background: var(--page); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.card {
  width: 100%; max-width: 400px; padding: 28px;
  background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .05), 0 12px 32px rgba(0, 0, 0, .07);
}
.brand { display: flex; align-items: center; gap: 8px; margin: 0 0 18px; color: var(--muted); font-size: 14px; font-weight: 600; letter-spacing: .02em; }
.brand svg { width: 22px; height: 22px; flex: none; }
h1 { margin: 0 0 16px; font-size: 21px; line-height: 1.3; font-weight: 650; letter-spacing: -.01em; }
.to { margin: 0 0 10px; padding: 12px 14px; background: var(--dest); border: 1px solid var(--dest-line); border-radius: 10px; }
.to span { display: block; margin: 0 0 2px; color: var(--muted); font-size: 13px; }
.dest { display: block; font: 600 17px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; overflow-wrap: anywhere; }
.only { margin: 0 0 22px; font-size: 15px; }
label { display: block; margin: 0 0 6px; font-size: 14px; font-weight: 600; }
input[type=password] {
  display: block; width: 100%; height: 46px; padding: 0 12px;
  font: inherit; color: inherit; background: var(--field);
  border: 1px solid var(--line); border-radius: 10px;
}
input[type=password][aria-invalid=true] { border-color: var(--error); }
input:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.error { margin: 8px 0 0; color: var(--error); font-size: 14px; font-weight: 600; }
.help { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
button {
  display: block; width: 100%; height: 46px; margin: 20px 0 0; padding: 0 16px;
  font: inherit; font-weight: 600; color: var(--button-text); background: var(--button);
  border: 1px solid transparent; border-radius: 10px; cursor: pointer;
}
button:hover { opacity: .9; }
button:active { opacity: .8; }
.foot { margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
@media (max-width: 420px) {
  body { padding: 12px; }
  .card { padding: 22px 18px; }
  h1 { font-size: 20px; }
}
@media (forced-colors: active) {
  .card, .to, input[type=password], button { border: 1px solid CanvasText; }
}
`;

const CONSENT_CSS_HASH = createHash("sha256").update(CONSENT_CSS).digest("base64");

/**
 * The consent page's Content-Security-Policy: nothing may load or run. No
 * scripts, images, fonts, frames or connections; the one stylesheet above, by
 * hash; no <base>; no framing.
 *
 * It deliberately has NO `form-action`: that directive also governs where the
 * form's response may redirect, and the whole point of this form is a 302 to
 * the client's own origin (claude.ai, a loopback port, an app's scheme). With
 * `form-action 'self'` the browser refuses that redirect and the password
 * submit silently goes nowhere. `default-src` does not stand in for
 * `form-action`, so leaving it out leaves the redirect alone.
 */
export const CONSENT_CSP = `default-src 'none'; style-src 'sha256-${CONSENT_CSS_HASH}'; base-uri 'none'; frame-ancestors 'none'`;

// Security headers for the HTML consent page (a password form) ONLY. A
// document CSP or X-Frame-Options on the JSON metadata and API responses made
// Claude's connector flag a "server configuration issue", so these are never
// set globally.
export function setConsentSecurityHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", CONSENT_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * Who receives the authorization code, for display on the consent page.
 *
 * Client registration is open to anyone, so a link to this server's own
 * /authorize can carry an attacker's client and redirect URI. The page used to
 * say "connect this server to Claude" whatever the redirect was: the owner saw
 * their own server asking for their password, and typing it sent the code (and
 * with it their health data) to the attacker's site. Name the destination.
 */
export function redirectDestination(redirectUri: string): string {
  if (!URL.canParse(redirectUri)) return "an unrecognised address";
  const { protocol, hostname, host } = new URL(redirectUri);
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return `an app on this device (${host})`;
  }
  // A non-https destination (http, or an app's custom scheme) shows its scheme.
  return protocol === "https:" ? host : `${protocol}//${host}`;
}

/**
 * The page: what is being asked, where access goes, the password, one button.
 *
 * Reading order is the security order. The destination comes before the
 * password field, set apart and in a monospace face (look-alike letters stay
 * distinguishable), with the line telling the owner to continue only if they
 * started this from there. On a wrong password the same page comes back with
 * the error next to the field and every hidden field intact, so trying again
 * is one keystroke away; the error is announced (role="alert") and tied to the
 * field (aria-invalid, aria-describedby).
 */
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
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const destination = esc(redirectDestination(d.redirectUri));
  const error = d.error ? `\n      <p class="error" id="pw-error" role="alert">Incorrect password. Try again.</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${d.error ? "Incorrect password" : "Allow access"} · totem</title>
<style>${CONSENT_CSS}</style>
</head>
<body>
  <main class="card">
    <p class="brand">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h4l2.5-7 4 14 3-9 1.5 2h5"/></svg>
      totem
    </p>
    <h1>Allow access to your WHOOP data?</h1>
    <p class="to"><span>Access goes to</span><strong class="dest">${destination}</strong></p>
    <p class="only">Continue only if you started this from there. If you didn't, close this page.</p>
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="client_id" value="${esc(d.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(d.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${esc(d.codeChallenge)}">
      <input type="hidden" name="state" value="${esc(d.state)}">
      <input type="hidden" name="scope" value="${esc(d.scopes)}">
      <input type="hidden" name="resource" value="${esc(d.resource)}">
      <input type="text" name="username" value="totem connector" autocomplete="username" readonly hidden>
      <label for="pw">Connector password</label>
      <input type="password" id="pw" name="password" required autofocus autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-describedby="${d.error ? "pw-error pw-help" : "pw-help"}"${d.error ? ' aria-invalid="true"' : ""}>${error}
      <p class="help" id="pw-help">The one <code>totem cloud</code> gave you when you set this server up.</p>
      <button type="submit">Allow access</button>
    </form>
    <p class="foot">This is your own totem server asking. It never sends the password anywhere else.</p>
  </main>
</body>
</html>`;
}
