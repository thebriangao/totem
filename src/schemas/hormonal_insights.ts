import { z } from "zod";
import { PreviewOut } from "../lib/health_plans_write.js";

export const MENSTRUATION = ["none", "light_flow", "medium_flow", "heavy_flow", "spotting"] as const;
export const CERVICAL_MUCUS = [
  "vaginal-dryness",
  "vaginal-discharge---egg-white",
  "vaginal-discharge---sticky",
  "vaginal-discharge---creamy",
  "vaginal-discharge---watery",
  "cervical_mucus_pink_brown_or_tan",
  "vaginal-discharge---grey",
] as const;

const N = z.number().nullable();

export const CycleSummary = z.object({
  /** Header title, e.g. "Cycle Day 21", "Period Day 2", "On Hormonal Birth Control". */
  status: z.string().nullable(),
  /** Header description when it isn't the parsed next-period window (e.g. "Since November 21, 2026"). */
  detail: z.string().nullable(),
  phase: z.string().nullable(),
  cycle_day: z.number().int().nullable(),
  period_day: z.number().int().nullable(),
  next_period: z.object({ min_days: N, max_days: N }).nullable(),
  today: z.object({ state: z.string().nullable(), phase: z.string().nullable(), symptoms: z.boolean() }).nullable(),
  journal: z.object({ symptoms: z.array(z.string()), period: z.array(z.string()), ovulation: z.array(z.string()) }),
  typical: z.object({ period_days: N, cycle_days: N, variation_days: N }),
});
export type CycleSummaryT = z.infer<typeof CycleSummary>;

/** Run-length calendar for the month: [from_day, to_day, day_state, phase]. */
export const CycleCalendar = z.object({
  month: z.string(),
  runs: z.array(z.tuple([z.number().int(), z.number().int(), z.string().nullable(), z.string().nullable()])),
  symptom_days: z.array(z.number().int()),
});
export type CycleCalendarT = z.infer<typeof CycleCalendar>;

export const HormonalSettings = z.object({
  enabled: z.boolean().nullable(),
  trends_overlay: z.boolean().nullable(),
  mode: z.string().nullable(),
  contraception: z.string().nullable(),
  goals: z.array(z.string()),
});
export type HormonalSettingsT = z.infer<typeof HormonalSettings>;

export const CycleEntry = z.object({
  start: z.iso.date().nullable(),
  end: z.iso.date().nullable(),
  days: z.number().int().nullable(),
  period_days: z.number().int(),
  current: z.boolean(),
  hidden: z.boolean(),
});
export type CycleEntryT = z.infer<typeof CycleEntry>;

export const SymptomSegment = z.object({
  logged: z.number().int().nullable(),
  rows: z.array(z.object({ name: z.string(), logs: z.number().int().nullable(), next: z.string().nullable() })),
});
export type SymptomSegmentT = z.infer<typeof SymptomSegment>;

export const SymptomInput = z.object({
  id: z.number().int(),
  name: z.string(),
  yes: z.boolean().nullable(),
  mag: z.number().nullable(),
});
export type SymptomInputT = z.infer<typeof SymptomInput>;

export const DayLog = z.object({
  flow: z.string().nullable(),
  mucus: z.string().nullable(),
  symptoms: z.array(SymptomInput),
});
export type DayLogT = z.infer<typeof DayLog>;

export const CycleOut = z.object({
  date: z.iso.date(),
  available: z.boolean(),
  reason: z.string().nullable(),
  source: z.enum(["hormonal_insights", "menstrual_cycle_insights"]).nullable(),
  cycle: CycleSummary.nullable(),
  calendar: CycleCalendar.nullable().optional(),
  settings: HormonalSettings.nullable().optional(),
  cycles: z.array(CycleEntry).nullable().optional(),
  symptoms: z.object({ current: SymptomSegment.nullable(), last_3: SymptomSegment.nullable() }).nullable().optional(),
  day_log: DayLog.nullable().optional(),
});

export const CycleLogReceipt = z.object({
  date: z.iso.date(),
  verified: z.boolean(),
  day: z.object({
    period_day: z.boolean().nullable(),
    ovulation: z.boolean().nullable(),
    status: z.string().nullable(),
    flow: z.string().nullable(),
    mucus: z.string().nullable(),
    symptoms: z.array(SymptomInput),
  }),
  mismatches: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const CycleLogOut = z.union([PreviewOut, CycleLogReceipt]);
