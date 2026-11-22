// whoop_stress: GET /health-service/v2/stress-bff/{date} (~145 KB raw). Returns
// the headline (state, gauge level 0–3, label), min/peak, the day's time per
// stress band, and, opt-in, a fixed-step timeline instead of ~700 raw samples.
import { clockLabelToMinutes, wallClockIso } from "../../lib/timezone.js";
import {
  displayMinutes, displayNumber, get, isNode, nodes, stepperCalibration, str, type Calibration,
} from "./core_common.js";

export const STRESS_STEP_MIN = 30;

export interface StressV2 {
  date: string;
  state: string | null;
  level: number | null;
  label: string | null;
  min: number | null;
  peak: number | null;
  calibrating: boolean;
  calibration: Calibration | null;
  /** Minutes in each band for the whole day (TOTAL DAY card); null until WHOOP has the trend. */
  band_min: { low: number | null; medium: number | null; high: number | null } | null;
  /** Mean level per 30-minute bucket from `start`; null = no samples. */
  timeline?: { start: string; step_min: number; levels: Array<number | null> };
}

function samples(raw: unknown): Array<{ min: number; level: number }> {
  const out: Array<{ min: number; level: number }> = [];
  let prev: number | null = null;
  let offset = 0;
  for (const p of nodes(get(raw, "stress_graph", "graph", "plots"))) {
    for (const seg of nodes(get(p, "plot", "segments"))) {
      for (const pt of nodes(seg.points)) {
        const clock = clockLabelToMinutes(str(get(pt, "data_scrubber_details", "primary_contextual_display")));
        const level = displayNumber(get(pt, "data_scrubber_details", "value_display"));
        if (clock === null || level === null) continue;
        if (prev !== null && clock + offset < prev - 720) offset += 1440; // crossed midnight
        prev = clock + offset;
        out.push({ min: prev, level });
      }
    }
  }
  return out;
}

export function projectStressV2(raw: unknown, date: string, withTimeline: boolean): StressV2 {
  const root = isNode(raw) ? raw : {};
  const pts = samples(root);
  const levels = pts.map((p) => p.level);
  const cards = nodes(root.trend_list);
  const total = cards.find((c) => get(c, "header", "title_display") === "TOTAL DAY") ?? cards[0];
  const band = (b: string): number | null => displayMinutes(get(total, "trend_stats", b, "stat_display"));
  const calibration = stepperCalibration({ s: isNode(root.progress_stepper) ? [{ type: "STEPPER", content: root.progress_stepper }] : [] });
  const out: StressV2 = {
    date,
    state: str(root.stress_state),
    level: displayNumber(get(root, "gauge", "gauge_score_display")) ?? levels[levels.length - 1] ?? null,
    label: str(get(root, "gauge", "gauge_subtext_display")),
    min: levels.length ? Math.min(...levels) : null,
    peak: levels.length ? Math.max(...levels) : null,
    calibrating: root.stress_state === "CALIBRATING" || str(root.calibration_text_display) !== null,
    calibration,
    band_min: total ? { low: band("low"), medium: band("medium"), high: band("high") } : null,
  };
  if (withTimeline && pts.length) {
    const first = Math.floor(pts[0]!.min / STRESS_STEP_MIN) * STRESS_STEP_MIN;
    const buckets: number[][] = [];
    for (const p of pts) (buckets[Math.floor((p.min - first) / STRESS_STEP_MIN)] ??= []).push(p.level);
    const values: Array<number | null> = [];
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      values.push(b && b.length ? Math.round((b.reduce((s, x) => s + x, 0) / b.length) * 10) / 10 : null);
    }
    const startMin = first % 1440;
    out.timeline = { start: wallClockIso(date, Math.floor(startMin / 60), startMin % 60), step_min: STRESS_STEP_MIN, levels: values };
  }
  return out;
}
