// MCP tool annotations (spec 2025-03-26+). Clients use these hints to sort and
// gate tools — claude.ai, for one, groups a connector's tools into read-only vs
// write/delete and lets the user set permissions per group. They are hints, not
// enforcement: the confirm:true preview gate on write tools still applies.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Only reads: GETs or local catalog lookups. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

/** Writes that only add new records (a new activity, lift, template, coach chat). */
export const WRITE_ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };

/** Writes that can overwrite, clear or delete existing data or settings. */
export const WRITE_DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };
