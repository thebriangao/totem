import type { WorkoutOutT } from "../schemas/workouts.js";
import { isObject, asArray, asNumber, asString, labelToNumber, timeLabelToMs } from "../lib/walk.js";

// Whoop's /core-details-bff/v1/cardio-details returns:
//   title_bar.title_display              → sport name ("STRENGTH TRAINER")
//   title_bar.subtitle_display           → time range text ("9:49 AM to 12:24 PM")
//   details_edit_components.start_time_selector.initial_time  → ISO start
//   details_edit_components.end_time_selector.initial_time    → ISO end
//   horizontal_stat.stat_main_value_display                   → activity strain ("17.7")
//   key_metric_carousel.key_metric_tile[]:
//     {DURATION "2:35"+":38" suffix, CALORIES "701", AVG HR "123", MAX HR "171"}
//   bar_graph_container.heart_rate_zones[]:
//     id ∈ {RESTORATIVE=0, VERY_LIGHT=1, LIGHT=2, MODERATE=3, HARD=4, MAX=5}
//     bar_graph_tile_time_display: "0:54" / "1:21" / ...
//   graph_response.plots[*].plot.segments[*].points → HR curve
//   weightlifting_cardio_details.weightlifting_exercises.exercise_summary_carousel.items[0]:
//     tonnage_display (string lbs), subtitle_display ("29 Sets")
//   strain_breakdown.msk_percent_display ("74%") + cardio_percent_display ("26%")

const ZONE_ID_TO_INDEX: Record<string, 0 | 1 | 2 | 3 | 4 | 5> = {
  RESTORATIVE: 0,
  VERY_LIGHT: 1,
  LIGHT: 2,
  MODERATE: 3,
  HARD: 4,
  MAX: 5,
};

function tileByIcon(tiles: unknown[], icon: string): Record<string, unknown> | null {
  return (tiles.find(
    (t) => isObject(t) && asString((t as Record<string, unknown>).key_metric_tile_icon) === icon,
  ) as Record<string, unknown> | undefined) ?? null;
}

function tileValue(t: Record<string, unknown> | null): string | null {
  if (!t) return null;
  return asString(t.key_metric_tile_stat_value_display);
}

export function projectWorkout(raw: unknown, activityId: string): WorkoutOutT {
  const root = isObject(raw) ? raw : {};

  const titleBar = isObject(root.title_bar) ? (root.title_bar as Record<string, unknown>) : {};
  const editComps = isObject(root.details_edit_components) ? (root.details_edit_components as Record<string, unknown>) : {};
  const startSelector = isObject(editComps.start_time_selector) ? (editComps.start_time_selector as Record<string, unknown>) : {};
  const endSelector = isObject(editComps.end_time_selector) ? (editComps.end_time_selector as Record<string, unknown>) : {};

  const start = asString(startSelector.initial_time);
  const end = asString(endSelector.initial_time);
  const durationMs = start && end ? new Date(end).getTime() - new Date(start).getTime() : null;

  const horizontalStat = isObject(root.horizontal_stat) ? (root.horizontal_stat as Record<string, unknown>) : null;
  const strain = horizontalStat ? labelToNumber(asString(horizontalStat.stat_main_value_display)) : null;

  const keyMetric = isObject(root.key_metric_carousel) ? (root.key_metric_carousel as Record<string, unknown>) : {};
  const tiles = asArray(keyMetric.key_metric_tile);
  const calTile = tileByIcon(tiles, "CALORIES");
  const avgTile = tileByIcon(tiles, "HEART_RATE");
  const maxTile = tileByIcon(tiles, "MAX_HEART_RATE");

  // Zones
  const barContainer = isObject(root.bar_graph_container) ? (root.bar_graph_container as Record<string, unknown>) : {};
  const zoneRows = asArray(barContainer.heart_rate_zones);
  const zones: Record<0 | 1 | 2 | 3 | 4 | 5, number | null> = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null };
  for (const z of zoneRows) {
    if (!isObject(z)) continue;
    const id = asString(z.id);
    const idx = id ? ZONE_ID_TO_INDEX[id] : undefined;
    if (idx === undefined) continue;
    zones[idx] = timeLabelToMs(asString(z.bar_graph_tile_time_display));
  }

  // HR curve from graph_response
  const graph = isObject(root.graph_response) ? (root.graph_response as Record<string, unknown>) : {};
  const hrCurve: { at: string; bpm: number }[] = [];
  for (const p of asArray(graph.plots)) {
    if (!isObject(p)) continue;
    const plot = isObject(p.plot) ? (p.plot as Record<string, unknown>) : null;
    if (!plot) continue;
    for (const seg of asArray(plot.segments)) {
      if (!isObject(seg)) continue;
      for (const pt of asArray(seg.points)) {
        if (!isObject(pt)) continue;
        const dsd = isObject(pt.data_scrubber_details) ? (pt.data_scrubber_details as Record<string, unknown>) : {};
        const at = asString(dsd.timestamp) ?? asString(pt.timestamp);
        const graphLabel = isObject(pt.graph_label) ? (pt.graph_label as Record<string, unknown>) : null;
        const labelStr = graphLabel ? asString(graphLabel.label) : null;
        const bpm = labelToNumber(asString(dsd.value_display) ?? labelStr) ?? asNumber(dsd.value);
        if (at && bpm !== null) hrCurve.push({ at, bpm: Math.round(bpm) });
      }
    }
  }

  // MSK fields
  const sportName = asString(titleBar.title_display);
  const wlDetails = isObject(root.weightlifting_cardio_details) ? (root.weightlifting_cardio_details as Record<string, unknown>) : null;
  const isStrength = !!wlDetails || (sportName ?? "").toUpperCase().includes("STRENGTH");

  let totalVolumeKg: number | null = null;
  if (wlDetails) {
    const wlEx = isObject(wlDetails.weightlifting_exercises) ? (wlDetails.weightlifting_exercises as Record<string, unknown>) : null;
    const carousel = wlEx && isObject(wlEx.exercise_summary_carousel)
      ? (wlEx.exercise_summary_carousel as Record<string, unknown>)
      : null;
    const items = carousel ? asArray(carousel.items) : [];
    const first = isObject(items[0]) ? (items[0] as Record<string, unknown>) : null;
    const tonnageStr = first ? asString(first.tonnage_display) : null;
    const units = wlEx ? asString(wlEx.tonnage_units_display) : null;
    const tonnage = labelToNumber(tonnageStr);
    if (tonnage !== null) {
      // Convert lbs → kg if units say lbs
      totalVolumeKg = units?.toLowerCase() === "lbs" ? Math.round(tonnage / 2.20462) : tonnage;
    }
  }

  const strainBreakdown = isObject(root.strain_breakdown) ? (root.strain_breakdown as Record<string, unknown>) : null;
  const mskPct = strainBreakdown ? labelToNumber(asString(strainBreakdown.msk_percent_display)) : null;

  return {
    id: activityId,
    sport_name: sportName,
    start,
    end,
    duration_ms: durationMs,
    strain,
    calories: labelToNumber(tileValue(calTile)),
    distance_m: null,
    avg_hr_bpm: labelToNumber(tileValue(avgTile)),
    max_hr_bpm: labelToNumber(tileValue(maxTile)),
    zone_durations: {
      zone_0_ms: zones[0],
      zone_1_ms: zones[1],
      zone_2_ms: zones[2],
      zone_3_ms: zones[3],
      zone_4_ms: zones[4],
      zone_5_ms: zones[5],
    },
    hr_curve: hrCurve,
    msk: {
      total_volume_kg: totalVolumeKg,
      intensity_pct: mskPct,
      strain_score: strain,
      is_strength_workout: isStrength,
    },
  };
}
