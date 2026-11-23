// Admin endpoint for pushing a WHOOP login to a deployed server.
//
//   POST /admin/tokens   { access_token, refresh_token, client_id?, source?, user_id? }
//   GET  /admin/tokens   → login status (no token values)
//
// `totem auth` logs in through a browser on your own machine, then pushes the
// tokens here. The server writes them to its token file atomically (the Fly or
// Railway volume) and switches to them at once: no redeploy, no tokens in host
// secrets, and the deployment becomes the login's only owner.
//
// Gated by the static MCP_AUTH_TOKEN only. OAuth access tokens issued to
// claude.ai can call tools but can't replace the login.
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeJwtExp } from "./whoop/cognito.js";
import { inferClientId, onMountedVolume, inContainer, type TokenRecord, type TokenSource } from "./whoop/token_store.js";
import type { TokenManager } from "./whoop/token_manager.js";

export interface AdminTokensOptions {
  /** The static MCP_AUTH_TOKEN. */
  authToken: string;
  tokens: Pick<TokenManager, "adopt" | "status" | "current">;
  /** This server's installation id, recorded with a pushed login that lacks one. */
  installationId?: (() => string | undefined) | undefined;
  now?: (() => number) | undefined;
}

const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 20;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Shortest MCP_AUTH_TOKEN the endpoint will run behind (the HTTP server enforces the same). */
const MIN_AUTH_TOKEN_LENGTH = 16;

/** Constant-time check of `authorization: Bearer <token>` against the static token. */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!expected) return false; // an unset token must never match (`Bearer <NBSP>` trims to "")
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const presented = m[1]!.trim();
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export type PushBody = {
  access_token: string;
  refresh_token: string;
  client_id?: string | undefined;
  source?: string | undefined;
  user_id?: number | undefined;
};

/** Validate a push body. Returns an error message, or the parsed body. */
export function parsePushBody(body: unknown): PushBody | string {
  if (!body || typeof body !== "object") return "expected a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.access_token !== "string" || !JWT.test(b.access_token)) return "access_token must be a JWT";
  if (typeof b.refresh_token !== "string" || b.refresh_token.length < 20 || b.refresh_token.length > 16_384) {
    return "refresh_token is missing or malformed";
  }
  if (b.client_id !== undefined && typeof b.client_id !== "string") return "client_id must be a string";
  if (b.source !== undefined && typeof b.source !== "string") return "source must be a string";
  if (b.user_id !== undefined && !(typeof b.user_id === "number" && Number.isInteger(b.user_id) && b.user_id > 0)) {
    return "user_id must be a positive integer";
  }
  return {
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    client_id: b.client_id as string | undefined,
    source: b.source as string | undefined,
    user_id: b.user_id as number | undefined,
  };
}

/** Mount /admin/tokens on an Express app. */
export function mountAdminTokens(app: Express, opts: AdminTokensOptions): void {
  // This token is all that stands between the internet and the WHOOP login.
  // Without a real one the endpoint must not exist at all.
  if (typeof opts.authToken !== "string" || opts.authToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`/admin/tokens needs an MCP_AUTH_TOKEN of at least ${MIN_AUTH_TOKEN_LENGTH} characters.`);
  }
  const now = opts.now ?? Date.now;
  // Failed-auth ceiling across all clients: a guesser can't dilute it by
  // rotating IPs (X-Forwarded-For is spoofable).
  let fails = 0;
  let windowEnds = 0;

  const gate = (req: Request, res: Response): boolean => {
    const t = now();
    if (t > windowEnds) { fails = 0; windowEnds = t + FAIL_WINDOW_MS; }
    if (fails >= FAIL_MAX) {
      res.status(429).json({ error: "too_many_requests", error_description: "Too many failed attempts; wait 15 minutes." });
      return false;
    }
    if (!bearerMatches(req.headers.authorization, opts.authToken)) {
      fails++;
      res.status(401).json({ error: "unauthorized", error_description: "Send the deployment's MCP_AUTH_TOKEN as a bearer token." });
      return false;
    }
    return true;
  };

  const statusBody = (): Record<string, unknown> => {
    const status = opts.tokens.status();
    const durable = inContainer() && status.store.startsWith("/") ? onMountedVolume(status.store) : null;
    return { ...status, durable };
  };

  // The token is checked before anything else: an unauthenticated caller never
  // gets a body read or parsed.
  const requireToken = (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("cache-control", "no-store");
    if (gate(req, res)) next();
  };

  app.get("/admin/tokens", requireToken, (_req, res) => {
    res.json(statusBody());
  });

  app.post("/admin/tokens", requireToken, express.json({ limit: "32kb" }), (req, res) => {
    const parsed = parsePushBody(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: "invalid_request", error_description: parsed });
      return;
    }
    const previous = opts.tokens.current();
    const source: TokenSource = parsed.source === "browser" || parsed.source === "paste" ? parsed.source : "push";
    const record: TokenRecord = {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      client_id: parsed.client_id ?? inferClientId(parsed.access_token),
      source,
      saved_at: new Date(now()).toISOString(),
      user_id: parsed.user_id,
      // Keep this server's device identity stable across logins.
      installation_id: previous?.installation_id ?? opts.installationId?.(),
    };
    try {
      opts.tokens.adopt(record);
    } catch (error) {
      res.status(500).json({ error: "write_failed", error_description: `Couldn't save the login: ${(error as Error).message}` });
      return;
    }
    const exp = decodeJwtExp(record.access_token) * 1000;
    res.json({ ok: true, access_expires_at: exp ? new Date(exp).toISOString() : null, ...statusBody() });
  });

  // A body that fails to parse (or is too large) must not reach Express's
  // default error handler: it logs the error object, and body-parser attaches
  // the raw body to it, which here holds the WHOOP tokens. Answer in JSON and
  // log nothing.
  app.use("/admin/tokens", (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (res.headersSent) {
      res.end(); // nothing more to say, and the error must not be passed on to be logged
      return;
    }
    const e = err as { status?: unknown; statusCode?: unknown; type?: unknown };
    const status = typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : 500;
    if (status === 413) {
      res.status(413).json({ error: "invalid_request", error_description: "The body is too large (32 KB at most)." });
    } else if (status >= 400 && status < 500) {
      res.status(status).json({ error: "invalid_request", error_description: "The body isn't valid JSON." });
    } else {
      res.status(500).json({ error: "server_error", error_description: "The request failed." });
    }
  });
}
