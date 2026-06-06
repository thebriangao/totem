// HTTP transport entry point. Boots an MCP server over Streamable HTTP behind
// auth, on Express so we can mount the MCP SDK's OAuth 2.1 authorization-server
// endpoints (required for claude.ai web + the Claude mobile app, whose custom
// connectors only support OAuth — no bearer-header field).
//
// Two auth paths, both accepted on /mcp:
//   1. Static bearer (MCP_AUTH_TOKEN) — for Claude Code (--header) and the
//      Claude Desktop mcp-remote bridge. Unchanged from before.
//   2. OAuth 2.1 + PKCE — for claude.ai web / mobile custom connectors. The
//      /authorize step is gated by AUTH_PASSWORD. See whoop/oauth_provider.ts.
//
// Env:
//   MCP_TRANSPORT=http        (required to select this transport)
//   MCP_AUTH_TOKEN=<≥16 char> (required; also the JWT signing secret)
//   AUTH_PASSWORD=<password>  (optional; enables the OAuth/web-connector path)
//   PUBLIC_URL=https://...    (optional; the server's public origin, used as the
//                              OAuth issuer. Defaults to http://localhost:<port>)
import express, { type Request, type Response } from "express";
import { randomUUID, createHmac } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { WhoopClient } from "./whoop/client.js";
import { registerTools } from "./tools/register.js";
import { WhoopOAuthProvider, renderConsentForm, setConsentSecurityHeaders } from "./whoop/oauth_provider.js";

export interface HttpServerOptions {
  /** Bearer token clients must present + JWT signing secret. Required, ≥16 chars. */
  authToken: string;
  port?: number;
  host?: string;
}

export async function startHttpServer(client: WhoopClient, opts: HttpServerOptions): Promise<void> {
  if (!opts.authToken || opts.authToken.length < 16) {
    throw new Error(
      "MCP_AUTH_TOKEN must be set and at least 16 chars. Generate one with `openssl rand -hex 32`.",
    );
  }
  const port = opts.port ?? Number(process.env.PORT ?? process.env.MCP_HTTP_PORT ?? 3000);
  const host = opts.host ?? "0.0.0.0";
  const password = process.env.AUTH_PASSWORD ?? "";
  // `||` not `??`: an empty PUBLIC_URL (e.g. a host that injects "" for an unset
  // var, or the first-pass deploy on Railway/Cloud Run before the real URL
  // is known) must fall back to localhost, not become `new URL("")` → boot crash.
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
  const oauthEnabled = password.length > 0;
  const resourceUrl = `${publicUrl.replace(/\/$/, "")}/mcp`;
  // Sign OAuth JWTs with a key DERIVED from MCP_AUTH_TOKEN, not the token itself
  // — so the long-lived static bearer and the JWT signing secret aren't the same
  // string in two roles (leaking one shouldn't let you forge the other).
  const signingSecret = createHmac("sha256", opts.authToken)
    .update("totem/oauth-jwt-signing/v1")
    .digest("hex");

  const provider = new WhoopOAuthProvider({
    signingSecret,
    password,
    staticToken: opts.authToken,
    resourceUrl,
  });

  // One McpServer + transport pair per active session (MCP spec: a server can't
  // be re-initialized once initialize() runs). Routed by mcp-session-id header.
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  async function getOrCreateSession(
    existingSessionId: string | undefined,
  ): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> {
    if (existingSessionId) {
      const existing = sessions.get(existingSessionId);
      if (existing) return existing;
    }
    const newId = randomUUID();
    const newServer = new McpServer({ name: "totem", version: "1.4.0" });
    registerTools(newServer, client);
    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newId,
      enableJsonResponse: true,
    });
    newTransport.onclose = (): void => {
      sessions.delete(newId);
    };
    await newServer.connect(newTransport as Parameters<typeof newServer.connect>[0]);
    const entry = { server: newServer, transport: newTransport };
    sessions.set(newId, entry);
    return entry;
  }

  const app = express();
  app.disable("x-powered-by");
  // Behind Fly's reverse proxy the client IP is in X-Forwarded-For. Trust
  // exactly ONE hop (Fly's edge proxy) so express-rate-limit (used by the SDK's
  // OAuth endpoints) can identify clients. `true` (trust all) is rejected by
  // express-rate-limit as too permissive — clients could spoof X-Forwarded-For
  // — so we use the hop count instead.
  app.set("trust proxy", 1);

  // NOTE: anti-clickjacking headers (X-Frame-Options / CSP) are set ONLY on the
  // HTML consent page (see setConsentSecurityHeaders), NOT globally. Putting
  // document-level CSP + X-Frame-Options on the JSON metadata and /mcp API
  // responses makes Claude's connector reject the server with a "configuration
  // issue" at add-time — those headers protect HTML documents from clickjacking,
  // and have no meaning on a machine-consumed JSON API.

  // CORS — a browser-based MCP client (or the OAuth redirect dance) may hit this.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, www-authenticate");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health probe — no auth. Container hosts (Fly/Docker HEALTHCHECK) hit this.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // OAuth 2.1 authorization-server endpoints: /.well-known/oauth-authorization-server,
  // /.well-known/oauth-protected-resource/mcp, /authorize, /token, /register, /revoke.
  //
  // resourceServerUrl MUST be the actual MCP endpoint (…/mcp), not the root.
  // Claude's connector validates that the protected-resource metadata's
  // `resource` matches the URL it's connecting to. If we let it default to the
  // issuer (root), Claude sees resource=https://host/ ≠ https://host/mcp and
  // refuses to connect. Setting it to /mcp also serves the metadata at the
  // RFC 9728 path-specific location /.well-known/oauth-protected-resource/mcp.
  const issuerUrl = new URL(publicUrl);
  const resourceServerUrl = new URL(resourceUrl);
  app.use(mcpAuthRouter({ provider, issuerUrl, resourceServerUrl }));

  // Brute-force guard for the password gate: this consent route is custom and
  // is NOT covered by the SDK's OAuth rate-limiter. Per-IP fixed window
  // (trust proxy=1 gives us the real client IP via req.ip).
  const consentHits = new Map<string, { count: number; resetAt: number }>();
  const CONSENT_MAX = 10;
  const CONSENT_WINDOW_MS = 15 * 60 * 1000;
  // Global failed-password ceiling — a backstop that does NOT depend on the
  // spoofable per-IP key (X-Forwarded-For). Counts wrong passwords across ALL
  // IPs and trips a site-wide cooldown, so a distributed / IP-rotating guesser
  // can't dilute the per-IP limiter.
  let globalFails = 0;
  let globalResetAt = 0;
  const GLOBAL_FAIL_MAX = 50;

  // Password-gate handler for the /authorize step. The form rendered by
  // provider.authorize() POSTs here; we validate the password, mint an auth
  // code, and redirect back to the client.
  app.post("/oauth/consent", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    if (!oauthEnabled) {
      res.status(403).json({ error: "oauth_disabled", error_description: "AUTH_PASSWORD is not set on this server." });
      return;
    }
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    // Global cooldown (IP-independent) — trips before the per-IP check.
    if (now > globalResetAt) { globalFails = 0; globalResetAt = now + CONSENT_WINDOW_MS; }
    if (globalFails >= GLOBAL_FAIL_MAX) {
      res.status(429).json({ error: "too_many_requests", error_description: "Too many failed attempts — wait 15 minutes." });
      return;
    }
    const hit = consentHits.get(ip);
    if (!hit || now > hit.resetAt) {
      consentHits.set(ip, { count: 1, resetAt: now + CONSENT_WINDOW_MS });
    } else if (++hit.count > CONSENT_MAX) {
      res.status(429).json({ error: "too_many_requests", error_description: "Too many attempts — wait 15 minutes." });
      return;
    }
    const body = req.body as Record<string, string>;
    const redirect = provider.consent({
      clientId: body.client_id ?? "",
      redirectUri: body.redirect_uri ?? "",
      codeChallenge: body.code_challenge ?? "",
      state: body.state ?? "",
      scopes: body.scope ?? "",
      resource: body.resource ?? "",
      password: body.password ?? "",
    });
    if (!redirect) {
      // Wrong password (or bad client) — count it toward the global ceiling and
      // re-render the form with an error.
      globalFails++;
      setConsentSecurityHeaders(res);
      res.status(401).setHeader("content-type", "text/html; charset=utf-8");
      res.end(renderConsentForm({
        clientId: body.client_id ?? "",
        redirectUri: body.redirect_uri ?? "",
        codeChallenge: body.code_challenge ?? "",
        state: body.state ?? "",
        scopes: body.scope ?? "",
        resource: body.resource ?? "",
        error: true,
      }));
      return;
    }
    res.redirect(302, redirect);
  });

  // MCP endpoint — gated by OAuth token OR static bearer (provider.verifyAccessToken
  // accepts both). 401s carry a WWW-Authenticate pointing at the resource metadata
  // so OAuth clients can discover the authorization server.
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${publicUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp`,
  });

  const mcpHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sid = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
      const session = await getOrCreateSession(sid);
      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[totem] request error:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal server error" });
    }
  };

  app.post("/mcp", bearer, express.json(), (req, res) => void mcpHandler(req, res));
  app.get("/mcp", bearer, (req, res) => void mcpHandler(req, res));
  app.delete("/mcp", bearer, (req, res) => void mcpHandler(req, res));

  const httpServer = app.listen(port, host, () => {
    console.error(`[totem] listening on ${publicUrl} (bound ${host}:${port})`);
    console.error(`[totem] health: GET /health`);
    console.error(`[totem] auth: static bearer (MCP_AUTH_TOKEN)${oauthEnabled ? " + OAuth (web/mobile connectors)" : " — OAuth disabled (set AUTH_PASSWORD to enable)"}`);
  });

  const close = (): void => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
