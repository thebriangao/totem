import { localizeTimestamps } from "../lib/timezone.js";

// Compact JSON for MCP tool responses. Tool output is read by a model, not a
// person, so it is optimised for tokens:
//   - no whitespace
//   - null / undefined / [] / {} object properties are dropped ("absent" means
//     "not available"); array elements are never dropped (position can matter)
//   - floats are rounded to 3 decimals (WHOOP sends float32 noise such as
//     0.8726999759674072)
//   - UTC timestamps are rewritten as local ISO with an explicit offset, and a
//     zero milliseconds part (".000") is dropped
// Zod validation runs on the full shape BEFORE this (see tools/define.ts), so
// schemas stay strict while the wire stays small.
//
// Not compacted: anything under a `will_execute` key (a write preview must show
// exactly what would be sent, nulls included) and callers that pass
// { compact: false } (whoop_raw returns WHOOP's response faithfully).

const KEEP_SUBTREE_KEYS = new Set(["will_execute"]);

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

const ZERO_MS_ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.000(Z|[+-]\d{2}:\d{2})$/;

export function compact(value: unknown): unknown {
  if (typeof value === "string") return value.length <= 29 ? value.replace(ZERO_MS_ISO, "$1$2") : value;
  if (typeof value === "number") {
    return Number.isInteger(value) || !Number.isFinite(value) ? value : Math.round(value * 1000) / 1000;
  }
  if (Array.isArray(value)) return value.map(compact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (KEEP_SUBTREE_KEYS.has(k)) {
        out[k] = v;
        continue;
      }
      const c = compact(v);
      if (!isEmpty(c)) out[k] = c;
    }
    return out;
  }
  return value;
}

export function jsonOut(data: unknown, options: { compact?: boolean } = {}): string {
  const localized = localizeTimestamps(data);
  return JSON.stringify(options.compact === false ? localized : compact(localized));
}
