export function isoDay(d: Date = new Date()): string {
  // YYYY-MM-DD in local time (matches Whoop's day-boundary convention)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
