// Closed enums and small helpers for the profile and settings tools
// (SPEC.md §4.8, §7 S6–S8). WHOOP accepts junk on several of these endpoints
// (any hidden-metric string, any dashboard count), so totem enforces its own.

export const HIDDEN_METRICS = ["BODY_COMP", "HEALTHSPAN"] as const;

/** Push namespaces, case-sensitive (a lowercase one is a 400 or a silent no-op). */
export const NOTIFICATION_NAMESPACES = ["StressSummary", "GPS", "ConversationalCheckIn", "CheckIn"] as const;

/**
 * The two clock formats that were written and read back live. WHOOP's enum has
 * a third, TWELVE_HOUR_FORMAT_NO_PERIOD, known only from a 400's enum list:
 * never sent by the app, never returned. Values copied from an error message
 * are what broke Smart Alarm preferences (SPEC §7 S1), so it stays out.
 */
export const CLOCK_FORMATS = ["TWELVE_HOUR_FORMAT", "TWENTY_FOUR_HOUR_FORMAT"] as const;

/** The server's KeyMetric enum (settings §2.15). */
export const KEY_METRICS = [
  "REM_SLEEP_DURATION", "CALORIES", "STEPS", "SLEEP_PERFORMANCE", "IN_SLEEP_EFFICIENCY", "AVERAGE_HR",
  "TOTAL_VOLUME_LOAD", "RECOVERY", "DAY_STRAIN", "RHR", "HR_ZONES_4_5", "VO2_MAX", "PREGNANCY_WEEK",
  "STRAIN_AND_RECOVERY", "CGM", "RESTORATIVE_SLEEP_PERCENT", "MENSTRUAL_CYCLE_INSIGHTS", "STRESS_MONITOR",
  "SLEEP_CONSISTENCY", "HR_ZONES_ALL", "WEIGHT", "TIME_IN_BED", "STRENGTH_ACTIVITY_TIME", "HRV",
  "RESPIRATORY_RATE", "HR_ZONES_1_3", "SLEEP_NEED", "SLEEP_HOURS", "SLEEP_NEED_FROM_SLEEP_DEBT_POST",
  "BODY_COMPOSITION_LEAN",
] as const;
/** Dashboard gauge slots 0 and 2 are always these; only slots 1 and 3 are the user's. */
export const FIXED_GAUGES = ["RECOVERY", "DAY_STRAIN"] as const;
export const GAUGE_METRICS = KEY_METRICS.filter((m) => !(FIXED_GAUGES as readonly string[]).includes(m)) as unknown as readonly [string, ...string[]];

export const GENDERS = ["MALE", "FEMALE", "NON_BINARY", "PREFER_NOT"] as const;
export const BASELINES = ["MALE", "FEMALE"] as const;
export const UNIT_SYSTEMS = ["metric", "imperial"] as const;

/** Profile PUT bounds: WHOOP's UI limits (it doesn't bound height itself, and answers `false` above 272 kg). */
export const WEIGHT_KG = { min: 24, max: 272 } as const;
export const HEIGHT_M = { min: 0.91, max: 2.72 } as const;

/** "-08:00" / "-0800" / "GMT-08:00" → "-0800". */
export function normalizeOffset(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^(GMT|UTC)$/i.test(raw.trim())) return "+0000";
  const m = raw.trim().match(/([+-])(\d{1,2}):?(\d{2})?$/);
  if (!m) return null;
  return `${m[1]}${m[2]!.padStart(2, "0")}${m[3] ?? "00"}`;
}

/** The UTC offset an IANA zone has at `at`, as "-0800"; null for an unknown zone. */
export function zoneOffset(timeZone: string, at: Date = new Date()): string | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
    return normalizeOffset(part ?? null);
  } catch {
    return null;
  }
}

/**
 * The IANA zone totem would send WHOOP: WHOOP_TIMEZONE when it is a zone name,
 * else this host's zone. Same source as the x-whoop-time-zone header.
 */
export function candidateTimeZone(): string | null {
  const env = process.env.WHOOP_TIMEZONE;
  if (env && env.includes("/")) return env;
  const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return sys && sys.includes("/") ? sys : null;
}

/**
 * Community privacy pillars (sleep, recovery, strain) come back as composite
 * strings: `<audience>[_no_daily_stats|_no_trends|_score_only]`.
 */
export function decodePrivacyPillar(raw: string | null): { audience: string; trends: boolean; daily_stats: boolean } | null {
  if (!raw) return null;
  const m = raw.match(/^(everyone|friends|no_one)(_no_daily_stats|_no_trends|_score_only)?$/);
  if (!m) return null;
  const suffix = m[2] ?? "";
  return {
    audience: m[1]!,
    trends: suffix === "" || suffix === "_no_daily_stats",
    daily_stats: suffix === "" || suffix === "_no_trends",
  };
}

/** Keys that carry live OAuth URLs with a `state` nonce and the user id (S24). */
const OAUTH_KEYS = /^(connection_url|cta_connection_url|web_authorization_url|app_authorization_url)$|authorization_url|oauth/i;

/** Deep copy without OAuth URLs or `state` nonces. */
export function stripOAuth(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOAuth);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (OAUTH_KEYS.test(k)) continue;
      if (typeof v === "string" && /[?&]state=/.test(v)) continue;
      out[k] = stripOAuth(v);
    }
    return out;
  }
  return value;
}
