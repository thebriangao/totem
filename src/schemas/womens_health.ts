import { z } from "zod";
import { withPreview } from "./primitives.js";

export const CycleOut = z.object({
  date: z.iso.date(),
  phase: z.string().nullable().describe("e.g. Menstrual, Follicular, Luteal."),
  cycle_day: z.number().int().nullable(),
  cycle_length: z.number().int().nullable(),
  next_period_predicted_date: z.iso.date().nullable(),
  ovulation_predicted_date: z.iso.date().nullable(),
  hormonal_mode: z.string().nullable(),
  contraception_type: z.string().nullable(),
  is_pregnant: z.boolean().nullable(),
});
export type CycleOutT = z.infer<typeof CycleOut>;

export const CycleLogOut = withPreview(z.object({
  logged: z.literal(true),
  date: z.iso.date(),
}));

export const SymptomLogOut = withPreview(z.object({
  logged: z.literal(true),
  date: z.iso.date(),
  symptoms_count: z.number().int(),
}));
