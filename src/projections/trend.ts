import type { TrendOutT } from "../schemas/trend.js";
import { isObject, asArray, asNumber, asString, labelToNumber } from "../lib/walk.js";

// Whoop's /progression-service/v3/trends/{metric} returns named segments:
//   week_time_segment / month_time_segment / six_month_time_segment / year_time_segment
// Each has shape:
//   {
//     date_picker: { current_date_range_display, next_date_time, previous_date_time },
//     metrics: [{ trend_key, metric_name_display, metric_value_display,
//                 metric_units_display, trend_direction, trend_text_display,
//                 current_metric_value, previous_metric_value, metric_change }],
//     graph: { plots: [{ plot: { segments: [{ points: [{ graph_label.label, data_scrubber_details:{ primary_contextual_display, value_display } }] }] } }] },
//     is_hidden
//   }
//
// CRITICAL: metrics is an ARRAY (one entry per overlaid metric). Not an object.
// The data_scrubber_details.value is null on every point — the actual number is
// in value_display (string) and graph_label.label (string).

const NAMED_KEYS = [
  "week_time_segment",
  "month_time_segment",
  "six_month_time_segment",
  "year_time_segment",
] as const;
type WindowLabel = "week" | "month" | "six_month" | "year";

function labelFromKey(k: string): WindowLabel {
  if (k.startsWith("week")) return "week";
  if (k.startsWith("month")) return "month";
  if (k.startsWith("six_month")) return "six_month";
  return "year";
}

interface PointOut {
  date: string;
  value: number | null;
  value_display: string | null;
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
        const graphLabel = isObject(pt.graph_label) ? (pt.graph_label as Record<string, unknown>) : null;
        const label = graphLabel ? asString(graphLabel.label) : null;
        const dsd = isObject(pt.data_scrubber_details) ? (pt.data_scrubber_details as Record<string, unknown>) : {};
        const valueDisplay = asString(dsd.value_display) ?? label;
        const date = asString(dsd.primary_contextual_display) ?? "";
        out.push({
          date,
          value: labelToNumber(valueDisplay) ?? asNumber(dsd.value),
          value_display: valueDisplay,
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
        value: labelToNumber(label),
        value_display: label,
      });
    }
  }
  return out;
}

export function projectTrend(raw: unknown, metric: TrendOutT["metric"], endDate: string): TrendOutT {
  const root = isObject(raw) ? raw : {};
  const segments: TrendOutT["segments"] = [];

  function pushSegment(label: WindowLabel, s: Record<string, unknown>) {
    if (s.is_hidden === true) return;
    const dp = isObject(s.date_picker) ? (s.date_picker as Record<string, unknown>) : {};
    // Metrics is an array; take the first (primary) row.
    const metricsArr = asArray(s.metrics);
    const m0 = isObject(metricsArr[0]) ? (metricsArr[0] as Record<string, unknown>) : null;
    const avg = m0 ? asNumber(m0.current_metric_value) : null;
    const previous = m0 ? asNumber(m0.previous_metric_value) : null;
    const deltaPct = m0 ? asNumber(m0.metric_change) : null;
    const unit = m0 ? asString(m0.metric_units_display) : null;
    const points = extractPoints(s.graph);
    const numericPoints = points.map((p) => p.value).filter((v): v is number => v !== null);
    segments.push({
      label,
      start_date: asString(dp.current_date_range_display) ?? "",
      end_date: asString(dp.next_date_time) ?? "",
      avg,
      min: numericPoints.length > 0 ? Math.min(...numericPoints) : null,
      max: numericPoints.length > 0 ? Math.max(...numericPoints) : null,
      delta_pct: deltaPct,
      unit,
      points,
    });
    // previous unused for now — exposed via delta_pct
    void previous;
  }

  if (Array.isArray(root.time_segments)) {
    for (const [i, s] of (root.time_segments as Record<string, unknown>[]).entries()) {
      const labels = ["week", "month", "six_month", "year"] as const;
      const label = labels[i] ?? "year";
      pushSegment(label, s);
    }
  }
  for (const k of NAMED_KEYS) {
    const seg = root[k];
    if (isObject(seg)) pushSegment(labelFromKey(k), seg as Record<string, unknown>);
  }

  return {
    metric,
    end_date: endDate,
    segments,
    cardio_fitness_level: asString(root.cardio_fitness_level),
  };
}
