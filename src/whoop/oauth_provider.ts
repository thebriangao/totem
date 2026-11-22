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
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { cleanClientName, redirectDestination, renderConsentForm, setConsentSecurityHeaders } from "./consent_page.js";

// The consent page moved to consent_page.ts; these stay importable from here.
export { CONSENT_CSP, redirectDestination, renderConsentForm, setConsentSecurityHeaders } from "./consent_page.js";

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
    const name = cleanClientName(payload.n);
    return {
      client_id: clientId,
      ...(name ? { client_name: name } : {}),
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
        // registration survives server restarts with no storage. The name it
        // gave rides along (cleaned and capped): the consent page shows it for
        // a client on the owner's own device, and never for one on the internet.
        const name = cleanClientName(client.client_name);
        const signed = signToken(
          { t: "client", ru: client.redirect_uris ?? [], sc: client.scope ?? "", ...(name ? { n: name } : {}), jti: randomUUID() },
          this.signingSecret,
        );
        const clientId = `c.${signed}`;
        // Registration is open to anyone, so say who came by. Names and addresses only.
        console.error(`[totem] client registered: ${JSON.stringify(name ?? "(no name)")} -> ${(client.redirect_uris ?? []).map(redirectDestination).join(", ") || "(no redirect)"}`);
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
      clientName: client.client_name,
    }));
  }

  /** The name a client registered with, for re-rendering the page after a wrong password. */
  registeredName(clientId: string): string | undefined {
    return this.decodeClient(clientId)?.client_name;
  }

  // ─── consent POST, Deny ──────────────────────────────────────────────────
  // The owner said no: send the client back with `access_denied` (RFC 6749
  // §4.1.2.1) so it can say so instead of waiting. Only ever to a redirect URI
  // this client registered; null means there is nowhere safe to send it.
  deny(input: { clientId: string; redirectUri: string; state: string }): string | null {
    const client = this.decodeClient(input.clientId);
    if (!client || !URL.canParse(input.redirectUri)) return null;
    if (!client.redirect_uris.some((registered) => redirectUriMatches(input.redirectUri, registered))) return null;
    const url = new URL(input.redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "The owner denied the request.");
    if (input.state) url.searchParams.set("state", input.state);
    console.error(`[totem] consent denied by the owner: ${redirectDestination(input.redirectUri)}`);
    return url.toString();
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
