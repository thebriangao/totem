// Result helpers for write tools.
import { z } from "zod";
import { apiErrorDetail, type WhoopApiError } from "./errors.js";
import { jsonOut } from "./json_out.js";

export const WritePreviewSchema = z.object({
  preview: z.literal(true),
  will_execute: z.object({
    method: z.string(),
    path: z.string(),
    body_summary: z.unknown(),
  }),
  set_confirm_true_to_run: z.literal(true),
});
export type WritePreview = z.infer<typeof WritePreviewSchema>;

/** Structured "would-execute" payload for confirm:false; the handler runs the call on confirm:true. */
export function preview(
  method: string,
  path: string,
  bodySummary: unknown,
): WritePreview {
  return {
    preview: true,
    will_execute: { method, path, body_summary: bodySummary },
    set_confirm_true_to_run: true,
  };
}

export function withPreview<T extends z.ZodTypeAny>(receipt: T) {
  return z.union([WritePreviewSchema, receipt]);
}

/** Tool result for a write WHOOP refused: status + its reason, never the raw body. */
export function writeRejected(what: string, path: string, error: WhoopApiError, hint?: string) {
  return {
    content: [{ type: "text" as const, text: jsonOut({
      error: `WHOOP rejected the ${what}.`,
      status: error.status,
      endpoint: path,
      reason: apiErrorDetail(error.body) ?? null,
      ...(hint ? { hint } : {}),
    }) }],
    isError: true as const,
  };
}
