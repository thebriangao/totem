// The durable token file (SPEC G6).
//
// WHOOP rotates the refresh token on every refresh, and the old one dies, so the
// newest refresh token must reach disk before anything uses the new access token.
// A server that kept it only in memory would strand the login on its next
// restart. The file is JSON, written atomically (temp file + fsync + rename) with
// mode 0600:
//
//   { "version": 1, "access_token": "…", "refresh_token": "…",
//     "client_id": "37365lrcda1js3fapqfe2n40eh", "source": "browser",
//     "saved_at": "…", "refreshed_at": "…", "user_id": 123, "installation_id": "…" }
//
// After `totem auth` hands a login to a deployment, the local file holds only a
// marker ({ "version": 1, "handed_off_to": "https://…", … }) so no local copy
// keeps refreshing it (G8).
//
// Location: TOTEM_TOKEN_FILE, else ~/.config/totem/tokens.json (%APPDATA% on
// Windows). The Docker image sets TOTEM_TOKEN_FILE=/data/tokens.json, a mounted
// volume on Fly and Railway.

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeSync, accessSync, constants as fsConstants,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { decodeJwtClientId } from "./cognito.js";
import { WEB_CLIENT_ID } from "./constants.js";

export const TOKEN_FILE_VERSION = 1;

/** How the login reached this file. */
export type TokenSource = "browser" | "paste" | "env-migration" | "push";

export interface TokenRecord {
  access_token: string;
  refresh_token: string;
  /** Cognito client that issued the refresh token: WEB_CLIENT_ID for browser logins, "" for legacy iOS tokens. */
  client_id: string;
  source: TokenSource;
  /** When this login was created (`totem auth`, a push, or the env migration). Rotation keeps it. */
  saved_at: string;
  /** Last successful refresh. */
  refreshed_at?: string | undefined;
  user_id?: number | undefined;
  installation_id?: string | undefined;
}

/** Left behind after `totem auth` pushed a login to a deployment: this copy must not refresh. */
export interface HandoffRecord {
  handed_off_to: string;
  saved_at: string;
  user_id?: number | undefined;
  installation_id?: string | undefined;
}

export type TokenFileContent = TokenRecord | HandoffRecord;

export function isHandoff(content: TokenFileContent): content is HandoffRecord {
  return typeof (content as HandoffRecord).handed_off_to === "string";
}

export interface TokenStore {
  /** Human-readable location for logs and errors ("/data/tokens.json", "memory"). */
  readonly description: string;
  /** File path, or null for the memory store. */
  readonly path: string | null;
  /** The saved content, or null when nothing is saved. Throws on an unreadable file. */
  load(): TokenFileContent | null;
  /** Persist atomically. Throws when the write fails. */
  save(content: TokenFileContent): void;
  /** Changes whenever the stored content changes (another writer included). */
  version(): string | null;
}

/** Parse and validate the token file's JSON. */
export function parseTokenFile(text: string): TokenFileContent {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("not a JSON object");
  const str = (k: string): string | undefined => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof raw[k] === "number" ? (raw[k] as number) : undefined);
  const savedAt = str("saved_at") ?? new Date(0).toISOString();
  const handedOff = str("handed_off_to");
  if (handedOff) {
    return { handed_off_to: handedOff, saved_at: savedAt, user_id: num("user_id"), installation_id: str("installation_id") };
  }
  const access = str("access_token");
  const refresh = str("refresh_token");
  if (!access || !refresh) throw new Error("missing access_token or refresh_token");
  const source = str("source");
  return {
    access_token: access,
    refresh_token: refresh,
    client_id: str("client_id") ?? inferClientId(access),
    source: source === "browser" || source === "paste" || source === "env-migration" || source === "push" ? source : "paste",
    saved_at: savedAt,
    refreshed_at: str("refreshed_at"),
    user_id: num("user_id"),
    installation_id: str("installation_id"),
  };
}

export function serializeTokenFile(content: TokenFileContent): string {
  // Drop undefined fields so the file stays tidy; version first for humans.
  const body = Object.fromEntries(Object.entries(content).filter(([, v]) => v !== undefined));
  return JSON.stringify({ version: TOKEN_FILE_VERSION, ...body }, null, 2) + "\n";
}

/**
 * The client id to refresh with when none was recorded: browser-login tokens
 * carry the web client's id; legacy iOS password-flow tokens refresh with "".
 */
export function inferClientId(accessToken: string): string {
  return decodeJwtClientId(accessToken) === WEB_CLIENT_ID ? WEB_CLIENT_ID : "";
}

/**
 * Write `content` to `path` atomically: a sibling temp file opened O_EXCL with
 * mode 0600, fsync'd, then renamed over the target. Readers see the old file or
 * the new one, never a torn write. Throws on any failure (and removes the temp).
 *
 * `durable: false` skips the fsyncs (the write is still atomic). For content
 * that needn't survive a power cut, like the lock's heartbeat: two fsyncs take
 * milliseconds, and the lock is rewritten inside a critical section.
 */
export function writeFileAtomic(path: string, content: string, mode = 0o600, durable = true): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.${process.pid}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", mode);
    writeSync(fd, content);
    if (durable) fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmp, mode); // umask can only remove bits; make it exact
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already failing */ }
    }
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw error;
  }
  if (!durable) return;
  // Make the rename itself durable. Not possible on Windows (can't open a dir).
  try {
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* best-effort */ }
}

/** writeFileAtomic's temp files: `.<12 hex>.<pid>.tmp`. */
const TEMP_FILE = /^\.[0-9a-f]{12}\.\d+\.tmp$/;
const STALE_TEMP_MS = 60_000;

/**
 * Remove temp files an interrupted writeFileAtomic left in `dir`: a process
 * killed between the write and the rename leaves one behind, holding a full
 * copy of what it was writing (the tokens). Only ones older than a minute; a
 * younger one may be another process's write in progress. Best-effort.
 */
export function sweepStaleTemps(dir: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_TEMP_MS) rmSync(path, { force: true });
    } catch { /* its owner finished or removed it */ }
  }
}

export class FileTokenStore implements TokenStore {
  readonly path: string;
  readonly description: string;

  constructor(path: string) {
    this.path = resolve(path);
    this.description = this.path;
  }

  load(): TokenFileContent | null {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    this.tighten();
    try {
      return parseTokenFile(text);
    } catch (error) {
      // Never pass on JSON.parse's own message: it quotes the text around the
      // error, and in this file that text is the tokens.
      const why = error instanceof SyntaxError ? "it isn't valid JSON" : (error as Error).message;
      throw new Error(`token file ${this.path} is unreadable (${why}); run \`totem auth\` to replace it`);
    }
  }

  save(content: TokenFileContent): void {
    writeFileAtomic(this.path, serializeTokenFile(content));
    sweepStaleTemps(dirname(this.path));
  }

  /**
   * A token file must be private. One that isn't (restored from a backup,
   * copied by hand) is tightened to 0600 when it is read, not only when the
   * next refresh replaces it.
   */
  private tighten(): void {
    if (process.platform === "win32") return;
    try {
      if (statSync(this.path).mode & 0o077) chmodSync(this.path, 0o600);
    } catch { /* not ours to change; the next save replaces it with a 0600 file */ }
  }

  version(): string | null {
    try {
      const st = statSync(this.path);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /**
   * Fail fast at boot if the token file can't be written, instead of at the
   * first refresh (when the old refresh token is already spent).
   */
  assertWritable(): void {
    const dir = dirname(this.path);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      accessSync(dir, fsConstants.W_OK);
      if (existsSync(this.path)) accessSync(this.path, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      throw new Error(
        `can't write the WHOOP token file ${this.path} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}). ` +
          "Point TOTEM_TOKEN_FILE at a writable location (a mounted volume in a container).",
      );
    }
  }
}

/** Keeps tokens in memory only. Local tests and throwaway runs; refused in containers. */
export class MemoryTokenStore implements TokenStore {
  readonly path = null;
  readonly description = "memory";
  private content: TokenFileContent | null;
  private generation = 0;

  constructor(initial: TokenFileContent | null = null) {
    this.content = initial;
  }

  load(): TokenFileContent | null {
    return this.content;
  }

  save(content: TokenFileContent): void {
    this.content = content;
    this.generation++;
  }

  version(): string | null {
    return this.content ? String(this.generation) : null;
  }
}

type Env = Record<string, string | undefined>;

/** Case-insensitive env lookup (Windows env names are case-insensitive). */
function envGet(env: Env, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((x) => x.toUpperCase() === key.toUpperCase());
  return k ? env[k] : undefined;
}

/** Where the token file lives: TOTEM_TOKEN_FILE, else the per-user config dir. */
export function resolveTokenFilePath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const explicit = envGet(env, "TOTEM_TOKEN_FILE");
  if (explicit) return platform === "win32" ? win32.resolve(explicit) : resolve(explicit);
  return (platform === "win32" ? win32.join : join)(configDir(env, platform, home), "tokens.json");
}

/**
 * totem's own folder for this person: %APPDATA%\totem on Windows, else
 * $XDG_CONFIG_HOME/totem or ~/.config/totem. The WHOOP login and the record of
 * where the server runs live here, never in the install itself, which an
 * `npm install -g` replaces wholesale and may not even let its user write to.
 */
export function configDir(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") return win32.join(envGet(env, "APPDATA") || win32.join(home, "AppData", "Roaming"), "totem");
  const xdg = envGet(env, "XDG_CONFIG_HOME");
  return join(xdg && xdg.startsWith("/") ? xdg : join(home, ".config"), "totem");
}

/** The legacy .env keys v1 kept the tokens in. */
export const LEGACY_TOKEN_KEYS = ["WHOOP_IOS_BEARER_TOKEN", "WHOOP_COGNITO_REFRESH_TOKEN"] as const;

/**
 * Build a token record from v1's WHOOP_IOS_BEARER_TOKEN / WHOOP_COGNITO_REFRESH_TOKEN
 * (a local .env or a host's secrets). Null when either is missing.
 */
export function migrateFromEnv(env: Env, now: () => number = Date.now): TokenRecord | null {
  const access = envGet(env, "WHOOP_IOS_BEARER_TOKEN")?.trim();
  const refresh = envGet(env, "WHOOP_COGNITO_REFRESH_TOKEN")?.trim();
  if (!access || !refresh) return null;
  const userId = Number(envGet(env, "WHOOP_USER_ID"));
  return {
    access_token: access,
    refresh_token: refresh,
    client_id: inferClientId(access),
    source: "env-migration",
    saved_at: new Date(now()).toISOString(),
    user_id: Number.isInteger(userId) && userId > 0 ? userId : undefined,
    installation_id: envGet(env, "WHOOP_INSTALLATION_ID") || undefined,
  };
}

/** Running inside a container (Docker, Podman) or on a known container host. */
export function inContainer(env: Env = process.env, exists: (p: string) => boolean = existsSync): boolean {
  if (exists("/.dockerenv") || exists("/run/.containerenv")) return true;
  return Boolean(envGet(env, "FLY_APP_NAME") || envGet(env, "RAILWAY_ENVIRONMENT") || envGet(env, "K_SERVICE"));
}

/**
 * In a container, whether the token file's directory sits on a mounted volume
 * (a different device from the container's root), so it survives a restart.
 * Null when it can't be told.
 */
export function onMountedVolume(path: string): boolean | null {
  try {
    let dir = dirname(resolve(path));
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    if (dir === "/") return false;
    return statSync(dir).dev !== statSync("/").dev;
  } catch {
    return null;
  }
}
