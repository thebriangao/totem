// Preview helper for write tools. Returns a structured "would-execute" payload
// when confirm:false; the tool handler executes the actual call when confirm:true.
import { z } from "zod";

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
