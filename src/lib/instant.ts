// Moments in time as the tools take them: the forms AI apps actually write,
// read the way the person means them.
//
//   2026-11-20T08:00:00Z, 2026-11-20T08:00-08:00, 2026-11-20T08:00:30.5+0530
//       an exact moment (seconds optional, any offset)
//   2026-11-20T08:00, 2026-11-20 08:00:15
//       a time on the person's own clock, in their WHOOP timezone
//
// zod's ISO datetime refused the first two common forms ("08:00" without
// seconds, and any time without an offset), and its JSON Schema carries a
// date regex of about 500 characters per field into tools/list. A plain
// string checked here costs a dozen characters and accepts what people send.
import { z } from "zod";
import { getTimezone, wallClockIso } from "./timezone.js";

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const HINT = "a time like 2026-11-20T08:00 (on your clock) or 2026-11-20T08:00-08:00";

const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

function parts(value: string): RegExpExecArray | null {
  const m = SHAPE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ok = Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= daysIn(Number(y), Number(mo)) &&
    Number(h) <= 23 && Number(mi) <= 59 && Number(s ?? 0) <= 59;
  return ok ? m : null;
}

/** A tool input for a moment in time: a plain string, checked by shape. */
export const instantInput = (): z.ZodString =>
  z.string().refine((s) => parts(s) !== null, { message: `Expected ${HINT}` }) as unknown as z.ZodString;

/** The moment as a UTC ISO string. A time without an offset is read in `tz` (the WHOOP timezone). Throws on anything else. */
export function toInstant(value: string, tz: string = getTimezone(), field = "time"): string {
  const m = parts(value);
  if (!m) throw new Error(`${field}: expected ${HINT}, not "${value}".`);
  const [, y, mo, d, h, mi, s = "00", frac = "", zone] = m;
  const date = `${y}-${mo}-${d}`;
  let iso: string;
  if (zone) {
    const offset = zone.toUpperCase() === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    iso = `${date}T${h}:${mi}:${s}${frac}${offset}`;
  } else {
    // wallClockIso finds the offset in effect at that wall-clock time (DST included).
    const offset = wallClockIso(date, Number(h), Number(mi), tz).slice(19);
    iso = `${date}T${h}:${mi}:${s}${frac}${offset}`;
  }
  return new Date(Date.parse(iso)).toISOString();
}

/** toInstant for an optional input. */
export const toInstantOpt = (value: string | undefined, field: string, tz?: string): string | undefined =>
  value === undefined ? undefined : toInstant(value, tz, field);
