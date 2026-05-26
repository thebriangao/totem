import { localizeTimestamps } from "../lib/timezone.js";

// Compact JSON for MCP tool responses. v2 tools produce already-projected
// data, so no stripping is needed — just rewrite UTC timestamps as local ISO
// (with explicit offset, e.g. "2026-05-25T15:30:00-07:00") and stringify.
// Driven by the WHOOP_TIMEZONE env var; falls back to the server's system TZ.
export function jsonOut(data: unknown): string {
  return JSON.stringify(localizeTimestamps(data));
}
