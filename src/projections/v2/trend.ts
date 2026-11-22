// whoop_trend: GET /progression-service/v3/trends/{metric}?endDate= (SPEC.md §4.7).
// Every response carries exactly three windows (week, month, six_month; no year).
// Windows are inclusive and end on endDate. Daily metrics span 7 / 30 / 180 days;
// WHOOP's weekly-total metrics (HR zones, strength time) span 7 / 28 / 175 days
// and plot one bar per week. The window start therefore comes from WHOOP's own
// range label when that label ends on endDate, and from the day counts otherwise
// (date_picker.next_date_time is not the window's start).
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
  /** One value per day, or per week for weekly-total metrics, from `start` (null = no data). */
  points?: { start: string; step: "day" | "week"; values: Array<number | null> };
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
 * The dates in a WHOOP label, in order: "SUN, MAY 17", "TUE, NOV 25, 2025", a week bar's
 * "NOV 15 - 21, 26", a range's "DEC 28, 26 - JAN 3, 27". A date without a year takes the
 * latest year that does not put it after the window's end.
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

/** A stacked bar group's own value when WHOOP gives the group no total label. */
function stackValue(bars: Node[]): number | null {
  // Stress stacks are HIGH / MEDIUM / LOW and the trend row is the HIGH series.
  const high = bars.find((b) => typeof b.style === "string" && b.style.endsWith("_HIGH"));
  if (high) return parseDisplay(str(get(high, "data_scrubber_details", "value_display")));
  // HR-zone stacks: the zones add up to the total (each bar is floored to the minute).
  let sum: number | null = null;
  for (const b of bars) {
    const v = parseDisplay(str(get(b, "data_scrubber_details", "value_display")));
    if (v !== null) sum = (sum ?? 0) + v;
  }
  return sum;
}

interface RawPoint { label: string | null; value: number | null }

function rawPoints(segment: Node): RawPoint[] {
  const out: RawPoint[] = [];
  let lineSeen = false;
  for (const p of nodes(get(segment, "graph", "plots"))) {
    const plot = isNode(p.plot) ? p.plot : null;
    // TREND_PLOT (trend line), PROGRESS_PLOT (cycle overlay) and EMPTY_PLOT carry no values.
    if (!plot || (p.type !== "LINE_PLOT" && p.type !== "BAR_PLOT")) continue;
    if (p.type === "LINE_PLOT") {
      // Six-month stress draws three lines (HIGH, MEDIUM, LOW); the first is the row's series.
      if (lineSeen) continue;
      lineSeen = true;
      for (const seg of nodes(plot.segments)) {
        for (const pt of nodes(seg.points)) {
          const dsd = isNode(pt.data_scrubber_details) ? pt.data_scrubber_details : {};
          const display = str(dsd.value_display) ?? str(get(pt, "graph_label", "label"));
          out.push({ label: str(dsd.primary_contextual_display), value: parseDisplay(display) });
        }
      }
    }
    for (const group of nodes(plot.bar_groups)) {
      const bars = nodes(group.bars);
      const first = isNode(bars[0]?.data_scrubber_details) ? (bars[0]!.data_scrubber_details as Node) : {};
      const top = str(get(group, "top_label", "label"));
      // A stacked group (HR zones, stress) shows its figure as the top label when it has one; a
      // single bar carries its own value (TIME_IN_BED's top label is a clock time).
      const value = bars.length > 1
        ? (top !== null ? parseDisplay(top) : stackValue(bars))
        : parseDisplay(str(first.value_display) ?? top);
      out.push({ label: str(first.primary_contextual_display), value });
    }
  }
  return out;
}

/** A week bar's label is a date range ("NOV 15 - 21, 26", "OCT 29 - NOV 4, 26"). */
const isRangeLabel = (label: string | null): boolean => label !== null && /\d\s+-\s+/.test(label);

/** Values aligned to the window (index 0 = `start`): one per day, or per week when WHOOP plots weekly bars. */
export function windowPoints(segment: Node, start: string, endDate: string): NonNullable<TrendWindowOut["points"]> {
  const pts = rawPoints(segment);
  const weekly = pts.some((p) => isRangeLabel(p.label));
  const size = weekly ? 7 : 1;
  const days = dayNumber(endDate) - dayNumber(start) + 1;
  const values: Array<number | null> = new Array(Math.max(1, Math.round(days / size))).fill(null);
  const startDay = dayNumber(start);
  for (const p of pts) {
    // A week bar is placed by its first day; a day point by its (only) date.
    const dates = labelDates(p.label, endDate);
    const date = weekly ? dates[0] : dates[dates.length - 1];
    if (!date || p.value === null) continue;
    const i = Math.round((dayNumber(date) - startDay) / size);
    if (i >= 0 && i < values.length && values[i] === null) values[i] = p.value;
  }
  return { start, step: weekly ? "week" : "day", values };
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
  if (withPoints) out.points = windowPoints(segment, start, endDate);
  return out;
}

export type TrendWindowWire = Omit<TrendWindowOut, "hidden" | "points"> & {
  /** Only present (true) when WHOOP hides this window in the app (VO2_MAX's week). */
  hidden?: true;
  /** `start` is the first slot that has a value; slots after the last value are left off. */
  points?: NonNullable<TrendWindowOut["points"]>;
};

/**
 * The window as sent to the model: no `hidden: false`, and points without the empty
 * slots before the first value and after the last (a new member's six months is one
 * value, not 180 slots; sparse metrics like WEIGHT shrink the same way).
 */
export function compactWindow(w: TrendWindowOut): TrendWindowWire {
  const { hidden, points, ...rest } = w;
  const out: TrendWindowWire = { ...rest };
  if (hidden) out.hidden = true;
  if (points) {
    const first = points.values.findIndex((v) => v !== null);
    if (first >= 0) {
      const last = points.values.findLastIndex((v) => v !== null);
      const size = points.step === "week" ? 7 : 1;
      out.points = { start: addDays(points.start, first * size), step: points.step, values: points.values.slice(first, last + 1) };
    }
  }
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
