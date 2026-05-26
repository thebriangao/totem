import { z } from "zod";

export const PerformanceAssessmentOut = z.object({
  period: z.enum(["WEEK", "MONTH"]),
  is_assessment_needed: z.boolean(),
  has_assessment: z.boolean(),
  total_recoveries: z.number().int().nullable(),
  required_recoveries: z.number().int().nullable(),
  recoveries_before_recent_cutoff: z.number().int().nullable(),
  expected_assessment_during: z.string().nullable(),
  next_assessment_during: z.string().nullable(),
});
export type PerformanceAssessmentOutT = z.infer<typeof PerformanceAssessmentOut>;
