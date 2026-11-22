// whoop_sleep: GET /core-details-bff/v2/sleep-details/{id} is the per-sleep
// source (stages, hypnogram, RR, latency, wake events) for any sleep or nap by
// id; GET /home-service/v1/deep-dive/sleep/last-night?date= names the cycle's
// main sleep and carries consistency / hours-vs-needed. SPEC.md §4.4.
// Durations are minutes; the hypnogram is run-length encoded and opt-in.
import {
  arr, byType, displayMinutes, displayNumber, findFirst, get, intOrNull, isNode, isoInstant, nodes, parseNumber,
  str, type Node,
} from "./core_common.js";
import { findAll } from "../../whoop/bff.js";
import { activityTiles, stickyGauge, type ActivityTile } from "./core_home.js";
import type { SleepNeed } from "./core_sleep_need.js";

export type Stage = "AWAKE" | "LIGHT" | "SWS" | "REM";
const STAGE_IDS: Record<string, Stage> = { AWAKE: "AWAKE", LIGHT_SLEEP: "LIGHT", SWS_SLEEP: "SWS", REM_SLEEP: "REM" };
type StageMap = { awake: number | null; light: number | null; sws: number | null; rem: number | null };

export interface SleepRecord {
  id: string;
  type: "sleep" | "nap";
  scored: boolean;
  start: string | null;
  end: string | null;
  asleep_min: number | null;
  in_bed_min: number | null;
  efficiency_pct: number | null;
  latency_min: number | null;
  rr: number | null;
  wake_per_hr: number | null;
  /** Total wake events (TOTAL_WAKE_EVENTS); falls back to the last-night WAKE EVENTS tile (PR #46). */
  disturbances: number | null;
  restorative_min: number | null;
  stages_min: StageMap;
  stages_pct: StageMap;
  hr: { avg: number | null; min: number | null };
  /** Run-length hypnogram: [stage, minutes] from `start`, in order. */
  hypnogram?: { start: string; runs: Array<[string, number]> };
  coach_note: string | null;
}

function breakdown(raw: unknown): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const m of nodes(get(raw, "sleep_metric_breakdowns"))) {
    if (typeof m.sleep_metric_type === "string") out.set(m.sleep_metric_type, m);
  }
  return out;
}

/** Project a sleep-details payload; `withHypnogram` adds the run-length hypnogram. */
export function projectSleepDetails(raw: unknown, id: string, withHypnogram: boolean): SleepRecord | null {
  if (!isNode(raw)) return null;
  const b = breakdown(raw);
  const val = (type: string): unknown => b.get(type)?.sleep_metric_value_display;
  const start = isoInstant(get(raw, "sleep_details_edit_components", "sleep_start_time"));
  const end = isoInstant(get(raw, "sleep_details_edit_components", "sleep_end_time"));
  const title = str(get(raw, "sleep_details_labels", "screen_title_display")) ?? "";
  const displayType = str(raw.activity_display_type) ?? "";
  const isNap = /NAP/i.test(displayType) || /\bNAP\b/i.test(title) ||
    get(raw, "sleep_details_edit_components", "nap_to_sleep_available") === true;
  const zones = nodes(get(raw, "bar_graph_container", "heart_rate_zones"));
  const scored = displayType.startsWith("COMPLETE");
  const stageMin: StageMap = { awake: null, light: null, sws: null, rem: null };
  const stagePct: StageMap = { awake: null, light: null, sws: null, rem: null };
  if (scored) {
    for (const z of zones) {
      const stage = typeof z.id === "string" ? STAGE_IDS[z.id] : undefined;
      if (!stage) continue;
      const k = stage.toLowerCase() as keyof StageMap;
      stageMin[k] = displayMinutes(z.bar_graph_tile_time_display);
      stagePct[k] = parseNumber(z.bar_graph_tile_percentage_display);
    }
  }
  const total = intOrNull(displayNumber(val("TOTAL_WAKE_EVENTS")));
  const record: SleepRecord = {
    id,
    type: isNap ? "nap" : "sleep",
    scored,
    start,
    end,
    asleep_min: displayMinutes(val("HOURS_OF_SLEEP")),
    in_bed_min: displayMinutes(val("TIME_IN_BED")),
    efficiency_pct: displayNumber(val("EFFICIENCY")),
    latency_min: displayNumber(val("LATENCY")),
    rr: displayNumber(val("RESPIRATORY_RATE")),
    wake_per_hr: displayNumber(val("WAKE_EVENTS")),
    disturbances: total,
    restorative_min: displayMinutes(val("RESTORATIVE_SLEEP")),
    stages_min: stageMin,
    stages_pct: stagePct,
    hr: sleepHr(raw),
    coach_note: str(get(raw, "whoop_coach_vow", "vow")),
  };
  if (withHypnogram && start && end) {
    // An unscored sleep has no stage ranges: leave the block out rather than send a bare start.
    const runs = hypnogramRuns(zones, start, end);
    if (runs.length) record.hypnogram = { start, runs };
  }
  return record;
}

// Each stage's bar_graph.time_bound_ranges are fractions (0–1) of the sleep
// window. Sorting them gives the stage sequence; adjacent runs of one stage merge.
export function hypnogramRuns(zones: Node[], start: string, end: string): Array<[string, number]> {
  const totalMin = (Date.parse(end) - Date.parse(start)) / 60_000;
  if (!(totalMin > 0)) return [];
  const spans: Array<{ stage: string; lo: number; hi: number }> = [];
  for (const z of zones) {
    const stage = typeof z.id === "string" ? STAGE_IDS[z.id] : undefined;
    if (!stage) continue;
    for (const r of nodes(get(z, "bar_graph", "time_bound_ranges"))) {
      const lo = r.lower_endpoint;
      const hi = r.upper_endpoint;
      if (typeof lo === "number" && typeof hi === "number" && hi > lo) spans.push({ stage, lo, hi });
    }
  }
  spans.sort((a, b) => a.lo - b.lo);
  const runs: Array<[string, number]> = [];
  let cursor = 0;
  const push = (stage: string, frac: number): void => {
    const last = runs[runs.length - 1];
    if (last && last[0] === stage) last[1] += frac * totalMin;
    else runs.push([stage, frac * totalMin]);
  };
  for (const s of spans) {
    if (s.hi <= cursor) continue;
    if (s.lo - cursor > 0.5 / totalMin) push("NO_DATA", s.lo - cursor);
    push(s.stage, s.hi - Math.max(s.lo, cursor));
    cursor = Math.max(cursor, s.hi);
  }
  return runs.map(([stage, m]) => [stage, Math.round(m * 10) / 10]);
}

function sleepHr(raw: unknown): { avg: number | null; min: number | null } {
  const graph = get(raw, "graph");
  const plot = findFirst(graph, (n) => n.id === "SLEEP_HEART_RATE" && Array.isArray(n.segments));
  // The HR line is padded with about ten minutes of awake heart rate before and after the
  // sleep. The stage lines (LIGHT_SLEEP, REM_SLEEP…) cover only the sleep itself, so their
  // x-range bounds the HR points that count.
  let lo = Infinity;
  let hi = -Infinity;
  for (const stage of findAll(graph, (n) => typeof n.id === "string" && n.id in STAGE_IDS && Array.isArray(n.segments))) {
    for (const seg of nodes(stage.segments)) {
      for (const p of nodes(seg.points)) {
        if (typeof p.position_x !== "number") continue;
        lo = Math.min(lo, p.position_x);
        hi = Math.max(hi, p.position_x);
      }
    }
  }
  const bounded = hi > lo;
  const bpms: number[] = [];
  for (const seg of nodes(plot?.segments)) {
    for (const p of nodes(seg.points)) {
      if (bounded && typeof p.position_x === "number" && (p.position_x < lo || p.position_x > hi)) continue;
      const v = parseNumber(get(p, "data_scrubber_details", "value_display"));
      if (v !== null && v > 0) bpms.push(v);
    }
  }
  if (!bpms.length) return { avg: null, min: null };
  return { avg: Math.round(bpms.reduce((a, c) => a + c, 0) / bpms.length), min: Math.min(...bpms) };
}

export interface LastNight {
  id: string | null;
  start: string | null;
  end: string | null;
  hours_vs_needed_pct: number | null;
  consistency_pct: number | null;
  efficiency_pct: number | null;
  wake_events: number | null;
}

/** GET …/deep-dive/sleep/last-night: the main sleep that opens the date's cycle (naps never appear). */
export function projectLastNight(raw: unknown): LastNight {
  const params = get(raw, "header_section", "destination", "parameters");
  const card = (id: string): string | null => {
    const sec = nodes(get(raw, "sections")).find((s) => s.id === id);
    return str(get(arr(get(findFirst(sec, (n) => Array.isArray(n.arrow_stat)), "arrow_stat"))[0], "current_stat_text"));
  };
  // PR #46: the wake-event count lives in a DETAILS_METRIC_TILES titled WAKE EVENTS.
  const wakeTile = byType(raw, "DETAILS_METRIC_TILES").find((n) => get(n, "content", "title") === "WAKE EVENTS");
  return {
    id: str(get(params, "activity_id")),
    start: isoInstant(get(params, "start_time")),
    end: isoInstant(get(params, "end_time")),
    hours_vs_needed_pct: displayNumber(card("hours_vs_needed")),
    consistency_pct: displayNumber(card("sleep_consistency")),
    efficiency_pct: displayNumber(card("sleep_efficiency")),
    wake_events: intOrNull(displayNumber(get(arr(get(wakeTile, "content", "arrow_stat"))[0], "current_stat_text"))),
  };
}

export interface NapRow { id: string; status: string | null; start: string | null; end: string | null; min: number | null }

export function napsFromTiles(tiles: ActivityTile[]): NapRow[] {
  return tiles
    .filter((t) => t.type === "SLEEP" && t.name === "nap")
    .map((t) => ({ id: t.id, status: t.status, start: t.start, end: t.end, min: t.min }));
}

/** The cycle's main sleep tile (internal_name "sleep"); its home tile has no activity_id in `destination`. */
export function mainSleepTile(tiles: ActivityTile[]): ActivityTile | null {
  return tiles.find((t) => t.type === "SLEEP" && t.name !== "nap") ?? null;
}

/** The main sleep's id for a date: last-night's edit destination, else the home SLEEP tile. */
export function mainSleepId(lastNight: unknown, home: unknown): string | null {
  return projectLastNight(lastNight).id ?? mainSleepTile(activityTiles(home))?.id ?? null;
}

export type SleepInclude = "hypnogram" | "need" | "naps";

export type SleepOutRecord = SleepRecord & {
  status: string | null;
  perf_pct: number | null;
  hours_vs_needed_pct: number | null;
  consistency_pct: number | null;
};

export interface SleepV2 {
  date: string | null;
  sleep: SleepOutRecord | null;
  naps?: NapRow[];
  need?: SleepNeed | null;
  hr_baseline_bpm: number | null;
}

export interface SleepInput {
  date: string | null;
  /** Set when the caller asked for one sleep or nap by id. */
  activityId?: string;
  include: ReadonlySet<SleepInclude>;
  details: unknown;
  lastNight?: unknown;
  home?: unknown;
  need?: SleepNeed | null;
  baseline?: unknown;
}

const EMPTY_STAGES: StageMap = { awake: null, light: null, sws: null, rem: null };

export function projectSleepV2(input: SleepInput): SleepV2 {
  const tiles = input.home ? activityTiles(input.home) : [];
  const ln = input.lastNight ? projectLastNight(input.lastNight) : null;
  const id = input.activityId ?? ln?.id ?? mainSleepTile(tiles)?.id ?? null;
  const tile = id ? tiles.find((t) => t.id === id) ?? null : null;
  const isMain = Boolean(id && ln?.id === id) || (!input.activityId && tile !== null);
  const detail = id ? projectSleepDetails(input.details, id, input.include.has("hypnogram")) : null;
  // A pending sleep's details can fail (400); keep the window from the other sources.
  const base: SleepRecord | null = detail ?? (id
    ? {
        id,
        type: tile?.name === "nap" ? "nap" : "sleep",
        scored: tile?.status === "COMPLETE",
        start: (isMain ? ln?.start : null) ?? tile?.start ?? null,
        end: (isMain ? ln?.end : null) ?? tile?.end ?? null,
        asleep_min: tile?.min ?? null, in_bed_min: null, efficiency_pct: null, latency_min: null, rr: null,
        wake_per_hr: null, disturbances: null, restorative_min: null,
        stages_min: { ...EMPTY_STAGES }, stages_pct: { ...EMPTY_STAGES }, hr: { avg: null, min: null },
        coach_note: null,
      }
    : null);
  const out: SleepV2 = {
    date: input.date,
    sleep: base
      ? {
          ...base,
          status: tile?.status ?? null,
          perf_pct: isMain && input.home ? stickyGauge(input.home, "SLEEP_GAUGE_STICKY").score : null,
          hours_vs_needed_pct: isMain ? ln?.hours_vs_needed_pct ?? null : null,
          consistency_pct: isMain ? ln?.consistency_pct ?? null : null,
          efficiency_pct: base.efficiency_pct ?? (isMain ? ln?.efficiency_pct ?? null : null),
          disturbances: base.disturbances ?? (isMain ? ln?.wake_events ?? null : null),
        }
      : null,
    hr_baseline_bpm: typeof input.baseline === "number" && Number.isFinite(input.baseline) ? input.baseline : null,
  };
  if (input.include.has("naps")) out.naps = napsFromTiles(tiles);
  if (input.include.has("need")) out.need = input.need ?? null;
  return out;
}
