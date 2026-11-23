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

// Matches a UTC timestamp in any of the forms Whoop emits: "...Z", "...+0000",
// or "...+00:00" (the journal / pg-range endpoints use the +0000 form, the
// deep-dive endpoints use Z). All three mean UTC and should be localized.
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:?00)$/;
// Trailing UTC marker (Z / +0000 / +00:00) — used to strip before re-suffixing.
const UTC_SUFFIX_RE = /(?:Z|\+00:?00)$/;
// Matches both Whoop's "+0000"/"-0700" form and standard "+00:00"/"-07:00" form.
const FIXED_OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;

// Module-level cache populated by `setProfileTimezone()` at server boot. This
// is Tier 2 of the priority chain — for users who didn't set `WHOOP_TIMEZONE`
// explicitly, we auto-detect from their Whoop profile's `timezone_offset`
// (which their phone keeps current).
let cachedProfileTz: string | null = null;

export function setProfileTimezone(tzOrOffset: string | null): void {
  cachedProfileTz = tzOrOffset;
}

export function getProfileTimezone(): string | null {
  return cachedProfileTz;
}

/**
 * Resolves the timezone the server should use for outgoing timestamps.
 *
 * Priority chain:
 *   1. WHOOP_TIMEZONE env var (IANA name, explicit override)
 *   2. Cached profile offset (auto-detected from Whoop, e.g. "-0700")
 *   3. Server's system timezone (Intl default — UTC inside Docker / Fly)
 */
export function getTimezone(): string {
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const candidate of [process.env.WHOOP_TIMEZONE, cachedProfileTz, systemTz, "UTC"]) {
    if (candidate && isValidTimezone(candidate)) return candidate;
  }
  return "UTC";
}

export function isUtcIso(s: string): boolean {
  return UTC_ISO_RE.test(s);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Return the UTC offset (e.g. "-07:00") observed in `tz` at the given instant.
 * Handles IANA names (via Intl) and fixed offsets ("-0700" / "-07:00").
 */
function offsetAt(instant: Date, tz: string): string {
  const fixed = parseFixedOffset(tz);
  if (fixed) return `${fixed.sign}${fixed.hh}:${fixed.mm}`;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "+00:00";
  return `${m[1]}${m[2]!.padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
}

/**
 * Build an ISO-8601 timestamp with explicit offset for a wall-clock time on a
 * given calendar date in `tz`. Used by projections (stress, in-workout HR) whose
 * source data carries only local clock labels ("9:38 AM") with no absolute
 * timestamp.
 *
 *   wallClockIso("2026-05-30", 9, 38, "America/Los_Angeles")
 *     → "2026-05-30T09:38:00-07:00"
 *
 * The offset is resolved for that wall-clock instant, so it's DST-correct except
 * within the ~1h fold around a transition, which is immaterial here.
 */
export function wallClockIso(
  date: string,
  hour: number,
  minute: number,
  tz: string = getTimezone(),
): string {
  const wallAsUtc = new Date(`${date}T${pad2(hour)}:${pad2(minute)}:00Z`);
  if (Number.isNaN(wallAsUtc.getTime()) || !isValidTimezone(tz)) {
    return `${date}T${pad2(hour)}:${pad2(minute)}:00+00:00`;
  }
  // Resolve the offset at the represented local wall-clock instant, not at the
  // same clock fields interpreted as UTC. Iterate because crossing a DST
  // boundary can change the first candidate's offset (e.g. 03:30 on spring day).
  let offset = offsetAt(wallAsUtc, tz);
  for (let i = 0; i < 3; i++) {
    const sign = offset[0] === "-" ? -1 : 1;
    const offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
    const candidateInstant = new Date(wallAsUtc.getTime() - offsetMinutes * 60_000);
    const next = offsetAt(candidateInstant, tz);
    if (next === offset) break;
    offset = next;
  }
  return `${date}T${pad2(hour)}:${pad2(minute)}:00${offset}`;
}

/** "9:38 AM" / "11:52 PM" / "14:05" → minutes since midnight (0..1439), or null. */
export function clockLabelToMinutes(label: string | null): number | null {
  if (!label) return null;
  const m = label.trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function parseFixedOffset(s: string): { sign: "+" | "-"; hh: string; mm: string } | null {
  const m = s.match(FIXED_OFFSET_RE);
  if (!m) return null;
  if (Number(m[2]) > 23 || Number(m[3]) > 59) return null;
  return { sign: m[1] as "+" | "-", hh: m[2]!, mm: m[3]! };
}

/** Whether a configured timezone is a supported IANA name or fixed offset. */
export function isValidTimezone(tz: string): boolean {
  if (parseFixedOffset(tz)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
    return true;
  } catch {
    return false;
  }
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

  // Fixed-offset TZ ("-0700" or "-07:00") — Whoop's profile.timezone_offset uses
  // this form. Intl.DateTimeFormat only accepts IANA names, so we shift the
  // instant by the offset and format manually.
  const fixedOffset = parseFixedOffset(tz);
  if (fixedOffset) {
    const offsetMin = (Number(fixedOffset.hh) * 60 + Number(fixedOffset.mm))
      * (fixedOffset.sign === "+" ? 1 : -1);
    const shifted = new Date(date.getTime() + offsetMin * 60 * 1000);
    const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
    const Y = shifted.getUTCFullYear();
    const M = pad(shifted.getUTCMonth() + 1);
    const D = pad(shifted.getUTCDate());
    const h = pad(shifted.getUTCHours());
    const m = pad(shifted.getUTCMinutes());
    const s = pad(shifted.getUTCSeconds());
    const msMatch = utcIso.match(/\.(\d+)(?:Z|\+00:?00)$/);
    const fraction = msMatch ? `.${msMatch[1]}` : "";
    return `${Y}-${M}-${D}T${h}:${m}:${s}${fraction}${fixedOffset.sign}${fixedOffset.hh}:${fixedOffset.mm}`;
  }

  // IANA name path — uses Intl.DateTimeFormat which knows about DST transitions.
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
  const msMatch = utcIso.match(/\.(\d+)(?:Z|\+00:?00)$/);
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
  // JSON.stringify writes a Date as its ISO string. Rebuilding it key by key
  // (it has none) turned it into {} before stringify ever saw it.
  if (value instanceof Date) {
    return (Number.isNaN(value.getTime()) ? null : toLocalIso(value.toISOString(), tz)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Fields explicitly named *_utc are wire-level / audit values. Their
      // literal UTC form matters (for example write previews show precisely
      // what will be sent to Whoop), so do not turn them back into local time.
      // A write preview's `will_execute` is the exact request (compact() leaves
      // it alone for the same reason): its timestamps stay as they will be sent.
      out[k] = k.endsWith("_utc") || k === "will_execute" ? v : localizeTimestamps(v, tz);
    }
    return out as T;
  }
  return value;
}

/**
 * Returns the calendar components of an instant as observed in the user's
 * timezone. Handles both IANA names (`America/Los_Angeles`) and fixed offsets
 * (`-0700` / `-07:00`, the form Whoop's profile returns).
 *
 * This is what makes "today" correct on a UTC server: `new Date()` is the
 * right instant, but `.getDate()` would give the server's (UTC) calendar day.
 * This converts to the user's calendar day instead.
 */
export function zonedParts(
  date: Date = new Date(),
  tz: string = getTimezone(),
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const fixed = parseFixedOffset(tz);
  if (fixed) {
    const offsetMin = (Number(fixed.hh) * 60 + Number(fixed.mm)) * (fixed.sign === "+" ? 1 : -1);
    const shifted = new Date(date.getTime() + offsetMin * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some locales render midnight as 24
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), second: get("second") };
}
