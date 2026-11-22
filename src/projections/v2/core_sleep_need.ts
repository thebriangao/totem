// GET /coaching-service/v2/sleepneed (SPEC.md §4.2). It depends on Smart Alarm
// preferences and 500s when those are broken, so callers fetch it with a catch
// and pass null through.
import { get, isNode, msToMin, str } from "./core_common.js";

/** Minutes throughout. */
export interface SleepNeed {
  total_min: number | null;
  baseline_min: number | null;
  debt_min: number | null;
  strain_min: number | null;
  /** Credit from today's naps (lowers the need). */
  naps_min: number | null;
  /** Recommended time in bed per sleep goal: peak = 100 %, perform = 85 %, get_by = 70 % of need. */
  in_bed_min: { peak: number | null; perform: number | null; get_by: number | null };
  smart_alarm_eligible: boolean | null;
  alarm_state: string | null;
}

const min = (v: unknown): number | null => (typeof v === "number" ? msToMin(v) : null);
const whole = (v: number | null): number | null => (v === null ? null : Math.round(v));

export function projectSleepNeedV2(raw: unknown): SleepNeed | null {
  if (!isNode(raw) || !isNode(raw.need_breakdown)) return null;
  const need = raw.need_breakdown;
  const tier = (key: string): number | null => whole(min(get(raw, "recommended_time_in_bed_formatted", key, "recommended_time_in_bed")));
  return {
    total_min: whole(min(need.total)),
    baseline_min: whole(min(need.baseline)),
    debt_min: whole(min(need.debt)),
    strain_min: whole(min(need.strain)),
    naps_min: whole(min(need.naps)),
    in_bed_min: { peak: tier("100"), perform: tier("85"), get_by: tier("70") },
    smart_alarm_eligible: typeof raw.eligible_for_smart_alarms === "boolean" ? raw.eligible_for_smart_alarms : null,
    alarm_state: str(raw.alarm_schedule_state),
  };
}
