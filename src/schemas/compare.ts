import { z } from "zod";

export const CompareOut = z.object({
  window: z.enum(["week", "month"]),
  a: z.object({ start_date: z.string(), end_date: z.iso.date() }),
  b: z.object({ start_date: z.string(), end_date: z.iso.date() }),
  metrics: z.array(z.object({
    metric: z.string(),
    a_avg: z.number().nullable(),
    b_avg: z.number().nullable(),
    delta_abs: z.number().nullable(),
    delta_pct: z.number().nullable(),
    unit: z.string().nullable(),
  })),
});
export type CompareOutT = z.infer<typeof CompareOut>;
export type CompareMetricRow = CompareOutT["metrics"][number];
