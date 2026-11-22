// Auto-detect the user's timezone from their Whoop profile on server boot,
// then cache it for use by jsonOut's timestamp localization. Tier 2 of the
// timezone resolution chain (see src/lib/timezone.ts):
//   1. WHOOP_TIMEZONE env var (explicit override)
//   2. THIS — Whoop profile timezone_offset (zero-config auto-detect)
//   3. System TZ (fallback if both above miss)
//
// Server startup doesn't block on the lookup. Until it lands getTimezone()
// falls through to the system TZ, which is UTC on a container host, so:
//   - tool calls wait (briefly, bounded) for the FIRST lookup via
//     timezoneSettled(), instead of computing "today" in UTC;
//   - a lookup that fails is retried within seconds, not at the next hourly
//     refresh.
//
// Refreshed every REFRESH_INTERVAL_MS (default: 1 hour) so a traveler whose
// phone updates their Whoop TZ mid-trip gets the new offset within an hour
// without restarting the server.

import type { WhoopClient } from "./client.js";
import { isValidTimezone, setProfileTimezone } from "../lib/timezone.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** Waits after consecutive failed lookups; past the list it is back to hourly. */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000] as const;
/** The longest a tool call is held for the first lookup. */
const FIRST_LOOKUP_WAIT_MS = 3_000;

/** The profile's offset, null when the profile has none, or "failed" when the lookup itself did. */
async function fetchProfileTimezone(client: WhoopClient): Promise<string | null | "failed"> {
  try {
    const bootstrap = await client.get("/users-service/v2/bootstrap");
    if (!bootstrap || typeof bootstrap !== "object") return null;
    const profile = (bootstrap as Record<string, unknown>).profile;
    if (!profile || typeof profile !== "object") return null;
    const offset = (profile as Record<string, unknown>).timezone_offset;
    return typeof offset === "string" && isValidTimezone(offset) ? offset : null;
  } catch {
    return "failed";
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped on every start/stop so a lookup still in flight from an earlier run can't reschedule itself.
let run = 0;
let settled: Promise<void> = Promise.resolve();

/**
 * Start the background profile-TZ auto-detect loop. Safe to call multiple
 * times — subsequent calls cancel the previous loop first. The initial fetch
 * fires immediately (not awaited) and the loop refreshes every hour.
 *
 * Skipped entirely if WHOOP_TIMEZONE is set — env var wins and we don't need
 * to spend API calls keeping the cache warm.
 */
export function startTimezoneAutoDetect(client: WhoopClient): void {
  if (process.env.WHOOP_TIMEZONE && isValidTimezone(process.env.WHOOP_TIMEZONE)) return;

  stopTimezoneAutoDetect();
  const thisRun = run;
  let failures = 0;

  const refresh = async (): Promise<void> => {
    const tz = await fetchProfileTimezone(client);
    if (thisRun !== run) return;
    let next: number = REFRESH_INTERVAL_MS;
    if (tz === "failed") {
      next = RETRY_DELAYS_MS[failures] ?? REFRESH_INTERVAL_MS;
      failures++;
    } else {
      failures = 0;
      if (tz) setProfileTimezone(tz);
    }
    refreshTimer = setTimeout(() => void refresh(), next);
    refreshTimer.unref?.();
  };

  const first = refresh();
  settled = new Promise<void>((resolve) => {
    const cap = setTimeout(resolve, FIRST_LOOKUP_WAIT_MS);
    cap.unref?.();
    void first.finally(() => {
      clearTimeout(cap);
      resolve();
    });
  });
}

/**
 * Resolves once the first profile lookup after start has finished (whatever its
 * outcome) or FIRST_LOOKUP_WAIT_MS has passed; immediately if auto-detect isn't
 * running or has already settled. Tool handlers await it so the first request
 * after a cold start doesn't read "today" off the host's UTC clock.
 */
export function timezoneSettled(): Promise<void> {
  return settled;
}

export function stopTimezoneAutoDetect(): void {
  run++;
  settled = Promise.resolve();
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}
