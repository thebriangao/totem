import { BASE_URL, REQUEST_TIMEOUT_MS } from "./constants.js";
import { deviceHeaders } from "./device.js";
import { isoDay } from "../lib/dates.js";
import {
  WhoopApiError,
  WhoopConflictError,
  WhoopEndpointUnauthorizedError,
  WhoopServerError,
  apiErrorDetail,
  htmlTitle,
  parseOverlaps,
} from "./errors.js";

export interface WhoopClientConfig {
  /** Async function returning a fresh bearer token. Called before each request. */
  getToken: () => Promise<string>;
  /** Injectable clock for deterministic cache tests. */
  now?: () => number;
  /**
   * Called with the rejected token when Whoop answers 401, before the single
   * retry, so the token source can force a refresh.
   */
  onUnauthorized?: (rejectedToken: string) => void;
  /** Injectable sleep for the 412 retry backoff (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** Backoff for WHOOP's 412 "User's cycle is concurrently being updated" on writes. */
const RETRY_412_DELAYS_MS = [2_000, 10_000] as const;
/** How long lift reads stay uncached after a write that changes them. */
const LIFT_SETTLE_MS = 2 * 60_000;

type QueryValue = string | number | boolean | undefined | null;

type CacheEntry = {
  value: unknown;
  expiresAt: number;
  bytes: number;
  tags: readonly string[];
};

const MAX_CACHE_ENTRIES = 100;
const MAX_CACHE_BYTES = 10 * 1024 * 1024;

/**
 * Process-local LRU for safe GET results. It deliberately never persists data,
 * and only keeps completed values for endpoints with an explicit TTL policy.
 */
class RequestCache {
  private readonly values = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private bytes = 0;
  // Bumped on every invalidation so a read that started before a write can't
  // store (or be shared as) pre-write data once it lands.
  private generation = 0;
  private loadSeq = 0;
  private readonly latestLoad = new Map<string, number>();
  private readonly unsettledUntil = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  async getOrLoad<T>(
    key: string,
    policy: { ttlMs: number; tags: readonly string[] } | null,
    load: () => Promise<T>,
    fresh = false,
  ): Promise<T> {
    const cached = fresh ? undefined : this.values.get(key);
    if (cached) {
      if (cached.expiresAt > this.now()) {
        // Map insertion order is the LRU order.
        this.values.delete(key);
        this.values.set(key, cached);
        return cached.value as T;
      }
      this.delete(key, cached);
    }

    // Even live endpoints share an already-running identical request, but their
    // completed values are never retained.
    const existing = fresh ? undefined : this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const generation = this.generation;
    const seq = ++this.loadSeq;
    this.latestLoad.set(key, seq);
    const pending: Promise<T> = load()
      .then((value) => {
        // Pending activities are mutable server-side objects; serving one after
        // Whoop finishes scoring it would be misleading. A load superseded by a
        // newer one for the same key (a fresh read) must not overwrite it.
        const latest = this.latestLoad.get(key) === seq;
        if (latest && generation === this.generation) {
          // The newest read replaces what was cached even when it can't be kept
          // itself (a pending record, an oversized body, or a tag WHOOP is still
          // catching up on after a write). Otherwise a fresh read that came back
          // pending left the older entry in place, and the next ordinary read
          // served data from before the one just returned.
          const kept = policy !== null && !containsPendingState(value) && !this.unsettled(policy.tags) &&
            this.store(key, value, policy);
          if (!kept) this.evict(key);
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
        if (this.latestLoad.get(key) === seq) this.latestLoad.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  invalidate(tags: readonly string[]): void {
    this.generation++;
    this.inFlight.clear();
    if (tags.includes("all")) {
      this.values.clear();
      this.bytes = 0;
      return;
    }
    for (const [key, entry] of this.values) {
      if (entry.tags.some((tag) => tags.includes(tag))) this.delete(key, entry);
    }
  }

  private evict(key: string): void {
    const entry = this.values.get(key);
    if (entry) this.delete(key, entry);
  }

  /** Serve reads tagged `tag` live, without retaining them, for the next `ms`: WHOOP is still catching up with a write. */
  holdOff(tag: string, ms: number): void {
    this.unsettledUntil.set(tag, this.now() + ms);
  }

  private unsettled(tags: readonly string[]): boolean {
    return tags.some((tag) => (this.unsettledUntil.get(tag) ?? 0) > this.now());
  }

  /** Returns whether the value was kept. */
  private store(key: string, value: unknown, policy: { ttlMs: number; tags: readonly string[] }): boolean {
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value));
    } catch {
      return false; // Never let cache accounting affect a successful API response.
    }
    if (bytes > MAX_CACHE_BYTES) return false;
    const existing = this.values.get(key);
    if (existing) this.delete(key, existing);
    const entry: CacheEntry = {
      value,
      expiresAt: this.now() + policy.ttlMs,
      bytes,
      tags: policy.tags,
    };
    this.values.set(key, entry);
    this.bytes += bytes;
    while (this.values.size > MAX_CACHE_ENTRIES || this.bytes > MAX_CACHE_BYTES) {
      const oldest = this.values.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.delete(oldest[0], oldest[1]);
    }
    return this.values.has(key);
  }

  private delete(key: string, entry: CacheEntry): void {
    this.values.delete(key);
    this.bytes -= entry.bytes;
  }
}

function containsPendingState(value: unknown): boolean {
  try {
    // Matches both the iOS "PENDING" state and the developer API's "PENDING_SCORE".
    return /"pending(_score)?"/.test(JSON.stringify(value).toLowerCase());
  } catch {
    return true;
  }
}

/**
 * Refuse a path the URL parser would not send as written. `new URL()` resolves
 * "." and ".." segments (also spelled "%2e"), turns "\" into "/", drops tabs
 * and newlines, cuts at "#", and without a leading "/" reads the text as part
 * of the host. A path built from a caller-supplied id could otherwise reach a
 * different endpoint (or host, with the bearer token) than the one the calling
 * tool, and whoop_raw's write denylist, checked.
 */
export function assertVerbatimPath(path: string): void {
  const beforeQuery = path.split("?")[0]!;
  const dotSegment = beforeQuery.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
  if (!path.startsWith("/") || dotSegment || /[\\#\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(
      `Refusing to call WHOOP path ${JSON.stringify(path)}: it must start with "/" and contain no "." or ".." segments, backslashes, "#" or control characters.`,
    );
  }
}

function cacheKey(path: string, query: Record<string, QueryValue>): string {
  const params = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    // Encoded, so {a: "1&b=2"} and {a: "1", b: "2"} (different requests) don't share a key.
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${path}?${params}`;
}

function cachePolicy(
  path: string,
  query: Record<string, QueryValue>,
  now: () => number,
): { ttlMs: number; tags: readonly string[] } | null {
  const suppliedDate = [query.date, query.endDate, query.end]
    .find((value): value is string | number | boolean => value !== undefined && value !== null);
  // Some APIs put their date in the path (for example weekly-plan), rather
  // than in a query parameter. Treat them consistently with query-based reads.
  const pathDate = path.match(/\/(\d{4}-\d{2}-\d{2})(?:\/|$)/)?.[1];
  const dateHint = typeof suppliedDate === "string" ? suppliedDate.slice(0, 10) : pathDate;
  // Dates represent the member's day, not UTC server time. Current-day reads
  // use the following bounded TTLs: home 30s; activity 60s; recovery, sleep,
  // trends, lifts, communities and journal 5m; calendar 15m; settings 10m.
  // Historical reads may use their longer endpoint-specific TTLs below.
  const today = isoDay(new Date(now()));
  // Calendar reads cover the whole month containing the date, and weekly-plan
  // reads the week containing it, so they're only historical once that whole
  // period is over.
  const periodEnd = !dateHint
    ? undefined
    : path.includes("calendar/")
      ? `${dateHint.slice(0, 7)}-31`
      : path.includes("weekly-plan")
        ? new Date(Date.parse(`${dateHint}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10)
        : dateHint;
  const historical = Boolean(periodEnd && periodEnd < today);
  // Freshness-sensitive endpoints must never return a completed cached value.
  if (
    path === "/health-tab-bff/v1/health-tab" ||
    path === "/activities-service/v1/user-state" ||
    path.startsWith("/health-service/v2/stress-bff/")
  ) return null;
  // Never cache: the coach and memory (every read can change state), other
  // people's data (D9: community + Humans), and today's health monitor.
  if (
    path.startsWith("/ai-conversation-") ||
    path.startsWith("/context-hub-bff/") ||
    path.startsWith("/community-service/") ||
    path.startsWith("/followers-service/") ||
    path.startsWith("/coaching-service/v1/health/bff/monitor")
  ) return null;
  // Heart rate: a window that ended over a day ago is settled; anything newer can
  // still gain readings when the strap syncs, so it is always read fresh.
  if (path.startsWith("/metrics-service/")) {
    const end = typeof query.end === "string" ? Date.parse(query.end) : NaN;
    return Number.isFinite(end) && end < now() - 24 * 60 * 60_000 ? { ttlMs: 15 * 60_000, tags: ["daily"] } : null;
  }
  // Bulk cycle history spans many days, so it is short-lived and dropped by any activity, sleep or journal write.
  if (path === "/core-details-bff/v0/cycles/details") return { ttlMs: 5 * 60_000, tags: ["daily", "activity", "sleep", "recovery"] };
  // Static catalogs change with app releases, not with user actions.
  if (
    path === "/activities-service/v1/sports" ||
    path === "/activities-service/v2/activity-types" ||
    path === "/weightlifting-service/v2/exercise" ||
    path === "/strap-location-service/v1/garment"
  ) return { ttlMs: 24 * 60 * 60_000, tags: ["catalog"] };
  // Per-activity detail screens carry no date hint; their content changes on edits.
  if (path.startsWith("/core-details-bff/v2/sleep-details/") || path.includes("recovery-details")) {
    return { ttlMs: 5 * 60_000, tags: ["activity", "sleep", "daily"] };
  }
  if (path.startsWith("/progression-service/v3/trends/WEIGHT/readings")) {
    return { ttlMs: 5 * 60_000, tags: ["trend", "weight", "profile"] };
  }
  if (path.includes("/weekly-plan")) return { ttlMs: historical ? 60 * 60_000 : 5 * 60_000, tags: ["trend", "weekly_plan", "daily"] };
  if (path.startsWith("/milestones-service/") || path.startsWith("/streaks-service/")) {
    return { ttlMs: 10 * 60_000, tags: ["milestones"] };
  }

  if (path === "/home-service/v1/home") return { ttlMs: historical ? 60 * 60_000 : 30_000, tags: ["daily"] };
  if (path.includes("calendar/")) return { ttlMs: historical ? 12 * 60 * 60_000 : 15 * 60_000, tags: ["calendar", "daily"] };
  if (path.includes("deep-dive/recovery") || path === "/developer/v2/recovery") {
    return { ttlMs: historical ? 60 * 60_000 : 5 * 60_000, tags: ["recovery", "daily"] };
  }
  if (path.includes("deep-dive/sleep") || path === "/developer/v2/activity/sleep") {
    return { ttlMs: historical ? 60 * 60_000 : 5 * 60_000, tags: ["sleep", "daily"] };
  }
  if (path.includes("sleepneed")) return { ttlMs: 60_000, tags: ["sleep_plan", "daily"] };
  if (path.includes("progression-service")) return { ttlMs: historical ? 60 * 60_000 : 5 * 60_000, tags: ["trend"] };
  if (path.includes("activity/workout") || path.includes("cardio-details")) {
    return { ttlMs: historical ? 15 * 60_000 : 60_000, tags: ["activity", "daily"] };
  }
  if (path.includes("weightlifting-service")) return { ttlMs: 5 * 60_000, tags: ["lift"] };
  if (
    path.includes("bootstrap") ||
    path.includes("hidden-metrics") ||
    path.includes("stealth-mode") ||
    path.includes("hr-zones") ||
    path.includes("smart-alarm")
  ) return { ttlMs: 10 * 60_000, tags: ["settings", "profile"] };
  if (path.includes("journal-service")) return { ttlMs: 5 * 60_000, tags: ["journal", "daily"] };
  return null;
}

function writeInvalidationTags(path: string): readonly string[] {
  const ACTIVITY = ["activity", "daily", "sleep", "recovery", "sleep_plan", "calendar", "trend", "lift", "milestones"] as const;
  if (
    path.includes("create-activity") || path.includes("cardio-details") || path.includes("sleep-details") ||
    path.includes("recovery-details") || path.startsWith("/activities-service/v2/activities")
  ) return ACTIVITY;
  // The coach can create, edit and delete activities, journal answers and
  // templates server-side, but only in a chat turn. Opening a conversation
  // (whoop_coach_history does it just to read), image files and AI settings
  // change nothing that is cached.
  if (path.startsWith("/ai-conversation-")) {
    return /\/conversation\/[^/]+\/turn$/.test(path) ? [...ACTIVITY, "journal", "settings"] : [];
  }
  if (path.startsWith("/progression-service/v3/trends/WEIGHT/readings")) {
    // The latest reading also rewrites the profile weight (bootstrap).
    return ["trend", "weight", "profile", "settings", "daily"];
  }
  if (path.includes("/weekly-plan")) return ["trend", "weekly_plan", "daily"];
  if (
    path.includes("journal-service") || path.includes("menstrual") || path.includes("symptom") ||
    path.includes("hormonal") || path.includes("pregnancy") || path.startsWith("/womens-health-service/") ||
    path.startsWith("/activities-service/v1/journals/")
  ) {
    return ["journal", "daily", "recovery", "sleep", "trend", "settings"];
  }
  if (path.includes("weightlifting-service")) {
    // A custom exercise is a row of the 24 h exercise catalog, which lifts send verbatim.
    return path.includes("/custom-exercise") ? ["lift", "activity", "daily", "trend", "milestones", "catalog"] : ["lift", "activity", "daily", "trend", "milestones"];
  }
  if (
    path.includes("profile-service") || path.includes("hr-zones") || path.includes("smart-alarm") ||
    path.includes("hidden-metrics") || path.includes("stealth-mode") || path.startsWith("/users-service/") ||
    path.startsWith("/user-preferences-service/") || path.startsWith("/notification-service/") ||
    path.startsWith("/privacy-service")
  ) {
    return ["settings", "profile", "daily", "sleep_plan"];
  }
  // Memory writes touch nothing cached (the context hub is never cached).
  if (path.startsWith("/context-hub-bff/")) return [];
  // whoop_raw can mutate any undocumented endpoint.
  return ["all"];
}

export class WhoopClient {
  private readonly cache: RequestCache;

  constructor(private readonly config: WhoopClientConfig) {
    this.cache = new RequestCache(config.now ?? Date.now);
  }

  async get<T = unknown>(
    path: string,
    query: Record<string, QueryValue> = {},
    options: { fresh?: boolean } = {},
  ): Promise<T> {
    // `fresh` skips cached and in-flight values. Use it for reads that a write
    // merges into or compares against, since the app may have changed them.
    return this.cache.getOrLoad(cacheKey(path, query), cachePolicy(path, query, this.config.now ?? Date.now), () =>
      this.request<T>("GET", path, query, undefined),
      options.fresh,
    );
  }

  async post<T = unknown>(
    path: string,
    body: unknown,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    return this.request<T>("POST", path, query, body);
  }

  async put<T = unknown>(
    path: string,
    body: unknown,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    return this.request<T>("PUT", path, query, body);
  }

  async delete<T = unknown>(
    path: string,
    query: Record<string, QueryValue> = {},
  ): Promise<T> {
    return this.request<T>("DELETE", path, query, undefined);
  }

  /**
   * A write that also says which status WHOOP answered with (200, 201, 204…).
   * For whoop_raw, which shows a response as it was instead of assuming 200.
   */
  async write<T = unknown>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    query: Record<string, QueryValue> = {},
  ): Promise<{ status: number; body: T }> {
    const seen: { status?: number } = {};
    const result = await this.request<T>(method, path, query, method === "DELETE" ? undefined : body, seen);
    return { status: seen.status ?? 200, body: result };
  }

  /** Raw writes can target unknown resources, so callers may flush all state. */
  invalidateAll(): void {
    this.cache.invalidate(["all"]);
  }

  private async request<T>(
    method: string,
    path: string,
    query: Record<string, QueryValue>,
    body: unknown,
    seen?: { status?: number },
  ): Promise<T> {
    if (method === "GET") return this.send<T>(method, path, query, body);
    // A failed or timed-out write may still have been applied server-side, so
    // drop dependent reads whatever the outcome.
    try {
      return await this.send<T>(method, path, query, body, false, 0, seen);
    } finally {
      const tags = writeInvalidationTags(path);
      this.cache.invalidate(tags);
      // Exercise history, PRs and e1RM lag a lift or activity write (live: seconds,
      // up to ~30 s). A page read in that gap must not be replayed for its 5-min TTL.
      if (tags.includes("lift")) this.cache.holdOff("lift", LIFT_SETTLE_MS);
    }
  }

  private async send<T>(
    method: string,
    path: string,
    query: Record<string, QueryValue>,
    body: unknown,
    retried = false,
    attempt412 = 0,
    seen?: { status?: number },
  ): Promise<T> {
    assertVerbatimPath(path);
    // No `apiVersion` param: the app sent it on 0 of 5,813 requests (2026-11
    // capture), so it was totem's clearest single tell.
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }

    const token = await this.config.getToken();
    // Start from the iOS app's identity headers (user-agent, x-whoop-*, locale,
    // accept, priority — see device.ts), then layer auth and, for writes, the
    // body content-type on top so they always win. `accept-encoding` is left
    // unset on purpose: setting it manually disables undici's automatic response
    // decompression, which would break response parsing.
    const headers: Record<string, string> = {
      ...deviceHeaders(),
      authorization: `Bearer ${token}`,
    };
    let bodyString: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      bodyString = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (bodyString !== undefined) init.body = bodyString;

    let response: Response;
    let bodyText: string;
    try {
      response = await fetch(url.toString(), init);
      // fetch() resolves on the headers, so the body is read under the same
      // timer: a response that stalled mid-body used to hang forever, and every
      // identical GET joined the hung in-flight load. An error status is still
      // reported when its body can't be read.
      const { ok } = response;
      bodyText = await response.text().catch((error: unknown) => {
        if (ok) throw error;
        return "";
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401) {
      // Whoop can reject a token before its local expiry (revocation, clock
      // skew, a birthday/country profile edit). Force one refresh and retry.
      if (!retried && this.config.onUnauthorized) {
        this.config.onUnauthorized(token);
        return this.send<T>(method, path, query, body, true, attempt412, seen);
      }
      // A 401 that survives a fresh token is path-specific (WHOOP refuses some
      // endpoints for user tokens), not an expired login. Login expiry surfaces
      // from the refresh itself (WhoopAuthExpiredError in the token manager).
      throw new WhoopEndpointUnauthorizedError(path);
    }
    if (response.status === 412 && method !== "GET" && attempt412 < RETRY_412_DELAYS_MS.length) {
      // "User's cycle is concurrently being updated": WHOOP is recomputing the
      // day (often right after another write). It succeeds on retry.
      await (this.config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(RETRY_412_DELAYS_MS[attempt412]!);
      return this.send<T>(method, path, query, body, retried, attempt412 + 1, seen);
    }
    if (response.status >= 500) {
      const text = bodyText;
      throw new WhoopServerError(response.status, path, htmlTitle(text) ?? apiErrorDetail(text));
    }
    if (!response.ok) {
      const text = bodyText;
      if (response.status === 412) {
        throw new WhoopApiError(412, path, text, "WHOOP is updating this day; try again in a minute");
      }
      if (response.status === 409) {
        throw new WhoopConflictError(path, text, parseOverlaps(text), apiErrorDetail(text));
      }
      const description = apiErrorDetail(text) ??
        (response.status === 422 && !text.trim() ? "WHOOP rejected the request shape (422, no details)" : undefined);
      throw new WhoopApiError(response.status, path, text, description);
    }

    if (seen) seen.status = response.status;
    if (response.status === 204) return undefined as T;
    // Some endpoints answer 200 with an empty body, or a bare JSON literal
    // (profile PUT returns `false` when it refused the values).
    const text = bodyText;
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
}
