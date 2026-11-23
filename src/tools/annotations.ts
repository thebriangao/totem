// MCP tool annotations (spec 2025-03-26+). Clients use these hints to sort and
// gate tools — claude.ai, for one, groups a connector's tools into read-only vs
// write/delete and lets the user set permissions per group. They are hints, not
// enforcement: the confirm:true preview gate on write tools still applies.
// Adopted from PR #37 (@a2br); the v2 classification lives on each tool.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Only reads: GETs or local catalog lookups. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** Writes that only add new records (a new activity, lift, coach chat). */
export const WRITE_ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** Writes that can overwrite, clear or delete existing data or settings. */
export const WRITE_DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

/** Mark a tool whose effects reach beyond WHOOP's typed data (raw passthrough, the coach). */
export function openWorld(base: ToolAnnotations): ToolAnnotations {
  return { ...base, openWorldHint: true };
}

/** Mark a write that is safe to repeat with the same input (same end state). */
export function idempotent(base: ToolAnnotations): ToolAnnotations {
  return { ...base, idempotentHint: true };
}
