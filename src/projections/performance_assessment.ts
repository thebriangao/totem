import type { PerformanceAssessmentOutT } from "../schemas/performance.js";
import { isObject, asNumber, asString, asBool } from "../lib/walk.js";

// Whoop returns 1000 as a sentinel for the recovery counters when the count is
// effectively unbounded / not applicable (you cannot log 1000 recoveries in a
// week or month). Surface it as null instead of a misleading literal.
const RECOVERY_COUNT_SENTINEL = 1000;
function recoveryCount(v: unknown): number | null {
  const n = asNumber(v);
  return n === null || n >= RECOVERY_COUNT_SENTINEL ? null : n;
}

export function projectPerformanceAssessment(
  raw: unknown,
  period: "WEEK" | "MONTH",
): PerformanceAssessmentOutT {
  const root = isObject(raw) ? raw : {};
  return {
    period,
    is_assessment_needed: asBool(root.is_assessment_needed) ?? false,
    has_assessment: asBool(root.has_assessment) ?? false,
    total_recoveries: recoveryCount(root.total_recoveries),
    required_recoveries: asNumber(root.required_recoveries),
    recoveries_before_recent_cutoff: recoveryCount(root.recoveries_before_recent_cutoff),
    expected_assessment_during: asString(root.expected_assessment_during),
    next_assessment_during: asString(root.next_assessment_during),
  };
}
