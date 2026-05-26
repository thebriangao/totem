// Convert Whoop's UTC timestamps (which end in "Z") to ISO 8601 strings with
// an explicit offset for the user's timezone (e.g., "2026-05-25T15:30:00-07:00").
//
// Why: Whoop returns every timestamp in UTC, so without conversion the AI sees
// "22:30:00Z" and (correctly) treats it as 10:30 PM UTC. For Brian in San Jose
// at PDT/UTC-7 that's actually 3:30 PM local, but the AI can't infer that
// without knowing the user's TZ.
//
// Approach: write the explicit offset into every timestamp so it's unambiguous.
// "2026-05-25T15:30:00-07:00" means "3:30 PM in a -07:00 zone" — same instant
// as the original UTC timestamp, but the AI now knows the local clock value
// without needing extra context.
//
// Config:
//   WHOOP_TIMEZONE=America/Los_Angeles   (IANA name; default = system TZ)
//
// Date-only strings ("2026-05-25") and timestamps that already carry an offset
// pass through unchanged — only "*Z" UTC timestamps are converted.

const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function getTimezone(): string {
  return process.env.WHOOP_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isUtcIso(s: string): boolean {
  return UTC_ISO_RE.test(s);
}

/**
 * Convert a UTC ISO timestamp ("2026-05-25T22:30:00.000Z") to the user's local
 * timezone, formatted as ISO 8601 with explicit offset
 * ("2026-05-25T15:30:00-07:00"). Preserves millisecond precision if present.
 *
 * Invalid input is returned unchanged (defensive — we'd rather pass through
 * something funky than throw and break the whole tool call).
 */
export function toLocalIso(utcIso: string, tz: string = getTimezone()): string {
  if (!isUtcIso(utcIso)) return utcIso;
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return utcIso;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const Y = get("year");
  const M = get("month");
  const D = get("day");
  // Intl.DateTimeFormat with hour12:false sometimes returns "24" for midnight
  // in certain locales — normalize to "00".
  let h = get("hour");
  if (h === "24") h = "00";
  const m = get("minute");
  const s = get("second");

  // Preserve sub-second precision from the original.
  const msMatch = utcIso.match(/\.(\d+)Z$/);
  const fraction = msMatch ? `.${msMatch[1]}` : "";

  const offsetRaw = get("timeZoneName"); // "GMT-07:00" or "GMT" for UTC
  let offset = "+00:00";
  const match = offsetRaw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (match) {
    const sign = match[1];
    const hh = match[2]!.padStart(2, "0");
    const mm = (match[3] ?? "00").padStart(2, "0");
    offset = `${sign}${hh}:${mm}`;
  }

  return `${Y}-${M}-${D}T${h}:${m}:${s}${fraction}${offset}`;
}

/**
 * Walk an arbitrary JSON-ish value and convert every UTC-ISO string to local
 * time. Non-string values are returned as-is. Object keys are preserved.
 *
 * This is the single function `jsonOut()` calls — it covers every tool's
 * response without each projection needing to know about timezones.
 */
export function localizeTimestamps<T>(value: T, tz: string = getTimezone()): T {
  if (typeof value === "string") {
    return (isUtcIso(value) ? toLocalIso(value, tz) : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => localizeTimestamps(item, tz)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = localizeTimestamps(v, tz);
    }
    return out as T;
  }
  return value;
}
