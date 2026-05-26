import type { PerformanceAssessmentOutT } from "../schemas/performance.js";
import { isObject, asNumber, asString, asBool } from "../lib/walk.js";

export function projectPerformanceAssessment(
  raw: unknown,
  period: "WEEK" | "MONTH",
): PerformanceAssessmentOutT {
  const root = isObject(raw) ? raw : {};
  return {
    period,
    is_assessment_needed: asBool(root.is_assessment_needed) ?? false,
    has_assessment: asBool(root.has_assessment) ?? false,
    total_recoveries: asNumber(root.total_recoveries),
    required_recoveries: asNumber(root.required_recoveries),
    recoveries_before_recent_cutoff: asNumber(root.recoveries_before_recent_cutoff),
    expected_assessment_during: asString(root.expected_assessment_during),
    next_assessment_during: asString(root.next_assessment_during),
  };
}
