// Holds the WHOOP login, refreshes it, and keeps it alive.
//
// - Durable (G6): every rotated refresh token is written to the TokenStore
//   BEFORE the new access token is handed out. A failed write is fatal: the old
//   refresh token is already spent, so carrying on would strand the login at the
//   next restart.
// - Keep-alive (G7): refresh when less than 10 minutes of access life remain,
//   plus a periodic refresh (default every 12 h, TOTEM_KEEPALIVE_HOURS) so an
//   idle server never lets the refresh token go unused. The timer is unref'd and
//   shares the single-flight with on-demand refreshes.
// - One owner (G8): with a TokenLock, only the lock holder refreshes. Another
//   process on the same token file runs as a follower: it picks up the owner's
//   rotated tokens from the file and never refreshes; it takes over only when
//   the owner's lock goes stale, and otherwise fails with WhoopTokenOwnedError.
// - The file is the source of truth: when another writer changes it (`totem
//   auth`, a push to the admin endpoint), the manager adopts the new login on
//   its next call, without a restart.
// - G9: WhoopAuthExpiredError only when Cognito refuses the refresh itself.

import { CognitoError, decodeJwtExp, refreshCognitoSession, type CognitoTokens } from "./cognito.js";
import { WhoopAuthExpiredError } from "./errors.js";
import { WhoopTokenOwnedError, type LockHolder, type LockState, type TokenLock } from "./token_lock.js";
import { isHandoff, type HandoffRecord, type TokenRecord, type TokenSource, type TokenStore } from "./token_store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** setTimeout's ceiling (~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A follower lets the owner go first, then checks. */
const FOLLOWER_GRACE_MS = 2 * MINUTE;
/** A follower re-checks this often while a live owner hasn't refreshed yet. */
const FOLLOWER_POLL_MS = 5 * MINUTE;
/** A follower keeps using an access token until this close to expiry. */
const FOLLOWER_MIN_LIFE_MS = 30_000;

/** No login saved on this server or machine. */
export class WhoopNotLoggedInError extends WhoopAuthExpiredError {
  constructor(where: string) {
    super();
    this.message = `No WHOOP login on this server (${where}). Run \`totem auth\` to log in.`;
    this.name = "WhoopNotLoggedInError";
  }
}

/** This copy's login was pushed to a deployment by `totem auth`; it must not refresh. */
export class WhoopLoginHandedOffError extends WhoopAuthExpiredError {
  constructor(public readonly to: string, at: string) {
    super();
    this.message =
      `This WHOOP login was handed to ${to} (${at.slice(0, 10)}), so this copy no longer refreshes it. ` +
      "Run `totem auth --local` to give this machine its own login.";
    this.name = "WhoopLoginHandedOffError";
  }
}

/** The rotated refresh token could not be written. Fatal: the old one is spent. */
export class WhoopTokenPersistError extends Error {
  constructor(where: string, cause: unknown) {
    super(
      `Couldn't save the rotated WHOOP refresh token to ${where} (${cause instanceof Error ? cause.message : String(cause)}). ` +
        "The previous refresh token is already spent, so this login can't survive a restart. Fix the disk, then run `totem auth`.",
    );
    this.name = "WhoopTokenPersistError";
  }
}

/**
 * The token directory can't be written right now, found out BEFORE spending the
 * refresh token. Nothing is lost: the login is still valid and refreshes again
 * once the disk is writable.
 */
export class WhoopTokenUnwritableError extends Error {
  constructor(where: string, cause: unknown) {
    super(
      `Can't write next to the WHOOP token file ${where} (${cause instanceof Error ? cause.message : String(cause)}), ` +
        "so the token wasn't refreshed (a rotated refresh token that can't be saved would end the login). Fix the disk or its permissions.",
    );
    this.name = "WhoopTokenUnwritableError";
  }
}

/** The refresh failed for a reason other than a refused login (network, throttling, outage). */
export class WhoopRefreshUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Couldn't reach WHOOP's login service to refresh the token (${cause instanceof Error ? cause.message : String(cause)}). Try again shortly.`);
    this.name = "WhoopRefreshUnavailableError";
  }
}

export type TokenRole = "owner" | "follower" | "solo";

export interface TokenStatus {
  state: "ok" | "no-login" | "handed-off" | "expired" | "fatal";
  role: TokenRole;
  store: string;
  source?: TokenSource | undefined;
  client_id?: string | undefined;
  user_id?: number | undefined;
  saved_at?: string | undefined;
  refreshed_at?: string | undefined;
  access_expires_at?: string | undefined;
  next_keepalive_at?: string | undefined;
  handed_off_to?: string | undefined;
  owner?: { pid: number; host: string } | undefined;
  detail?: string | undefined;
}

export interface TokenManagerConfig {
  store: TokenStore;
  /** Single-owner lock (G8). Omit for the memory store and tests. */
  lock?: TokenLock | null | undefined;
  /** Refresh when less than this much access life remains. Default 10 min. */
  refreshSkewMs?: number | undefined;
  /** Periodic refresh interval. Default 12 h; 0 turns the periodic refresh off. */
  keepAliveMs?: number | undefined;
  /** First retry after a transient keep-alive failure (doubles, capped at 15 min). Default 60 s. */
  retryBaseMs?: number | undefined;
  /** Write attempts before a failed save is fatal. Default 3. */
  saveAttempts?: number | undefined;
  now?: (() => number) | undefined;
  refresh?: ((refreshToken: string, clientId: string) => Promise<CognitoTokens>) | undefined;
  log?: ((message: string) => void) | undefined;
  /** Called once when a rotated token can't be persisted. The server exits. */
  onFatal?: ((error: Error) => void) | undefined;
  /** Called when the login itself changes (new login, hand-off, removal), not on rotation. */
  onLoginChange?: ((record: TokenRecord | null) => void) | undefined;
}

type MustRefresh = (record: TokenRecord) => boolean;

export class TokenManager {
  private readonly store: TokenStore;
  private readonly lock: TokenLock | null;
  private readonly skewMs: number;
  private readonly keepAliveMs: number;
  private readonly retryBaseMs: number;
  private readonly saveAttempts: number;
  private readonly now: () => number;
  private readonly refreshFn: (refreshToken: string, clientId: string) => Promise<CognitoTokens>;
  private readonly log: (message: string) => void;
  private readonly onFatal: ((error: Error) => void) | undefined;
  private readonly onLoginChange: ((record: TokenRecord | null) => void) | undefined;

  private record: TokenRecord | null = null;
  private handoff: HandoffRecord | null = null;
  private expired: string | null = null;
  private fatal: Error | null = null;
  private forceRefresh = false;
  private lastRefreshAt = 0;
  private seenVersion: string | null = null;
  private loaded = false;
  private refreshing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt: number | null = null;
  private retryMs: number;
  private stopped = true;
  private ownerHint: LockHolder | null = null;

  constructor(config: TokenManagerConfig) {
    this.store = config.store;
    this.lock = config.lock ?? null;
    this.skewMs = config.refreshSkewMs ?? 10 * MINUTE;
    this.keepAliveMs = config.keepAliveMs ?? 12 * HOUR;
    this.retryBaseMs = config.retryBaseMs ?? MINUTE;
    this.retryMs = this.retryBaseMs;
    this.saveAttempts = Math.max(1, config.saveAttempts ?? 3);
    this.now = config.now ?? Date.now;
    this.refreshFn = config.refresh ?? refreshCognitoSession;
    this.log = config.log ?? ((m) => console.error(`[totem] ${m}`));
    this.onFatal = config.onFatal;
    this.onLoginChange = config.onLoginChange;
  }

  /** Load the saved login, claim ownership, and start the keep-alive timer. */
  start(): void {
    this.stopped = false;
    this.sync(true);
    if (this.lock) {
      const result = this.lock.tryAcquire();
      if (result.acquired) {
        this.lock.startHeartbeat(() => this.log("lost the token lock to another process; this process won't refresh any more"));
      } else {
        this.ownerHint = result.holder;
        this.log(
          `another totem process (pid ${result.holder?.pid ?? "?"}) owns this login; this one follows its token file and won't refresh`,
        );
      }
    }
    this.schedule();
  }

  /** Stop the timer and release the lock. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.lock?.release();
  }

  /** The current access token, refreshing first when needed. */
  async getToken(): Promise<string> {
    this.sync();
    const record = this.usable();
    if (!this.forceRefresh && this.timeLeft(record) > this.skewMs) return record.access_token;
    await this.ensureFresh("on demand", (r) => this.forceRefresh || this.timeLeft(r) <= this.skewMs);
    return this.usable().access_token;
  }

  /**
   * WHOOP answered 401 with `rejectedToken`: force the next getToken() to refresh.
   * Ignored when that token is no longer current (parallel 401s cost one refresh)
   * or within a minute of the last refresh (a token WHOOP keeps rejecting is
   * path-specific, not expired; see client.ts).
   */
  invalidate(rejectedToken: string): void {
    if (rejectedToken !== this.record?.access_token) return;
    if (this.now() - this.lastRefreshAt < MINUTE) return;
    this.forceRefresh = true;
  }

  /**
   * Install a new login (POST /admin/tokens). Persists it first; throws when the
   * write fails, leaving the previous login in place.
   */
  adopt(record: TokenRecord): void {
    if (this.lock && !this.lock.held) {
      const result = this.lock.tryAcquire();
      if (result.acquired) this.lock.startHeartbeat();
    }
    this.store.save(record);
    this.seenVersion = this.store.version();
    this.loaded = true;
    this.setRecord(record, null);
    this.lastRefreshAt = 0;
    this.fatal = null;
    this.retryMs = this.retryBaseMs;
    this.log(`installed a new WHOOP login (${record.source}); saved to ${this.store.description}`);
    this.schedule();
  }

  /** Record extra fields on the current login (owner only, best-effort). */
  annotate(patch: { user_id?: number | undefined; installation_id?: string | undefined }): void {
    // Start from the file, and only as the proven owner: writing our in-memory
    // copy as a process that lost the lock would put a spent refresh token back
    // over the one the new owner rotated.
    this.sync();
    if (!this.record || (this.lock && !this.lock.verify())) return;
    const next: TokenRecord = { ...this.record };
    if (patch.user_id !== undefined) next.user_id = patch.user_id;
    if (patch.installation_id !== undefined) next.installation_id = patch.installation_id;
    try {
      this.store.save(next);
      this.seenVersion = this.store.version();
      this.record = next;
    } catch (error) {
      this.log(`couldn't update ${this.store.description}: ${(error as Error).message}`);
    }
  }

  /** The current login, if any (after picking up file changes). */
  current(): TokenRecord | null {
    this.sync();
    return this.record;
  }

  status(): TokenStatus {
    this.sync();
    const role: TokenRole = !this.lock ? "solo" : this.lock.held ? "owner" : "follower";
    const r = this.record;
    const state: TokenStatus["state"] = this.fatal ? "fatal"
      : this.handoff ? "handed-off"
      : !r ? "no-login"
      : this.expired ? "expired"
      : "ok";
    const exp = r ? decodeJwtExp(r.access_token) * 1000 : 0;
    const owner = role === "follower" ? (this.lock?.readHolder() ?? this.ownerHint) : null;
    return {
      state,
      role,
      store: this.store.description,
      source: r?.source,
      client_id: r?.client_id,
      user_id: r?.user_id ?? this.handoff?.user_id,
      saved_at: r?.saved_at ?? this.handoff?.saved_at,
      refreshed_at: r?.refreshed_at,
      access_expires_at: exp ? new Date(exp).toISOString() : undefined,
      next_keepalive_at: this.nextAt ? new Date(this.nextAt).toISOString() : undefined,
      handed_off_to: this.handoff?.handed_off_to,
      owner: owner ? { pid: owner.pid, host: owner.host } : undefined,
      detail: this.fatal?.message ?? this.expired ?? undefined,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** The current record, or the error explaining why there isn't a usable one. */
  private usable(): TokenRecord {
    if (this.fatal) throw this.fatal;
    if (this.handoff) throw new WhoopLoginHandedOffError(this.handoff.handed_off_to, this.handoff.saved_at);
    if (!this.record) throw new WhoopNotLoggedInError(this.store.description);
    if (this.expired) throw new WhoopAuthExpiredError(this.expired);
    return this.record;
  }

  private timeLeft(record: TokenRecord): number {
    return decodeJwtExp(record.access_token) * 1000 - this.now();
  }

  /** Last refresh (or login) time of a record, epoch ms. */
  private refreshedAt(record: TokenRecord): number {
    const t = Date.parse(record.refreshed_at ?? record.saved_at);
    return Number.isFinite(t) ? t : 0;
  }

  /** When the keep-alive should next refresh this record. */
  private dueAt(record: TokenRecord): number {
    const byExpiry = decodeJwtExp(record.access_token) * 1000 - this.skewMs;
    const byPeriod = this.keepAliveMs > 0 ? this.refreshedAt(record) + this.keepAliveMs : Infinity;
    return Math.min(byExpiry, byPeriod);
  }

  /** dueAt, plus a grace period for a follower so the owner goes first. */
  private followerAwareDue(record: TokenRecord): number {
    return this.dueAt(record) + (this.lock && !this.lock.held ? FOLLOWER_GRACE_MS : 0);
  }

  /** Re-read the store when it changed (or when forced). */
  private sync(force = false): void {
    const version = this.store.version();
    if (!force && this.loaded && version === this.seenVersion) return;
    let content;
    try {
      content = this.store.load();
    } catch (error) {
      this.log((error as Error).message);
      return; // keep what we have; retry on the next change
    }
    this.loaded = true;
    this.seenVersion = version;
    if (!content) this.setRecord(null, null);
    else if (isHandoff(content)) this.setRecord(null, content);
    else this.setRecord(content, null);
  }

  private setRecord(record: TokenRecord | null, handoff: HandoffRecord | null): void {
    const before = this.record;
    const newLogin =
      (before?.saved_at ?? null) !== (record?.saved_at ?? null) ||
      (before?.source ?? null) !== (record?.source ?? null) ||
      Boolean(this.handoff) !== Boolean(handoff);
    if (before?.refresh_token !== record?.refresh_token) {
      this.expired = null;
      this.forceRefresh = false;
    }
    this.record = record;
    this.handoff = handoff;
    if (newLogin && this.loaded) {
      this.onLoginChange?.(record);
      if (!this.stopped) this.schedule();
    }
  }

  /** Make sure we own the login (or may take it over). */
  private claim(): boolean {
    if (!this.lock) return true;
    if (this.lock.held) {
      // Prove ownership and stamp a fresh heartbeat in one step. Re-reading the
      // lock isn't enough: after a laptop sleep our heartbeat is hours old, and
      // a follower waking beside us would take the "stale" lock over while our
      // refresh is on the wire, spending the same refresh token twice.
      let state: LockState;
      try {
        state = this.lock.confirm();
      } catch (error) {
        // The lock sits next to the token file. If it can't be written, the
        // rotated refresh token couldn't be saved either: don't spend this one.
        throw new WhoopTokenUnwritableError(this.store.description, error);
      }
      if (state === "held") return true;
      if (state === "busy") {
        this.ownerHint = this.lock.readHolder();
        return false;
      }
    }
    const result = this.lock.tryAcquire();
    if (result.acquired) {
      this.log(`took over the WHOOP login${this.ownerHint ? ` from pid ${this.ownerHint.pid}, which stopped` : ""}`);
      this.ownerHint = null;
      this.lock.startHeartbeat(() => this.log("lost the token lock to another process; this process won't refresh any more"));
      return true;
    }
    this.ownerHint = result.holder;
    return false;
  }

  private ensureFresh(reason: string, mustRefresh: MustRefresh): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.refreshOnce(reason, mustRefresh).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refreshOnce(reason: string, mustRefresh: MustRefresh): Promise<void> {
    if (!this.claim()) {
      // Follower: the owner refreshes and writes the file; we only read it.
      this.sync(true);
      const record = this.usable();
      this.forceRefresh = false;
      if (this.timeLeft(record) > FOLLOWER_MIN_LIFE_MS) return;
      throw new WhoopTokenOwnedError(this.ownerHint, this.lock!.path);
    }

    // Pick up a login another writer saved (`totem auth`) before spending ours.
    this.sync();
    const before = this.usable();
    if (!mustRefresh(before)) return;
    const versionBefore = this.store.version();

    let next: CognitoTokens;
    try {
      next = await this.refreshFn(before.refresh_token, before.client_id);
    } catch (error) {
      if (error instanceof CognitoError && error.isAuthFailure) {
        this.expired = error.message;
        this.log(`WHOOP refused the refresh token (${error.message}). Run \`totem auth\` to log in again.`);
        throw new WhoopAuthExpiredError(error.message);
      }
      throw new WhoopRefreshUnavailableError(error);
    }

    // The file changed while we were refreshing. If `totem auth` replaced the
    // login, handed it to a deployment, or the file was removed, that wins: the
    // session we just refreshed is abandoned, never written back over it.
    if (this.store.version() !== versionBefore) {
      this.sync(true);
      if (!this.record) {
        this.log("the login was handed off or removed while refreshing; not saving the refreshed session");
        return;
      }
      if (this.record.refresh_token !== before.refresh_token) {
        this.log("the login was replaced while refreshing; using the new one");
        return;
      }
    }

    const record: TokenRecord = {
      ...(this.record ?? before), // the same login, with anything annotate() added meanwhile
      access_token: next.accessToken,
      refresh_token: next.refreshToken || before.refresh_token,
      refreshed_at: new Date(this.now()).toISOString(),
    };
    this.persist(record); // before anyone sees the new access token
    this.record = record;
    this.forceRefresh = false;
    this.lastRefreshAt = this.now();
    const exp = decodeJwtExp(record.access_token) * 1000;
    this.log(
      `refreshed the WHOOP access token (${reason}); it expires ${exp ? new Date(exp).toISOString() : "at an unknown time"}` +
        `${record.refresh_token !== before.refresh_token ? "; rotated refresh token saved" : ""}`,
    );
    this.schedule();
  }

  private persist(record: TokenRecord): void {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.saveAttempts; attempt++) {
      try {
        this.store.save(record);
        this.seenVersion = this.store.version();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    const fatal = new WhoopTokenPersistError(this.store.description, lastError);
    this.fatal = fatal;
    this.clearTimer();
    this.log(fatal.message);
    this.onFatal?.(fatal);
    throw fatal;
  }

  // ── keep-alive ───────────────────────────────────────────────────────────

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  private schedule(delayOverride?: number): void {
    this.clearTimer();
    if (this.stopped || this.fatal || this.handoff || this.expired || !this.record) return;
    const delay = Math.min(Math.max(delayOverride ?? this.followerAwareDue(this.record) - this.now(), 1_000), MAX_TIMER_MS);
    this.nextAt = this.now() + delay;
    this.timer = setTimeout(() => void this.keepAlive(), delay);
    this.timer.unref?.();
  }

  private async keepAlive(): Promise<void> {
    this.timer = null;
    this.nextAt = null;
    if (this.stopped) return;
    try {
      this.sync();
      if (!this.record || this.handoff || this.fatal || this.expired) return;
      await this.ensureFresh("keep-alive", (r) => this.now() >= this.dueAt(r));
      this.retryMs = this.retryBaseMs;
      // A follower whose live owner hasn't refreshed yet polls instead of spinning.
      const waiting = this.record && this.followerAwareDue(this.record) <= this.now();
      this.schedule(waiting ? FOLLOWER_POLL_MS : undefined);
    } catch (error) {
      if (error instanceof WhoopTokenOwnedError) {
        this.schedule(FOLLOWER_POLL_MS);
      } else if (error instanceof WhoopAuthExpiredError || error instanceof WhoopTokenPersistError) {
        // Logged where it happened; nothing to retry until a new login arrives.
      } else {
        this.log(`keep-alive refresh failed (${(error as Error).message}); retrying in ${Math.round(this.retryMs / 1000)}s`);
        const delay = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, 15 * MINUTE);
        this.schedule(delay);
      }
    }
  }
}

/** Keep-alive interval from TOTEM_KEEPALIVE_HOURS (default 12; 0 = expiry-driven only). */
export function keepAliveMsFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 12 * HOUR;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) return 12 * HOUR;
  return Math.round(hours * HOUR);
}
