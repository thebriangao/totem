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
// is older than 90 s.
//
// Creating a lock that doesn't exist is atomic (O_EXCL). Every change to an
// existing lock (replacing a stale one, the owner's heartbeat, the owner's
// release) is made while holding `<lock>.guard`, a second O_EXCL file held for
// microseconds. Without it, two processes that both judged a lock stale each
// delete "the stale lock" (the second deletes the first's brand-new one) and
// both become the owner. Before each refresh the owner confirms its lock under
// the guard and stamps a fresh heartbeat (confirm()), so nobody can judge it
// stale while it spends the refresh token.
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

/**
 * confirm()'s answer: "held" (ours, heartbeat just stamped), "lost" (another
 * process owns it now), or "busy" (another process is changing the lock this
 * instant, so ownership can't be proven right now).
 */
export type LockState = "held" | "lost" | "busy";

/** A guard older than this was left by a process that died inside its critical section. */
const GUARD_STALE_MS = 10_000;
const GUARD_ATTEMPTS = 6;

/** Block this thread for a moment. Guard sections last microseconds, so a few ms is plenty. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // alive, owned by another user
  }
}

/**
 * An O_EXCL create failed because the file exists. On Windows a file that is
 * being deleted while another process still has it open answers EPERM/EACCES
 * until that handle closes; that is the same "someone else has it" case.
 */
function alreadyThere(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return true;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
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

  /** Take the lock, or take over a stale one. Never waits for a live owner. */
  tryAcquire(): AcquireResult {
    if (this.isHeld && this.verify()) return { acquired: true };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // No lock file: O_EXCL makes creating one atomic on its own.
    if (this.create()) return { acquired: true };
    const holder = this.readHolder();
    if (!this.isStale(holder)) return { acquired: false, holder };
    // Stale. Judge it again and replace it while holding the guard, so only one
    // of several processes that saw the same stale lock takes it over.
    const result = this.exclusive((): AcquireResult => {
      const current = this.readHolder();
      if (!this.isStale(current)) return { acquired: false, holder: current };
      try {
        rmSync(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return this.create() ? { acquired: true } : { acquired: false, holder: this.readHolder() };
    });
    return result.ran ? result.value : { acquired: false, holder: this.readHolder() };
  }

  /** Re-read the lock file: do we still own it? Updates `held`. */
  verify(): boolean {
    const holder = this.readHolder();
    this.isHeld = holder !== null && holder.nonce === this.nonce;
    return this.isHeld;
  }

  /**
   * Prove we still own the lock and stamp a fresh heartbeat, in one step under
   * the guard. Call it right before spending the refresh token: "held" means no
   * other process has taken the lock over, and none will judge it stale for the
   * next `staleMs`. Throws when the lock can't be written (a disk that would
   * also refuse the rotated token).
   */
  confirm(): LockState {
    const result = this.exclusive((): LockState => {
      if (!this.verify()) return "lost";
      writeFileAtomic(this.path, JSON.stringify(this.info()));
      return "held";
    });
    return result.ran ? result.value : "busy";
  }

  /** Refresh the heartbeat if we still own the lock. Returns whether we do. */
  heartbeat(): boolean {
    let state: LockState;
    try {
      state = this.confirm();
    } catch {
      // A missed beat is survivable; three in a row make the lock stale.
      return this.isHeld;
    }
    // "busy": another process holds the guard this instant. Skip the beat.
    return state === "busy" ? this.isHeld : state === "held";
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
    try {
      // Under the guard, so we can't delete a lock another process is taking
      // over at this instant. If the guard is busy the lock stays behind and
      // goes stale with our pid.
      this.exclusive(() => {
        if (this.verify()) rmSync(this.path, { force: true });
      });
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

  /** Create the lock file if there is none (O_EXCL). False when one exists. */
  private create(): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "wx", 0o600);
    } catch (error) {
      if (alreadyThere(error)) return false;
      throw error;
    }
    try {
      this.startedAt = new Date(this.now()).toISOString();
      writeSync(fd, JSON.stringify(this.info()));
    } finally {
      closeSync(fd);
    }
    this.isHeld = true;
    return true;
  }

  /**
   * Run `fn` while holding `<lock>.guard`. `ran: false` when another process
   * kept the guard for the whole (short) wait.
   *
   * A guard can be left behind only by a process that died inside these few
   * microseconds; one older than 10 s is removed. (Two processes racing to
   * remove such a guard could both get in. That takes a crash inside the
   * section and a simultaneous race, and the owner's confirm() before each
   * refresh still catches a lost lock.)
   */
  private exclusive<T>(fn: () => T): { ran: true; value: T } | { ran: false } {
    const guard = `${this.path}.guard`;
    for (let attempt = 0; attempt < GUARD_ATTEMPTS; attempt++) {
      let fd: number;
      try {
        fd = openSync(guard, "wx", 0o600);
      } catch (error) {
        if (!alreadyThere(error)) throw error;
        let age: number;
        try {
          age = Date.now() - statSync(guard).mtimeMs; // the file's clock, not the injected one
        } catch {
          continue; // released between our open and our stat
        }
        if (age > GUARD_STALE_MS) {
          try { rmSync(guard); } catch { /* another process cleared it */ }
        } else {
          sleepSync(2 + attempt * 2);
        }
        continue;
      }
      try {
        try { writeSync(fd, this.nonce); } finally { closeSync(fd); }
        return { ran: true, value: fn() };
      } finally {
        // Remove the guard if it is still ours (it isn't if we stalled past
        // GUARD_STALE_MS and another process cleared it).
        try {
          if (readFileSync(guard, "utf8") === this.nonce) rmSync(guard);
        } catch { /* already gone */ }
      }
    }
    return { ran: false };
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
