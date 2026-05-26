import type { SleepOutT } from "../schemas/sleep.js";
import {
  isObject,
  asArray,
  asNumber,
  asString,
  findByType,
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
// Note: the BFF doesn't currently expose sleep HR / HRV / respiratory rate during
// sleep as named fields. Hypnogram is in the LINE_PLOT / OVERLAY_PLOT but the
// stage timeline isn't trivially extractable from this fixture — flagged as null.

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

  // Wake events tile
  const wakeTile = findByType(raw, "DETAILS_METRIC_TILES");
  let disturbances: number | null = null;
  if (wakeTile) {
    const content = isObject(wakeTile.content) ? (wakeTile.content as Record<string, unknown>) : {};
    if (asString(content.title) === "WAKE EVENTS") {
      // Find the numeric stat inside the tile
      const tiles = asArray(content.metric_tiles ?? content.tiles ?? content.items);
      for (const t of tiles) {
        if (isObject(t)) {
          const v = asNumber(t.value ?? t.metric_value);
          if (v !== null) {
            disturbances = v;
            break;
          }
        }
      }
    }
  }

  return {
    date,
    started_at: params ? asString(params.start_time) : null,
    ended_at: params ? asString(params.end_time) : null,
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
    hypnogram: [],
    disturbances,
    sleep_hr: { avg_bpm: null, min_bpm: null },
    sleep_hrv_ms: null,
    respiratory_rate: null,
  };
}
