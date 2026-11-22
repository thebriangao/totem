// One owner per refresh token (SPEC G8).
//
// WHOOP rotates the refresh token on every refresh. If two processes refresh the
// same login, the second presents a token the first already spent, and the
// login dies (or WHOOP revokes the whole token family). So exactly one process
// may refresh: the one holding `<token file>.lock`.
//
// The lock is created with O_EXCL and holds { pid, host, nonce, started_at,
// heartbeat_at }. The owner rewrites heartbeat_at every 30 s. A lock is stale,
// and may be taken over, when its process is gone (same host) or its heartbeat
// is older than 90 s. The owner re-reads the lock before each refresh, so a
// process that lost a takeover race finds out before it spends the token.
//
// This only sees processes sharing the file system. A laptop and a Fly machine
// each have their own file, which is why `totem auth` never leaves a refreshing
// copy behind when it pushes a login to a deployment.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./token_store.js";

export interface LockHolder {
  pid: number;
  host: string;
  nonce: string;
  started_at: string;
  heartbeat_at: string;
}

export interface TokenLockOptions {
  path: string;
  /** A heartbeat older than this marks the lock stale. Default 90 s. */
  staleMs?: number;
  /** How often the owner refreshes its heartbeat. Default 30 s. */
  heartbeatMs?: number;
  now?: () => number;
  pid?: number;
  host?: string;
  /** Whether a pid on this host is alive. Default: `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

export type AcquireResult = { acquired: true } | { acquired: false; holder: LockHolder | null };

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // alive, owned by another user
  }
}

function parseHolder(text: string): LockHolder | null {
  try {
    const raw = JSON.parse(text) as Partial<LockHolder>;
    if (typeof raw.pid !== "number" || typeof raw.nonce !== "string") return null;
    return {
      pid: raw.pid,
      host: typeof raw.host === "string" ? raw.host : "",
      nonce: raw.nonce,
      started_at: typeof raw.started_at === "string" ? raw.started_at : "",
      heartbeat_at: typeof raw.heartbeat_at === "string" ? raw.heartbeat_at : "",
    };
  } catch {
    return null;
  }
}

export class TokenLock {
  readonly path: string;
  private readonly staleMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly host: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly nonce = randomUUID();
  private startedAt = "";
  private isHeld = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TokenLockOptions) {
    this.path = opts.path;
    this.staleMs = opts.staleMs ?? 90_000;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.pid = opts.pid ?? process.pid;
    this.host = opts.host ?? hostname();
    this.isAlive = opts.isAlive ?? defaultIsAlive;
  }

  /** Whether this process believes it owns the lock (see verify()). */
  get held(): boolean {
    return this.isHeld;
  }

  /** Take the lock, or take over a stale one. Never blocks. */
  tryAcquire(): AcquireResult {
    if (this.isHeld && this.verify()) return { acquired: true };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        try {
          this.startedAt = new Date(this.now()).toISOString();
          writeSync(fd, JSON.stringify(this.info()));
        } finally {
          closeSync(fd);
        }
        this.isHeld = true;
        return { acquired: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = this.readHolder();
      if (!this.isStale(holder)) return { acquired: false, holder };
      // Stale. Remove it only if it is still the lock we judged; a racing
      // process may already have replaced it with a live one.
      const again = this.readHolder();
      if (holder && again && again.nonce !== holder.nonce) return { acquired: false, holder: again };
      try {
        rmSync(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { acquired: false, holder: this.readHolder() };
  }

  /** Re-read the lock file: do we still own it? Updates `held`. */
  verify(): boolean {
    const holder = this.readHolder();
    this.isHeld = holder !== null && holder.nonce === this.nonce;
    return this.isHeld;
  }

  /** Refresh the heartbeat if we still own the lock. Returns whether we do. */
  heartbeat(): boolean {
    if (!this.verify()) return false;
    try {
      writeFileAtomic(this.path, JSON.stringify(this.info()));
    } catch {
      // A missed beat is survivable; three in a row make the lock stale.
    }
    return true;
  }

  /** Heartbeat on an unref'd interval while we hold the lock. */
  startHeartbeat(onLost?: () => void): void {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      if (!this.heartbeat()) {
        this.stopHeartbeat();
        onLost?.();
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop heartbeating and delete the lock if it is ours. Safe to call twice. */
  release(): void {
    this.stopHeartbeat();
    if (!this.verify()) return;
    try {
      rmSync(this.path, { force: true });
    } catch {
      // best-effort
    }
    this.isHeld = false;
  }

  /** The current holder as written in the lock file, or null (missing or unreadable). */
  readHolder(): LockHolder | null {
    try {
      return parseHolder(readFileSync(this.path, "utf8"));
    } catch {
      return null;
    }
  }

  private isStale(holder: LockHolder | null): boolean {
    const now = this.now();
    if (!holder) {
      // Missing, half-written or garbage: stale once its mtime is old.
      try {
        return now - statSync(this.path).mtimeMs > this.staleMs;
      } catch {
        return true;
      }
    }
    if (holder.host === this.host) {
      // Our own pid with someone else's nonce is a previous incarnation of this
      // process slot (a container's pid 1 after a restart): it can't be alive.
      if (holder.pid === this.pid) return holder.nonce !== this.nonce;
      if (!this.isAlive(holder.pid)) return true;
    }
    const beat = Date.parse(holder.heartbeat_at);
    return !Number.isFinite(beat) || now - beat > this.staleMs;
  }

  private info(): LockHolder {
    return {
      pid: this.pid,
      host: this.host,
      nonce: this.nonce,
      started_at: this.startedAt || new Date(this.now()).toISOString(),
      heartbeat_at: new Date(this.now()).toISOString(),
    };
  }
}

/** A second process tried to refresh a login another process owns. */
export class WhoopTokenOwnedError extends Error {
  constructor(public readonly holder: LockHolder | null, lockPath: string) {
    const who = holder
      ? `pid ${holder.pid}${holder.host && holder.host !== hostname() ? ` on ${holder.host}` : ""}`
      : "another process";
    super(
      `WHOOP token owned by ${who} (${lockPath}); this process won't refresh it. ` +
        "Don't run local and remote on one login: give each its own `totem auth`.",
    );
    this.name = "WhoopTokenOwnedError";
  }
}
