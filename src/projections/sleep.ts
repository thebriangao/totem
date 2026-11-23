import type { SleepOutT } from "../schemas/sleep.js";
import {
  isObject,
  asArray,
  asNumber,
  asString,
  findFirst,
  findDetailsCardByTitle,
  labelToNumber,
  timeLabelToMs,
} from "../lib/walk.js";

// Whoop's deep-dive/sleep/last-night returns:
//   header_section.destination.parameters.{start_time, end_time, activity_id}
//   DETAILS_GRAPHING_CARDs by card_title:
//     "HOURS OF SLEEP" → arrow_stat[0].current_stat_text = "7:24"
//     "HOURS VS. NEEDED" → arrow_stat[0].current_stat_text = "85%"
//     "SLEEP CONSISTENCY" → "73%"
//     "SLEEP EFFICIENCY" → "93%"
//   BAR_GRAPH_CARD (first one):
//     content.duration_display = "7:59" (total time in bed)
//     content.heart_rate_zones[] (misnamed — actually sleep stages):
//       {id, bar_graph_tile_title_display, bar_graph_tile_percentage_display, bar_graph_tile_time_display}
//   DETAILS_METRIC_TILES "WAKE EVENTS" → disturbances count
//
// Hypnogram + in-sleep HR (avg/min) are reconstructed from the per-stage HR-curve
// points — see buildSleepTimeline below. Sleep HRV / respiratory rate / debt /
// latency aren't exposed by this endpoint as named fields and stay null.

function arrowStat(card: Record<string, unknown> | null): string | null {
  if (!card) return null;
  const content = isObject(card.content) ? (card.content as Record<string, unknown>) : {};
  const arr = asArray(content.arrow_stat);
  const first = arr[0];
  if (!isObject(first)) return null;
  return asString(first.current_stat_text);
}

function findStageBar(raw: unknown, stageId: string): Record<string, unknown> | null {
  // BAR_GRAPH_CARD with content.duration_display non-empty is the stages card.
  // (The other BAR_GRAPH_CARD has empty duration_display — that one is stress.)
  let stageCard: Record<string, unknown> | null = null;
  let allBars: Record<string, unknown>[] = [];
  function walk(n: unknown): void {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (!isObject(n)) return;
    if (n.type === "BAR_GRAPH_CARD") {
      const c = isObject(n.content) ? (n.content as Record<string, unknown>) : {};
      if (asString(c.duration_display)) {
        stageCard = n;
        const zones = asArray(c.heart_rate_zones);
        allBars = zones.filter(isObject) as Record<string, unknown>[];
      }
    }
    if (!stageCard) for (const v of Object.values(n)) walk(v);
  }
  walk(raw);
  return allBars.find((b) => asString(b.id) === stageId) ?? null;
}

function stageTime(raw: unknown, stageId: string): { ms: number | null; pct: number | null } {
  const bar = findStageBar(raw, stageId);
  if (!bar) return { ms: null, pct: null };
  const timeDisplay = asString(bar.bar_graph_tile_time_display);
  const pctDisplay = asString(bar.bar_graph_tile_percentage_display);
  return { ms: timeLabelToMs(timeDisplay), pct: labelToNumber(pctDisplay) };
}

// ---- Hypnogram + in-sleep HR ------------------------------------------------
// Whoop draws the in-sleep HR curve as four LINE_PLOTs (one per stage, so each
// can be colored differently). Every point carries data_scrubber_details with:
//   scrubber_style                 → the sleep stage at that instant
//   value_display (+ "bpm")        → heart rate
//   secondary_contextual_display   → a local clock label, e.g. "1:24 AM"
// The four plots share one X axis, so merging + sorting by position_x yields the
// chronological timeline. We time the segments from the *clock labels*, not
// position_x — the graph axis has ~40min of padding that skews position_x.

const STAGE_MAP: Record<string, "AWAKE" | "LIGHT" | "REM" | "SWS"> = {
  AWAKE: "AWAKE",
  LIGHT_SLEEP: "LIGHT",
  REM_SLEEP: "REM",
  SWS_SLEEP: "SWS",
};

interface StagePoint {
  x: number;
  stage: "AWAKE" | "LIGHT" | "REM" | "SWS";
  bpm: number | null;
  clockMin: number | null;
}

// "1:24 AM" / "11:52 PM" → minutes since midnight (0..1439), or null.
export function parseClockMinutes(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(s.trim());
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  const pm = m[3]!.toUpperCase() === "PM";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + min;
}

function collectStagePoints(raw: unknown): StagePoint[] {
  const out: StagePoint[] = [];
  function walk(n: unknown): void {
    if (Array.isArray(n)) {
      for (const v of n) walk(v);
      return;
    }
    if (!isObject(n)) return;
    const dsd = isObject(n.data_scrubber_details) ? (n.data_scrubber_details as Record<string, unknown>) : null;
    const style = dsd ? asString(dsd.scrubber_style) : null;
    const mapped = style ? STAGE_MAP[style] : undefined;
    const x = asNumber(n.position_x);
    if (dsd && mapped && x !== null) {
      out.push({
        x,
        stage: mapped,
        bpm: asNumber(dsd.value_display),
        clockMin: parseClockMinutes(asString(dsd.secondary_contextual_display)),
      });
    }
    for (const v of Object.values(n)) walk(v);
  }
  walk(raw);
  out.sort((a, b) => a.x - b.x);
  return out;
}

// Build the stage timeline (hypnogram) + in-sleep HR (avg/min) from the points.
// Timestamps: clock labels give wall-clock minutes; we make them monotonic
// (handling the midnight wrap), then map them onto the UTC sleep window anchored
// at the *midpoint*. The data is inset ~symmetrically at both ends, so the
// midpoint of the clock span lines up with the midpoint of [start, end] — which
// sidesteps both the axis padding and any timezone knowledge. We emit UTC and
// let json_out localize for display.
function buildSleepTimeline(
  points: StagePoint[],
  startIso: string | null,
  endIso: string | null,
): { hypnogram: SleepOutT["hypnogram"]; sleep_hr: SleepOutT["sleep_hr"] } {
  const bpms = points.map((p) => p.bpm).filter((b): b is number => b !== null);
  const sleep_hr = bpms.length
    ? { avg_bpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length), min_bpm: Math.min(...bpms) }
    : { avg_bpm: null, min_bpm: null };

  const startMs = startIso ? Date.parse(startIso) : NaN;
  const endMs = endIso ? Date.parse(endIso) : NaN;
  const clocked = points.filter((p) => p.clockMin !== null);
  if (clocked.length < 2 || Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { hypnogram: [], sleep_hr };
  }

  // Monotonic elapsed minutes from the first point's clock label.
  const rel: number[] = [0];
  for (let i = 1; i < clocked.length; i++) {
    let delta = clocked[i]!.clockMin! - clocked[i - 1]!.clockMin!;
    if (delta < -720) delta += 1440; // crossed midnight
    rel.push(rel[i - 1]! + delta);
  }
  const relMid = (rel[0]! + rel[rel.length - 1]!) / 2;
  const utcMid = (startMs + endMs) / 2;
  const tsAt = (i: number): string => new Date(utcMid + (rel[i]! - relMid) * 60000).toISOString();

  // Group consecutive same-stage runs into [started_at, ended_at, stage] segments.
  const hypnogram: SleepOutT["hypnogram"] = [];
  let runStart = 0;
  for (let i = 1; i <= clocked.length; i++) {
    if (i === clocked.length || clocked[i]!.stage !== clocked[runStart]!.stage) {
      hypnogram.push({
        started_at: tsAt(runStart),
        ended_at: tsAt(Math.min(i, clocked.length - 1)),
        stage: clocked[runStart]!.stage,
      });
      runStart = i;
    }
  }
  return { hypnogram, sleep_hr };
}

export function projectSleep(raw: unknown, date: string): SleepOutT {
  const root = isObject(raw) ? raw : {};
  const headerSection = isObject(root.header_section) ? (root.header_section as Record<string, unknown>) : {};
  const dest = isObject(headerSection.destination) ? (headerSection.destination as Record<string, unknown>) : null;
  const params = dest && isObject(dest.parameters) ? (dest.parameters as Record<string, unknown>) : null;

  const hoursOfSleepCard = findDetailsCardByTitle(raw, "HOURS OF SLEEP");
  const hoursVsNeededCard = findDetailsCardByTitle(raw, "HOURS VS");
  const consistencyCard = findDetailsCardByTitle(raw, "SLEEP CONSISTENCY");
  const efficiencyCard = findDetailsCardByTitle(raw, "SLEEP EFFICIENCY");

  const totalSleepMs = timeLabelToMs(arrowStat(hoursOfSleepCard));
  const performancePct = labelToNumber(arrowStat(hoursVsNeededCard));
  const consistencyPct = labelToNumber(arrowStat(consistencyCard));
  const efficiencyPct = labelToNumber(arrowStat(efficiencyCard));

  // Time in bed from BAR_GRAPH_CARD duration_display
  let timeInBedMs: number | null = null;
  function walkForTib(n: unknown): void {
    if (Array.isArray(n)) {
      for (const x of n) walkForTib(x);
      return;
    }
    if (!isObject(n)) return;
    if (n.type === "BAR_GRAPH_CARD") {
      const c = isObject(n.content) ? (n.content as Record<string, unknown>) : {};
      const dur = asString(c.duration_display);
      if (dur) timeInBedMs = timeLabelToMs(dur);
    }
    if (timeInBedMs === null) for (const v of Object.values(n)) walkForTib(v);
  }
  walkForTib(raw);

  const rem = stageTime(raw, "REM_SLEEP");
  const light = stageTime(raw, "LIGHT_SLEEP");
  const sws = stageTime(raw, "SWS_SLEEP");
  const wake = stageTime(raw, "AWAKE");

  const wakeTile = findFirst(
    raw,
    (n) => n.type === "DETAILS_METRIC_TILES" && isObject(n.content) && asString(n.content.title) === "WAKE EVENTS",
  );
  const disturbances = labelToNumber(arrowStat(wakeTile) || null);

  const startedAt = params ? asString(params.start_time) : null;
  const endedAt = params ? asString(params.end_time) : null;
  const { hypnogram, sleep_hr } = buildSleepTimeline(collectStagePoints(raw), startedAt, endedAt);

  return {
    date,
    started_at: startedAt,
    ended_at: endedAt,
    total_sleep_ms: totalSleepMs,
    time_in_bed_ms: timeInBedMs,
    efficiency_pct: efficiencyPct,
    performance_pct: performancePct,
    consistency_pct: consistencyPct,
    debt_ms: null,
    latency_ms: null,
    stages: {
      rem_ms: rem.ms,
      rem_pct: rem.pct,
      light_ms: light.ms,
      light_pct: light.pct,
      sws_ms: sws.ms,
      sws_pct: sws.pct,
      wake_ms: wake.ms,
      wake_pct: wake.pct,
    },
    hypnogram,
    disturbances,
    sleep_hr,
    sleep_hrv_ms: null,
    respiratory_rate: null,
  };
}
