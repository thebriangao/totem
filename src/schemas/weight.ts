import { z } from "zod";
import { IsoDateTime } from "./primitives.js";
import { PreviewOut } from "../lib/health_plans_write.js";

/** One reading as the projection sees it (internal; tools emit compact rows). */
export interface WeightReadingT {
  id: string;
  timestamp: string;
  weight_kg: number;
  /** Percent (WHOOP stores a fraction). */
  body_fat_pct: number | null;
  lean_kg: number | null;
  source: string | null;
  /** False for integration readings (Apple Health…): deletable, not editable. */
  editable: boolean;
}

export interface WeightPageT {
  display_unit: "kg" | "lb" | null;
  readings: WeightReadingT[];
  next_token: string | null;
}

export const WEIGHT_COLUMNS = ["id", "at", "kg", "fat_pct", "lean_kg", "source"] as const;
const Cell = z.union([z.string(), z.number(), z.null()]);

export const WeightOut = z.object({
  display_unit: z.enum(["kg", "lb"]).nullable(),
  columns: z.array(z.enum(WEIGHT_COLUMNS)),
  rows: z.array(z.array(Cell)),
  next_cursor: z.string().nullable(),
});

export const WeightRow = z.object({
  at: IsoDateTime,
  kg: z.number(),
  fat_pct: z.number().nullable(),
  lean_kg: z.number().nullable(),
});

export const WeightLogReceipt = z.object({
  action: z.enum(["add", "edit", "delete"]),
  id: z.string().nullable(),
  verified: z.boolean(),
  reading: WeightRow.nullable(),
  /** bootstrap profile.weight after the write (the latest-timestamp reading sets it). */
  profile_kg: z.number().nullable(),
  warnings: z.array(z.string()),
});

export const WeightLogOut = z.union([PreviewOut, WeightLogReceipt]);
