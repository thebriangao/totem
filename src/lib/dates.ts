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
 * Refuse times in the future. WHOOP accepts future activities and sleeps, then
 * leaves an empty cycle on that date that no API can delete (SPEC.md §7).
 * A small allowance covers clock skew between this host and WHOOP.
 */
export function assertNotFuture(iso: string, what = "time", now: number = Date.now(), skewMs = 2 * 60_000): void {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Invalid ${what}: ${iso}`);
  if (t > now + skewMs) throw new Error(`The ${what} ${iso} is in the future. WHOOP accepts future entries but then leaves an undeletable empty day behind, so totem refuses them.`);
}
