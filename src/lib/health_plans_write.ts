// Shared write-tool plumbing for the health-plans tools (weight, cycle, weekly
// plan, smart alarm): previews that carry pre-read warnings, structured tool
// errors, and the "WHOOP refused it" result (from PR #35, @ostiums).
import { z } from "zod";
import { preview, WritePreviewSchema } from "../whoop/write_safety.js";
import { apiErrorDetail, type WhoopApiError } from "../whoop/errors.js";
import { jsonOut } from "../whoop/json_out.js";
import type { ToolResult } from "../tools/define.js";

/** A write preview plus what the fresh pre-read found (warnings, current state). */
export const PreviewOut = WritePreviewSchema.extend({
  warnings: z.array(z.string()),
  current: z.unknown().optional(),
});
export type PreviewOutT = z.infer<typeof PreviewOut>;

export function previewWith(
  method: string,
  path: string,
  body: unknown,
  warnings: string[],
  current?: unknown,
): PreviewOutT {
  return { ...preview(method, path, body), warnings, ...(current === undefined ? {} : { current }) };
}

/** A tool-level validation error: the model gets the reason, WHOOP is never called. */
export function toolError(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: jsonOut({ error, ...extra }) }], isError: true };
}

/** Tool result for a write WHOOP refused: status + its reason, never the raw body. */
export function writeRejected(what: string, path: string, error: WhoopApiError, hint?: string): ToolResult {
  return toolError(`WHOOP rejected the ${what}.`, {
    status: error.status,
    endpoint: path,
    reason: apiErrorDetail(error.body) ?? null,
    ...(hint ? { hint } : {}),
  });
}

/** Name lookup miss: the closest few names by shared characters, best first. */
export function suggest(query: string, names: string[], limit = 5): string[] {
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  const score = (name: string): number => {
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (n.includes(q) || q.includes(n)) return 1000 - Math.abs(n.length - q.length);
    let common = 0;
    for (let i = 0; i < q.length - 1; i++) if (n.includes(q.slice(i, i + 2))) common++;
    return common;
  };
  return [...names].sort((a, b) => score(b) - score(a)).slice(0, limit);
}
