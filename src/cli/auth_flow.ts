// The logic behind `totem auth`, kept free of printing and prompts so the CLI
// (src/cli/auth.ts) can present it however it likes.
//
//   1. Get tokens: browser login (browser_login.ts) or a pasted refresh token.
//   2. Validate them with one GET /users-service/v2/bootstrap carrying the app's
//      device headers.
//   3. Either save them to this machine's token file, or push them to a
//      deployment's POST /admin/tokens. A pushed login is never kept locally:
//      the deployment is its only owner (G8).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { BASE_URL, WEB_CLIENT_ID } from "../whoop/constants.js";
import { CognitoError, decodeJwtClientId, decodeJwtExp, refreshCognitoSession, type CognitoTokens } from "../whoop/cognito.js";
import { deviceHeaders } from "../whoop/device.js";
import {
  FileTokenStore, LEGACY_TOKEN_KEYS, isHandoff, resolveTokenFilePath,
  type TokenFileContent, type TokenRecord,
} from "../whoop/token_store.js";
import { TokenLock, type LockHolder } from "../whoop/token_lock.js";
import { deleteEnvKeys, readEnvFile } from "../lib/env_file.js";
import type { DeployRecord } from "./deploy_record.js";

export interface WhoopLogin {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  source: "browser" | "paste";
}

export type AuthTarget =
  | { kind: "local"; tokenFile: string }
  | { kind: "remote"; url: string; adminToken?: string | undefined; platform?: string | undefined };

type Env = Record<string, string | undefined>;

/** Settings for the CLI: the install's .env, overridden by the real environment (as dotenv does). */
export function cliEnv(envPath: string): Env {
  return { ...readEnvFile(envPath), ...process.env };
}

const cleanUrl = (u: string): string => u.trim().replace(/\/+$/, "");

/**
 * Where a new login goes: `--url` → that server; `--local` → this machine;
 * otherwise the recorded deployment if it has a URL, else this machine.
 */
export function resolveAuthTarget(
  record: DeployRecord | null,
  flags: { local?: boolean | undefined; url?: string | undefined },
  env: Env,
): AuthTarget {
  if (flags.url) return { kind: "remote", url: cleanUrl(flags.url), adminToken: record?.url && cleanUrl(record.url) === cleanUrl(flags.url) ? record.mcp_auth_token : undefined };
  if (!flags.local && record && record.platform !== "local" && record.url) {
    return { kind: "remote", url: cleanUrl(record.url), adminToken: record.mcp_auth_token, platform: record.platform };
  }
  return { kind: "local", tokenFile: resolveTokenFilePath(env) };
}

/** Turn browser-captured cookies into a login. */
export function loginFromCookies(tokens: { accessToken: string; refreshToken: string; clientId: string | null }): WhoopLogin {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    clientId: tokens.clientId === WEB_CLIENT_ID || tokens.clientId === null ? WEB_CLIENT_ID : tokens.clientId,
    source: "browser",
  };
}

/**
 * Exchange a pasted refresh token for a fresh access token (and its rotated
 * refresh token). Tries WHOOP's web client first, then the legacy iOS client ("")
 * when the web client refuses it and no client id was given.
 */
export async function loginWithRefreshToken(
  refreshToken: string,
  opts: { clientId?: string | undefined; refresh?: (rt: string, clientId: string) => Promise<CognitoTokens> } = {},
): Promise<WhoopLogin> {
  const refresh = opts.refresh ?? refreshCognitoSession;
  const token = refreshToken.trim();
  const clients = opts.clientId !== undefined ? [opts.clientId] : [WEB_CLIENT_ID, ""];
  let lastError: unknown;
  for (const clientId of clients) {
    try {
      const next = await refresh(token, clientId);
      return { accessToken: next.accessToken, refreshToken: next.refreshToken || token, clientId, source: "paste" };
    } catch (error) {
      lastError = error;
      if (!(error instanceof CognitoError && error.isAuthFailure)) break; // outage: don't try the other client
    }
  }
  throw lastError;
}

export interface Validation {
  /** true: WHOOP accepted the token; false: it refused it (401/403); null: couldn't tell. */
  accepted: boolean | null;
  userId: number | null;
  status: number | null;
  detail?: string | undefined;
}

/** One GET /users-service/v2/bootstrap with the app's device headers. */
export async function validateLogin(
  accessToken: string,
  opts: { installationId: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<Validation> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const response = await doFetch(`${BASE_URL}/users-service/v2/bootstrap`, {
      headers: {
        ...deviceHeaders(),
        "x-whoop-installation-identifier": opts.installationId,
        authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { accepted: false, userId: null, status: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { accepted: null, userId: null, status: response.status };
    }
    const body = (await response.json().catch(() => null)) as { user?: { id?: unknown } } | null;
    const id = body?.user?.id;
    return { accepted: true, userId: typeof id === "number" && Number.isInteger(id) ? id : null, status: response.status };
  } catch (error) {
    return { accepted: null, userId: null, status: null, detail: (error as Error).message };
  }
}

/** The device id to validate with: the token file's, else the install's, else a new one. */
export function pickInstallationId(existing: TokenFileContent | null, env: Env): string {
  return existing?.installation_id || env.WHOOP_INSTALLATION_ID || randomUUID().toUpperCase();
}

/** Read a token file without throwing (null when absent or unreadable). */
export function readTokenFile(path: string): TokenFileContent | null {
  try {
    return new FileTokenStore(path).load();
  } catch {
    return null;
  }
}

/** Save a login to this machine's token file. A running local server adopts it on its next call. */
export function saveLocalLogin(
  tokenFile: string,
  login: WhoopLogin,
  extras: { userId: number | null; installationId: string; now?: () => number },
): TokenRecord {
  const record: TokenRecord = {
    access_token: login.accessToken,
    refresh_token: login.refreshToken,
    client_id: login.clientId,
    source: login.source,
    saved_at: new Date((extras.now ?? Date.now)()).toISOString(),
    user_id: extras.userId ?? undefined,
    installation_id: extras.installationId,
  };
  new FileTokenStore(tokenFile).save(record);
  return record;
}

/** Remove v1's token and password keys from the install's .env. Returns the keys removed. */
export function retireLegacyEnv(envPath: string): string[] {
  if (!existsSync(envPath)) return [];
  const keys = [...LEGACY_TOKEN_KEYS, "WHOOP_PASSWORD"];
  const present = keys.filter((k) => readEnvFile(envPath)[k] !== undefined);
  if (present.length) deleteEnvKeys(envPath, present);
  return present;
}

/**
 * After a push, make sure no local copy keeps refreshing the same login. The
 * local file is replaced by a hand-off marker when it is absent, already a
 * marker, or holds v1's migrated tokens (which v1 also pushed to the host). A
 * separate local login (`totem auth --local`) is left alone: it's a different
 * session and doesn't conflict.
 */
export function markHandedOff(
  tokenFile: string,
  url: string,
  extras: { userId: number | null; installationId: string; now?: () => number },
): { marked: boolean; keptLocalLogin: boolean } {
  const existing = readTokenFile(tokenFile);
  if (existing && !isHandoff(existing) && existing.source !== "env-migration") return { marked: false, keptLocalLogin: true };
  new FileTokenStore(tokenFile).save({
    handed_off_to: url,
    saved_at: new Date((extras.now ?? Date.now)()).toISOString(),
    user_id: extras.userId ?? undefined,
    installation_id: existing?.installation_id ?? extras.installationId,
  });
  return { marked: true, keptLocalLogin: false };
}

export type PushResult =
  | { ok: true; status: RemoteStatus }
  | {
      ok: false;
      reason: "unauthorized" | "not-found" | "unreachable" | "rejected" | "server-error" | "insecure" | "redirected";
      httpStatus: number | null;
      detail: string;
    };

/** This machine: plain http to it never crosses a network. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Whether a login may be pushed to `url`. The push carries the WHOOP session
 * and the server's MCP_AUTH_TOKEN, so it goes over https, or over plain http
 * only to this machine. `allowHttp` (`totem auth --allow-http`) is the opt-in
 * for a private network that encrypts by other means (a VPN, a tailnet).
 */
export function checkPushUrl(
  url: string,
  opts: { allowHttp?: boolean | undefined } = {},
): { ok: true; url: string } | { ok: false; reason: string } {
  const cleaned = cleanUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return { ok: false, reason: `'${cleaned}' isn't a URL (expected https://…).` };
  }
  if (parsed.protocol === "https:") return { ok: true, url: cleaned };
  if (parsed.protocol !== "http:") return { ok: false, reason: `'${cleaned}' isn't an https:// URL.` };
  if (isLoopbackHost(parsed.hostname) || opts.allowHttp) return { ok: true, url: cleaned };
  return {
    ok: false,
    reason:
      `${cleaned} is plain http: the WHOOP login and the server's MCP_AUTH_TOKEN would cross the network unencrypted. ` +
      "Use its https:// address, or add --allow-http for a private network you trust.",
  };
}

export interface RemoteStatus {
  state?: string;
  role?: string;
  store?: string;
  source?: string;
  access_expires_at?: string | null;
  refreshed_at?: string;
  next_keepalive_at?: string;
  durable?: boolean | null;
  detail?: string;
}

async function adminCall(
  method: "GET" | "POST",
  url: string,
  adminToken: string,
  body: unknown,
  opts: { fetch?: typeof fetch | undefined; allowHttp?: boolean | undefined },
): Promise<PushResult> {
  const target = checkPushUrl(url, opts);
  if (!target.ok) return { ok: false, reason: "insecure", httpStatus: null, detail: target.reason };
  const doFetch = opts.fetch ?? fetch;
  let response: Response;
  try {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${adminToken}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      // Never follow a redirect: a 307/308 would re-send the body (the WHOOP
      // tokens) to wherever it points, https or not.
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    };
    if (body) init.body = JSON.stringify(body);
    response = await doFetch(`${target.url}/admin/tokens`, init);
  } catch (error) {
    return { ok: false, reason: "unreachable", httpStatus: null, detail: (error as Error).message };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    const to = response.headers.get("location") ?? "another address";
    return { ok: false, reason: "redirected", httpStatus: response.status, detail: `it redirects to ${to}` };
  }
  const text = await response.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  if (response.ok) return { ok: true, status: json as RemoteStatus };
  const detail = typeof json.error_description === "string" ? json.error_description : text.slice(0, 200);
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized", httpStatus: response.status, detail };
  if (response.status === 404 || response.status === 405) return { ok: false, reason: "not-found", httpStatus: response.status, detail };
  if (response.status >= 500) return { ok: false, reason: "server-error", httpStatus: response.status, detail };
  return { ok: false, reason: "rejected", httpStatus: response.status, detail };
}

/** Push a login to a deployment's POST /admin/tokens. */
export function pushLogin(
  url: string,
  adminToken: string,
  login: WhoopLogin,
  extras: { userId: number | null },
  opts: { fetch?: typeof fetch | undefined; allowHttp?: boolean | undefined } = {},
): Promise<PushResult> {
  return adminCall("POST", url, adminToken, {
    access_token: login.accessToken,
    refresh_token: login.refreshToken,
    client_id: login.clientId,
    source: login.source,
    ...(extras.userId ? { user_id: extras.userId } : {}),
  }, opts);
}

/** GET /admin/tokens on a deployment. */
export function fetchRemoteStatus(
  url: string,
  adminToken: string,
  opts: { fetch?: typeof fetch | undefined; allowHttp?: boolean | undefined } = {},
): Promise<PushResult> {
  return adminCall("GET", url, adminToken, undefined, opts);
}

export interface LocalStatus {
  tokenFile: string;
  state: "none" | "unreadable" | "tokens" | "handed-off";
  source?: string | undefined;
  clientId?: string | undefined;
  savedAt?: string | undefined;
  refreshedAt?: string | undefined;
  accessExpiresAt?: string | undefined;
  handedOffTo?: string | undefined;
  /** The process that owns (refreshes) this login, from the lock file. */
  owner?: LockHolder | null | undefined;
}

/** What this machine's token file holds, and who owns it. */
export function readLocalStatus(tokenFile: string): LocalStatus {
  if (!existsSync(tokenFile)) return { tokenFile, state: "none" };
  let content: TokenFileContent | null;
  try {
    content = new FileTokenStore(tokenFile).load();
  } catch {
    return { tokenFile, state: "unreadable" };
  }
  if (!content) return { tokenFile, state: "none" };
  if (isHandoff(content)) return { tokenFile, state: "handed-off", handedOffTo: content.handed_off_to, savedAt: content.saved_at };
  const exp = decodeJwtExp(content.access_token) * 1000;
  return {
    tokenFile,
    state: "tokens",
    source: content.source,
    clientId: content.client_id || decodeJwtClientId(content.access_token) || "",
    savedAt: content.saved_at,
    refreshedAt: content.refreshed_at,
    accessExpiresAt: exp ? new Date(exp).toISOString() : undefined,
    owner: new TokenLock({ path: `${tokenFile}.lock` }).readHolder(),
  };
}
