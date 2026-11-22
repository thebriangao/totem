// whoop_stress: GET /health-service/v2/stress-bff/{date} (~145 KB raw). Returns
// the headline (state, gauge level 0–3, label), min/peak, the day's time per
// stress band, and, opt-in, a fixed-step timeline instead of ~1,300 raw samples.
//
// The payload carries three graphs. `extended24_hour_graph` is the day's whole
// window (up to 24 h; for today it ends now). `previous_stress_graph` and
// `stress_graph` are its first and second halves, so `stress_graph` alone
// misses the earlier half of the day.
import { clockLabelToMinutes, wallClockIso } from "../../lib/timezone.js";
import {
  addDays, displayMinutes, displayNumber, get, isNode, nodes, stepperCalibration, str, type Calibration,
} from "./core_common.js";

export const STRESS_STEP_MIN = 30;

export interface StressV2 {
  date: string;
  state: string | null;
  level: number | null;
  label: string | null;
  /** Lowest and highest level over the day's graphed window (up to 24 h). */
  min: number | null;
  peak: number | null;
  calibrating: boolean;
  calibration: Calibration | null;
  /** Minutes in each band for the whole day (TOTAL DAY card); null until WHOOP has the trend. */
  band_min: { low: number | null; medium: number | null; high: number | null } | null;
  /** Mean level per 30-minute bucket from `start`; null = no samples. */
  timeline?: { start: string; step_min: number; levels: Array<number | null> };
}

type Sample = { min: number; level: number };

/** One graph's samples; `min` counts minutes from the first sample's midnight (≥ 1440 once past the next one). */
function graphSamples(raw: unknown, graph: string): Sample[] {
  const out: Sample[] = [];
  let prev: number | null = null;
  let offset = 0;
  for (const p of nodes(get(raw, graph, "graph", "plots"))) {
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

function samples(raw: unknown): Sample[] {
  const full = graphSamples(raw, "extended24_hour_graph");
  return full.length ? full : graphSamples(raw, "stress_graph");
}

/**
 * The calendar day the first sample falls on. Points only carry clock labels, and the
 * window can begin the evening before `date` (today's 24 h window does once the day is
 * under way) or run past midnight at its end (a late bedtime).
 */
function firstSampleDay(pts: Sample[], date: string, now: number): string {
  const end = pts[pts.length - 1]!.min;
  const crossed = end >= 1440;
  const endClock = end % 1440;
  const endIfStartsOnDate = Date.parse(wallClockIso(addDays(date, crossed ? 1 : 0), Math.floor(endClock / 60), endClock % 60));
  // A sample cannot be from the future, so the window began a day earlier.
  if (endIfStartsOnDate > now + 5 * 60_000) return addDays(date, -1);
  // A past day: `date` is the side of midnight that holds most of the window.
  if (crossed && end - 1440 >= 1440 - pts[0]!.min) return addDays(date, -1);
  return date;
}

export function projectStressV2(raw: unknown, date: string, withTimeline: boolean, now: number = Date.now()): StressV2 {
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
    const startDay = firstSampleDay(pts, date, now);
    out.timeline = { start: wallClockIso(startDay, Math.floor(startMin / 60), startMin % 60), step_min: STRESS_STEP_MIN, levels: values };
  }
  return out;
}
