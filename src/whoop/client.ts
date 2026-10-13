import { BASE_URL, API_VERSION, REQUEST_TIMEOUT_MS } from "./constants.js";
import { deviceHeaders } from "./device.js";
import { isoDay } from "../lib/dates.js";
import {
  WhoopApiError,
  WhoopAuthExpiredError,
  WhoopServerError,
} from "./errors.js";

export interface WhoopClientConfig {
  /** Async function returning a fresh bearer token. Called before each request. */
  getToken: () => Promise<string>;
  /** Injectable clock for deterministic cache tests. */
  now?: () => number;
}

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

  constructor(private readonly now: () => number) {}

  async getOrLoad<T>(
    key: string,
    policy: { ttlMs: number; tags: readonly string[] } | null,
    load: () => Promise<T>,
  ): Promise<T> {
    const cached = this.values.get(key);
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
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const pending = load()
      .then((value) => {
        // Pending activities are mutable server-side objects; serving one after
        // Whoop finishes scoring it would be misleading.
        if (policy && !containsPendingState(value)) this.store(key, value, policy);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  invalidate(tags: readonly string[]): void {
    if (tags.includes("all")) {
      this.values.clear();
      this.bytes = 0;
      return;
    }
    for (const [key, entry] of this.values) {
      if (entry.tags.some((tag) => tags.includes(tag))) this.delete(key, entry);
    }
  }

  private store(key: string, value: unknown, policy: { ttlMs: number; tags: readonly string[] }): void {
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value));
    } catch {
      return; // Never let cache accounting affect a successful API response.
    }
    if (bytes > MAX_CACHE_BYTES) return;
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
  }

  private delete(key: string, entry: CacheEntry): void {
    this.values.delete(key);
    this.bytes -= entry.bytes;
  }
}

function containsPendingState(value: unknown): boolean {
  try {
    return JSON.stringify(value).toLowerCase().includes('"pending"');
  } catch {
    return true;
  }
}

function cacheKey(path: string, query: Record<string, QueryValue>): string {
  const params = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
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
  const historical = Boolean(dateHint && dateHint < isoDay(new Date(now())));
  // Freshness-sensitive endpoints must never return a completed cached value.
  if (
    path === "/health-tab-bff/v1/health-tab" ||
    path === "/activities-service/v1/user-state" ||
    path.startsWith("/health-service/v2/stress-bff/")
  ) return null;

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
  if (path.includes("community-service")) return { ttlMs: 5 * 60_000, tags: ["community"] };
  if (path.includes("bootstrap")) return { ttlMs: 10 * 60_000, tags: ["settings", "profile", "bootstrap"] };
  if (
    path.includes("hidden-metrics") ||
    path.includes("stealth-mode") ||
    path.includes("hr-zones") ||
    path.includes("smart-alarm")
  ) return { ttlMs: 10 * 60_000, tags: ["settings", "profile"] };
  if (path.includes("journal-service")) return { ttlMs: 5 * 60_000, tags: ["journal", "daily"] };
  return null;
}

function writeInvalidationTags(path: string): readonly string[] {
  if (
    path.includes("create-activity") || path.includes("cardio-details") || path.includes("sleep-details")
  ) return ["activity", "daily", "sleep", "recovery", "sleep_plan", "calendar"];
  if (path.includes("journal-service") || path.includes("menstrual") || path.includes("symptom")) {
    return ["journal", "daily", "recovery", "sleep"];
  }
  if (path.includes("weightlifting-service")) return ["lift", "activity", "daily"];
  if (path.includes("profile-service") || path.includes("hr-zones") || path.includes("smart-alarm") || path.includes("hidden-metrics")) {
    return ["settings", "profile", "daily", "sleep_plan"];
  }
  // A weight reading may also move the profile weight that bootstrap reports.
  if (path.includes("progression-service")) return ["trend", "bootstrap"];
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
  ): Promise<T> {
    return this.cache.getOrLoad(cacheKey(path, query), cachePolicy(path, query, this.config.now ?? Date.now), () =>
      this.request<T>("GET", path, query, undefined),
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

  /** Raw writes can target unknown resources, so callers may flush all state. */
  invalidateAll(): void {
    this.cache.invalidate(["all"]);
  }

  private async request<T>(
    method: string,
    path: string,
    query: Record<string, QueryValue>,
    body: unknown,
  ): Promise<T> {
    const url = new URL(BASE_URL + path);
    url.searchParams.set("apiVersion", API_VERSION);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }

    const token = await this.config.getToken();
    // Start from the iOS app's identity headers (user-agent, x-whoop-*, locale,
    // accept, priority — see device.ts), then layer auth and, for writes, the
    // body content-type on top so they always win. `accept-encoding` is left
    // unset on purpose: setting it manually disables undici's automatic response
    // decompression, which would break response.json().
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
    try {
      response = await fetch(url.toString(), init);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401) {
      throw new WhoopAuthExpiredError();
    }
    if (response.status >= 500) {
      throw new WhoopServerError(response.status, path);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let description: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error_description?: string; error?: string };
        description = parsed.error_description ?? parsed.error;
      } catch {
        // body not JSON
      }
      throw new WhoopApiError(response.status, path, text, description);
    }

    const result = response.status === 204 ? undefined as T : (await response.json()) as T;
    if (method !== "GET") this.cache.invalidate(writeInvalidationTags(path));
    return result;
  }
}
