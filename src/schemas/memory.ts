import { z } from "zod";
import { withPreview } from "./primitives.js";

// whoop_memory / whoop_memory_set: the coach's memory (context hub) and the
// AI settings memory switch. SPEC.md §4.10; specs/ai.md §2.10–§2.11.

export const MemoryRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  /** Left out when listing a single category (it would repeat the input). */
  category: z.string().nullable().optional(),
});
export type MemoryRowT = z.infer<typeof MemoryRow>;

export const MemoryOut = z.discriminatedUnion("view", [
  z.object({
    view: z.literal("items"),
    category: z.string(),
    categories: z.array(z.string()),
    total: z.number().int(),
    items: z.array(MemoryRow),
  }),
  z.object({
    view: z.literal("detail"),
    id: z.string(),
    title: z.string().nullable(),
    summary: z.string().nullable(),
    status: z.string().nullable(),
    started: z.string().nullable(),
    expires: z.string().nullable(),
    conversations: z.array(z.string()),
    note: z.string(),
  }),
]);
export type MemoryOutT = z.infer<typeof MemoryOut>;

export const MemorySetReceipt = z.object({
  action: z.enum(["activate", "deactivate", "delete", "enable_memory", "disable_memory"]),
  changed: z.boolean(),
  memory: MemoryRow.nullable().describe("The card after the write (before it, for a delete)."),
  memory_enabled: z.boolean().nullable(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
});
export type MemorySetReceiptT = z.infer<typeof MemorySetReceipt>;
export const MemorySetOut = withPreview(MemorySetReceipt);
