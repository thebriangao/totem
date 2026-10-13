import { zonedParts } from "./timezone.js";

export function isoDay(d: Date = new Date()): string {
  // YYYY-MM-DD in the USER's timezone, not the server's. On a UTC host (Fly,
  // Docker) `d.getDate()` returns the UTC calendar day — a day ahead of the
  // user's local day during their evening, so "today" queries broke. zonedParts
  // resolves the calendar day in the configured WHOOP_TIMEZONE / profile TZ.
  const { year, month, day } = zonedParts(d);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function todayIso(): string {
  return isoDay(new Date());
}

export interface PgRange {
  start: string;
  end: string | null;
}

export function parsePgRange(s: string): PgRange {
  // Closed-end: "['2026-05-23T07:35:46.220Z','2026-05-23T15:35:33.560Z')"
  // Open-end:   "['2026-05-23T07:35:46.220Z',)"
  const closed = s.match(/^[\[\(]'([^']+)','([^']+)'[\]\)]$/);
  if (closed) return { start: closed[1]!, end: closed[2]! };
  const open = s.match(/^[\[\(]'([^']+)',\)?[\]\)]?$/);
  if (open) return { start: open[1]!, end: null };
  throw new Error(`Invalid PG range string: ${s}`);
}

export function rangeFromDays(days: number, now: Date = new Date()): { start: string; end: string } {
  const end = now;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Canonical timestamp form required by several undocumented Whoop write APIs. */
export function canonicalUtc(iso: string | number | Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid timestamp; expected an ISO-8601 datetime with an offset.");
  return date.toISOString();
}

/**
 * ISO-8601 with offset → Joda's `yyyy-MM-dd'T'HH:mm:ss.SSSZ` ("2026-10-13T09:30:00.000+0300"),
 * the form the WHOOP app sends for manual trend readings. Wall clock and offset are kept as given.
 */
export function jodaTimestamp(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/);
  if (!m) throw new Error(`Invalid timestamp "${iso}"; expected an ISO-8601 datetime with an offset.`);
  const [, dateHourMinute, sec = "00", frac = "", zone] = m;
  const ms = frac.padEnd(3, "0").slice(0, 3);
  const offset = zone === "Z" ? "+0000" : zone!.replace(":", "").padEnd(5, "0");
  return `${dateHourMinute}:${sec}.${ms}${offset}`;
}
