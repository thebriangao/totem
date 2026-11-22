// whoop_recovery: GET /home-service/v1/deep-dive/recovery?date= (score, STEPPER
// calibration, contributors), GET /coaching-service/v1/health/bff/monitor
// (today only: SpO2, skin-temp deviation), and optionally the performance
// assessment (D15 merged whoop_performance_assessment in). SPEC.md §4.2, §4.7.
import {
  contentById, contributor, displayNumber, get, isNode, nodes, pgDateRangeInclusive, stepperCalibration, str,
  type Calibration, type Node,
} from "./core_common.js";
import { recoveryStateFromStyle } from "./core_home.js";

/** A contributor vs the member's baseline; `trend` is WHOOP's verdict (HIGHER_POSITIVE, LOWER_NEGATIVE…). */
export interface VsBaseline { value: number | null; baseline: number | null; trend: string | null }

export interface HealthMonitor {
  spo2_pct: number | null;
  /** °F deviation from the member's baseline (not an absolute temperature). */
  skin_temp_dev_f: number | null;
  rr: number | null;
  rhr_bpm: number | null;
  hrv_ms: number | null;
  /** Range status per WHOOP metric id (POSITIVE_RANGE, NONE…). */
  status: Record<string, string>;
  in_range: number | null;
  with_values: number | null;
  note: string | null;
}

export interface Assessment {
  needed: boolean | null;
  has_assessment: boolean | null;
  recoveries: number | null;
  required: number | null;
  /** Inclusive date windows. */
  expected: { start: string; end: string } | null;
  next: { start: string; end: string } | null;
}

export interface RecoveryV2 {
  date: string;
  score: number | null;
  state: "GREEN" | "YELLOW" | "RED" | null;
  calibrating: boolean;
  calibration: Calibration | null;
  hrv_ms: VsBaseline;
  rhr_bpm: VsBaseline;
  rr: VsBaseline;
  sleep_perf_pct: VsBaseline;
  monitor: HealthMonitor | null;
  assessment?: { week: Assessment | null; month: Assessment | null };
}

function vsBaseline(m: Node | null): VsBaseline {
  return {
    value: m ? displayNumber(m.status) : null,
    baseline: m ? displayNumber(m.status_subtitle) : null,
    trend: m && m.status_type !== "NO_DATA" ? str(m.status_type) : null,
  };
}

export function projectRecoveryDeepDive(raw: unknown, date: string): Omit<RecoveryV2, "monitor" | "assessment"> {
  const gauge = contentById(raw, "SCORE_GAUGE", "RECOVERY_SCORE_GAUGE");
  const tile = contentById(raw, "CONTRIBUTORS_TILE", "RECOVERY_CONTRIBUTORS_TILE");
  const style = gauge ? str(gauge.progress_fill_style) : null;
  const calibration = stepperCalibration(raw);
  return {
    date,
    score: gauge ? displayNumber(gauge.score_display) : null,
    state: recoveryStateFromStyle(style),
    calibrating: style === "CALIBRATING" || (calibration !== null && calibration.filled < calibration.total),
    calibration,
    hrv_ms: vsBaseline(contributor(tile, "HRV")),
    rhr_bpm: vsBaseline(contributor(tile, "RHR")),
    rr: vsBaseline(contributor(tile, "RESPIRATORY_RATE")),
    sleep_perf_pct: vsBaseline(contributor(tile, "SLEEP_PERFORMANCE")),
  };
}

export function projectHealthMonitor(raw: unknown): HealthMonitor | null {
  if (!isNode(raw)) return null;
  const tiles = new Map<string, Node>();
  for (const item of nodes(raw.items)) {
    if (item.type === "KEY_METRIC_TILE" && isNode(item.content) && typeof item.content.id === "string") {
      tiles.set(item.content.id, item.content);
    }
  }
  const value = (id: string): number | null => displayNumber(tiles.get(id)?.key_metric_tile_stat_value_display);
  const ranges = get(raw, "analytics", "ranges");
  const status: Record<string, string> = {};
  // "NONE" is WHOOP's "no range yet" (calibrating, or no value): five of them say nothing.
  if (isNode(ranges)) for (const [k, v] of Object.entries(ranges)) if (typeof v === "string" && v !== "NONE") status[k] = v;
  const callout = nodes(raw.items).find((i) => i.type === "INFO_CALLOUT_TILE");
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    spo2_pct: value("BLOOD_OXYGEN"),
    skin_temp_dev_f: value("SKIN_TEMPERATURE_FAHRENHEIT"),
    rr: value("RESPIRATORY_RATE"),
    rhr_bpm: value("RHR"),
    hrv_ms: value("HRV"),
    status,
    in_range: num(get(raw, "analytics", "metrics_in_range")),
    with_values: num(get(raw, "analytics", "metrics_with_values")),
    note: callout ? str(get(callout, "content", "description")) : null,
  };
}

// WHOOP uses 1000 as an "unbounded" sentinel for the recovery counters.
const count = (v: unknown): number | null => (typeof v === "number" && v < 1000 ? v : null);

export function projectAssessment(raw: unknown): Assessment | null {
  if (!isNode(raw)) return null;
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    needed: bool(raw.is_assessment_needed),
    has_assessment: bool(raw.has_assessment),
    recoveries: count(raw.total_recoveries),
    required: typeof raw.required_recoveries === "number" ? raw.required_recoveries : null,
    expected: pgDateRangeInclusive(raw.expected_assessment_during),
    next: pgDateRangeInclusive(raw.next_assessment_during),
  };
}
