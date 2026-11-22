// whoop_trend: GET /progression-service/v3/trends/{metric}?endDate= (SPEC.md §4.7).
// Every response carries exactly three windows (week, month, six_month; no year).
// Windows are inclusive and end on endDate. Daily metrics span 7 / 30 / 180 days;
// WHOOP's weekly-total metrics (HR zones, strength time) span 7 / 28 / 175 days.
// The window start therefore comes from WHOOP's own range label when that label
// ends on endDate, and from the day counts otherwise (date_picker.next_date_time
// is not the window's start).
// Duration metrics (unit "hr", "h:mm" displays, ms on the wire) come out in minutes.
import { addDays, displayMinutes, displayNumber, get, isNode, msToMin, nodes, str, type Node } from "./core_common.js";

export const TREND_WINDOWS = ["week", "month", "six_month"] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
export const WINDOW_DAYS: Record<TrendWindow, number> = { week: 7, month: 30, six_month: 180 };
const SEGMENT_KEY: Record<TrendWindow, string> = {
  week: "week_time_segment",
  month: "month_time_segment",
  six_month: "six_month_time_segment",
};

export function windowBounds(endDate: string, window: TrendWindow): { start: string; end: string } {
  return { start: addDays(endDate, -(WINDOW_DAYS[window] - 1)), end: endDate };
}

export interface TrendRow {
  key: string | null;
  /** WHOOP's own average for the window; null when WHOOP shows "---". */
  avg: number | null;
  prev_avg: number | null;
  change_pct: number | null;
  direction: string | null;
  unit: string | null;
  /** Set when WHOOP's figure is a weekly total ("WEEKLY TOTAL" / "AVG. WEEKLY TOTAL"), not a daily average. */
  per?: "week";
}

export interface TrendWindowOut {
  start: string;
  end: string;
  hidden: boolean;
  rows: TrendRow[];
  /** Strain/sleep "breakdown" bars: [label, days]. */
  breakdown: Array<[string, number | null]> | null;
  /** One value per day from `start` (null = no data). */
  points?: { start: string; step: "day"; values: Array<number | null> };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isClock = (s: unknown): boolean => typeof s === "string" && /^\d+:\d{2}$/.test(s.trim());
const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string): number => Math.round(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);

function row(m: Node): TrendRow {
  const unit = str(m.metric_units_display);
  const duration = unit === "hr" || isClock(m.metric_value_display);
  const conv = (v: unknown): number | null => (duration ? msToMin(num(v)) : num(v));
  const out: TrendRow = {
    key: str(m.trend_key),
    avg: conv(m.current_metric_value),
    prev_avg: conv(m.previous_metric_value),
    change_pct: num(m.metric_change),
    direction: m.trend_direction === "NONE" ? null : str(m.trend_direction),
    unit: duration ? "min" : unit,
  };
  if (/WEEKLY/i.test(str(m.metric_name_display) ?? "")) out.per = "week";
  return out;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DATE_TOKEN = /([A-Z]{3})[A-Z]*\s+(\d{1,2})(?:,\s*(\d{4}|\d{2})\b)?/g;

/**
 * The dates in a WHOOP label, in order: "SUN, MAY 17", "TUE, NOV 25, 2025", a range's
 * "OCT 25 - NOV 21, 26" or "DEC 28, 26 - JAN 3, 27". A date without a year takes the
 * latest year that does not put its month after the window's end.
 */
function labelDates(label: string | null, endDate: string): string[] {
  if (!label) return [];
  const endYear = Number(endDate.slice(0, 4));
  const endMonth = Number(endDate.slice(5, 7)) - 1;
  const out: string[] = [];
  for (const m of label.toUpperCase().matchAll(DATE_TOKEN)) {
    const month = MONTHS.indexOf(m[1]!);
    if (month < 0) continue;
    const explicit = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    const year = explicit ?? (month > endMonth ? endYear - 1 : endYear);
    out.push(`${year}-${String(month + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`);
  }
  return out;
}

/** "SUN, MAY 17" / "TUE, NOV 25, 2025" → ISO date, taking the year from the window's end. */
export function pointDate(label: string | null, endDate: string): string | null {
  const all = labelDates(label, endDate);
  return all[all.length - 1] ?? null;
}

/**
 * The window start from WHOOP's own range label ("OCT 25 - NOV 21, 26"), or null when the
 * label is missing, does not end on endDate, or gives an implausible span.
 */
export function rangeLabelStart(label: unknown, endDate: string): string | null {
  const dates = labelDates(str(label), endDate);
  if (dates.length !== 2 || dates[1] !== endDate) return null;
  const days = dayNumber(endDate) - dayNumber(dates[0]!) + 1;
  return days >= 1 && days <= 190 ? dates[0]! : null;
}

const parseDisplay = (d: string | null): number | null => (isClock(d) ? displayMinutes(d) : displayNumber(d));

function rawPoints(segment: Node, endDate: string): Array<{ date: string | null; value: number | null }> {
  const out: Array<{ date: string | null; value: number | null }> = [];
  for (const p of nodes(get(segment, "graph", "plots"))) {
    const plot = isNode(p.plot) ? p.plot : null;
    if (!plot) continue;
    for (const seg of nodes(plot.segments)) {
      for (const pt of nodes(seg.points)) {
        const dsd = isNode(pt.data_scrubber_details) ? pt.data_scrubber_details : {};
        const display = str(dsd.value_display) ?? str(get(pt, "graph_label", "label"));
        out.push({ date: pointDate(str(dsd.primary_contextual_display), endDate), value: parseDisplay(display) });
      }
    }
    for (const group of nodes(plot.bar_groups)) {
      const bars = nodes(group.bars);
      const first = isNode(bars[0]?.data_scrubber_details) ? (bars[0]!.data_scrubber_details as Node) : {};
      // A stacked group (HR_ZONES_ALL) shows its total as the top label; a single
      // bar carries its own value (TIME_IN_BED's top label is a clock time).
      const display = bars.length > 1
        ? str(get(group, "top_label", "label"))
        : str(first.value_display) ?? str(get(group, "top_label", "label"));
      out.push({ date: pointDate(str(first.primary_contextual_display), endDate), value: parseDisplay(display) });
    }
  }
  return out;
}

/** Daily values aligned to the window (index 0 = `start`). */
export function dailyValues(segment: Node, start: string, endDate: string): Array<number | null> {
  const startDay = dayNumber(start);
  const values: Array<number | null> = new Array(Math.max(1, dayNumber(endDate) - startDay + 1)).fill(null);
  for (const p of rawPoints(segment, endDate)) {
    if (!p.date || p.value === null) continue;
    const i = dayNumber(p.date) - startDay;
    if (i >= 0 && i < values.length) values[i] = p.value;
  }
  return values;
}

function breakdown(segment: Node): TrendWindowOut["breakdown"] {
  const bars = nodes(get(segment, "breakdown_bar", "bars"));
  if (!bars.length) return null;
  // Labels carry Unicode isolates around the range, e.g. "All Out \u2066(>18.0)\u2069".
  return bars.map((b) => [(str(b.top_label_display) ?? "").replace(/[\u2066-\u2069]/g, ""), num(b.bottom_label_display)]);
}

export function projectTrendWindow(raw: unknown, endDate: string, window: TrendWindow, withPoints: boolean): TrendWindowOut | null {
  const segment = get(raw, SEGMENT_KEY[window]);
  if (!isNode(segment)) return null;
  const start = rangeLabelStart(get(segment, "date_picker", "current_date_range_display"), endDate)
    ?? windowBounds(endDate, window).start;
  const out: TrendWindowOut = {
    start,
    end: endDate,
    hidden: segment.is_hidden === true,
    rows: nodes(segment.metrics).map(row),
    breakdown: breakdown(segment),
  };
  if (withPoints) out.points = { start, step: "day", values: dailyValues(segment, start, endDate) };
  return out;
}

export interface TrendDelta { key: string | null; diff: number | null; diff_pct: number | null }

/** Per trend key: window A's average minus window B's (A = end_date, B = compare_end_date). */
export function compareRows(a: TrendRow[], b: TrendRow[]): TrendDelta[] {
  return a.map((ra) => {
    const bv = b.find((x) => x.key === ra.key)?.avg ?? null;
    const diff = ra.avg !== null && bv !== null ? Math.round((ra.avg - bv) * 100) / 100 : null;
    return { key: ra.key, diff, diff_pct: diff !== null && bv ? Math.round((diff / bv) * 1000) / 10 : null };
  });
}
