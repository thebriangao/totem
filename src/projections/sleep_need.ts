import type { SleepNeedOutT } from "../schemas/sleep_need.js";
import { isObject, asNumber, asString, asBool } from "../lib/walk.js";

// /coaching-service/v2/sleepneed keys (documented):
//   turn_off_schedule_modal, turn_off_all_modal, chip_label_text_display,
//   alarm_schedule_state, next_schedule_day_label,
//   eligible_for_smart_alarms, need_breakdown, need_breakdown_formatted,
//   recommended_time_in_bed_formatted, menstrual_coach_enabled
//
// Note: the documented top-level has `recommended_time_in_bed_formatted` (string,
// e.g. "8h 23m") but NOT a raw-minutes field. We parse the formatted string to
// minutes. need_breakdown is the data structure with baseline/debt/strain.

function parseHourMinutesString(s: string | null): number | null {
  if (!s) return null;
  // "8h 23m" or "8h" or "23m"
  let total = 0;
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m/i);
  if (h) total += Number(h[1]) * 60;
  if (m) total += Number(m[1]);
  return total > 0 ? total : null;
}

export function projectSleepNeed(raw: unknown): SleepNeedOutT {
  const root = isObject(raw) ? raw : {};
  const need = isObject(root.need_breakdown) ? (root.need_breakdown as Record<string, unknown>) : {};
  const formatted = asString(root.recommended_time_in_bed_formatted);
  return {
    recommended_time_in_bed: formatted,
    recommended_time_in_bed_minutes:
      parseHourMinutesString(formatted) ?? asNumber(root.recommended_time_in_bed),
    need_breakdown: {
      baseline_minutes: asNumber(need.baseline),
      debt_minutes: asNumber(need.debt),
      strain_minutes: asNumber(need.strain),
      nap_credit_minutes: asNumber(need.nap_credit),
    },
    next_schedule_day: asString(root.next_schedule_day_label),
    smart_alarm_eligible: asBool(root.eligible_for_smart_alarms) ?? false,
    schedule_state: asString(root.alarm_schedule_state),
  };
}
