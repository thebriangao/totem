// Shared parsing helpers for the reads-core v2 tools (whoop_day, whoop_recovery,
// whoop_sleep, whoop_strain, whoop_stress, whoop_now, whoop_trend, whoop_calendar).
// Pure functions over WHOOP's server-driven ("BFF") payloads. Everything keys
// off stable `type` / `id` values and degrades to null instead of throwing.
import { byType, findFirst, get, parseDurationMs, parseNumber, str, type Node } from "../../whoop/bff.js";

export const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const nodes = (v: unknown): Node[] => arr(v).filter(isNode);

/** WHOOP timestamp ("…+0000", "…-08:00", microseconds) → canonical ISO UTC with ms, or null. */
export function isoInstant(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v !== "string" || v.trim() === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A display number that is not a clock value: "42" → 42, "1,234" → 1234, "0:20" / "--" → null. */
export function displayNumber(v: unknown): number | null {
  if (typeof v === "string" && /^\s*-?\d+:\d{2}/.test(v)) return null;
  return parseNumber(v);
}

/** "h:mm" / "h:mm:ss" display → ms; "-:--", "--", "" → null. */
export function displayDurationMs(v: unknown): number | null {
  return parseDurationMs(v);
}

/** Durations in reads-core outputs are minutes (shorter than ms, and what people say). */
export function msToMin(ms: number | null): number | null {
  return ms === null || !Number.isFinite(ms) ? null : Math.round(ms / 6000) / 10;
}

/** "h:mm" display → minutes; "-:--" / "--" → null. */
export function displayMinutes(v: unknown): number | null {
  return msToMin(parseDurationMs(v));
}

/** Integer ms or null (zod schemas use .int()). */
export function intOrNull(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v);
}

export function round1(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

/** Percent change of `current` vs `baseline`, one decimal. */
export function deltaPct(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null || baseline === 0) return null;
  return Math.round(((current - baseline) / baseline) * 1000) / 10;
}

/** The `content` of the first node of `type` whose content.id equals `id`. */
export function contentById(root: unknown, type: string, id: string): Node | null {
  const hit = byType(root, type).find((n) => isNode(n.content) && n.content.id === id);
  return hit && isNode(hit.content) ? hit.content : null;
}

/** A CONTRIBUTORS_TILE metric by id suffix (CONTRIBUTORS_TILE_HRV …). */
export function contributor(tile: Node | null, suffix: string): Node | null {
  if (!tile) return null;
  return nodes(tile.metrics).find((m) => typeof m.id === "string" && m.id.toUpperCase().endsWith(`_${suffix}`)) ?? null;
}

export interface Calibration { filled: number; total: number }

/** Calibration progress from the first DISCRETE STEPPER ("Wear WHOOP to sleep for 4 nights…"). */
export function stepperCalibration(root: unknown): Calibration | null {
  const step = byType(root, "STEPPER").find((n) => get(n, "content", "progress_bar", "type") === "DISCRETE");
  if (!step) return null;
  const filled = get(step, "content", "progress_bar", "discrete_filled_total");
  const total = get(step, "content", "progress_bar", "discrete_step_total");
  return typeof filled === "number" && typeof total === "number" ? { filled, total } : null;
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Postgres-style half-open date range "['2026-10-01','2026-11-01')" →
 * inclusive {start, end} ("2026-10-01".."2026-10-31"). Null when unparsable.
 */
export function pgDateRangeInclusive(v: unknown): { start: string; end: string } | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^[[(]'?(\d{4}-\d{2}-\d{2})[^',]*'?,\s*'?(\d{4}-\d{2}-\d{2})[^']*'?([\])])$/);
  if (!m) return null;
  const end = m[3] === ")" ? addDays(m[2]!, -1) : m[2]!;
  return { start: m[1]!, end };
}

export { byType, findFirst, get, parseNumber, str };
export type { Node };
