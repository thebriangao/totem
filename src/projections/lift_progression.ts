import type { LiftProgressionOutT } from "../schemas/strength.js";
import { isObject, asArray, asNumber, asString, labelToNumber } from "../lib/walk.js";

// Whoop's /progression-service/v3/exercise/{id} mirrors the trend endpoint shape:
//   {week,month,six_month,year}_time_segment with same metrics-array + graph layout.
// metrics array entry shape: { current_metric_value, previous_metric_value,
// metric_change, metric_units_display, metric_name_display, ... }

const NAMED_KEYS = [
  "week_time_segment",
  "month_time_segment",
  "six_month_time_segment",
  "year_time_segment",
] as const;

interface PointOut {
  date: string;
  volume: number | null;
  reps: number | null;
  top_weight: number | null;
}

function extractPoints(graph: unknown): PointOut[] {
  const g = isObject(graph) ? graph : {};
  const out: PointOut[] = [];
  for (const p of asArray(g.plots)) {
    if (!isObject(p)) continue;
    const plot = isObject(p.plot) ? (p.plot as Record<string, unknown>) : null;
    if (!plot) continue;
    for (const seg of asArray(plot.segments)) {
      if (!isObject(seg)) continue;
      for (const pt of asArray(seg.points)) {
        if (!isObject(pt)) continue;
        const dsd = isObject(pt.data_scrubber_details) ? (pt.data_scrubber_details as Record<string, unknown>) : {};
        const graphLabel = isObject(pt.graph_label) ? (pt.graph_label as Record<string, unknown>) : null;
        const labelStr = graphLabel ? asString(graphLabel.label) : null;
        const valueDisplay = asString(dsd.value_display) ?? labelStr;
        out.push({
          date: asString(dsd.primary_contextual_display) ?? "",
          volume: labelToNumber(valueDisplay) ?? asNumber(dsd.value),
          reps: null,
          top_weight: null,
        });
      }
    }
    for (const grp of asArray(plot.bar_groups)) {
      if (!isObject(grp)) continue;
      const topLabel = isObject(grp.top_label) ? (grp.top_label as Record<string, unknown>) : null;
      const label = topLabel ? asString(topLabel.label) : null;
      const dsd = isObject(grp.data_scrubber_details) ? (grp.data_scrubber_details as Record<string, unknown>) : {};
      out.push({
        date: asString(dsd.primary_contextual_display) ?? "",
        volume: labelToNumber(label),
        reps: null,
        top_weight: null,
      });
    }
  }
  return out;
}

export function projectLiftProgression(raw: unknown, exerciseId: string, endDate: string): LiftProgressionOutT {
  const root = isObject(raw) ? raw : {};
  const segments: LiftProgressionOutT["segments"] = [];

  function pushSeg(label: "week" | "month" | "six_month" | "year", s: Record<string, unknown>) {
    if (s.is_hidden === true) return;
    const dp = isObject(s.date_picker) ? (s.date_picker as Record<string, unknown>) : {};
    const metricsArr = asArray(s.metrics);
    const m0 = isObject(metricsArr[0]) ? (metricsArr[0] as Record<string, unknown>) : null;
    segments.push({
      label,
      start_date: asString(dp.current_date_range_display) ?? "",
      end_date: asString(dp.next_date_time) ?? "",
      avg_volume: m0 ? asNumber(m0.current_metric_value) : null,
      delta_pct: m0 ? asNumber(m0.metric_change) : null,
      unit: m0 ? asString(m0.metric_units_display) : null,
      points: extractPoints(s.graph),
    });
  }

  if (Array.isArray(root.time_segments)) {
    for (const [i, s] of (root.time_segments as Record<string, unknown>[]).entries()) {
      const labels = ["week", "month", "six_month", "year"] as const;
      const label = labels[i] ?? "year";
      pushSeg(label, s);
    }
  }
  for (const k of NAMED_KEYS) {
    const seg = root[k];
    if (isObject(seg)) {
      const label =
        k.startsWith("week") ? "week" :
        k.startsWith("month") ? "month" :
        k.startsWith("six") ? "six_month" : "year";
      pushSeg(label, seg as Record<string, unknown>);
    }
  }

  return { exercise_id: exerciseId, end_date: endDate, segments };
}
