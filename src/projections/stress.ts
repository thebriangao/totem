import type { StressOutT } from "../schemas/stress.js";
import { isObject, asArray, asNumber, asString, findByType } from "../lib/walk.js";

export function projectStress(raw: unknown, date: string): StressOutT {
  const root = isObject(raw) ? raw : {};
  const state = isObject(root.stress_state) ? root.stress_state as Record<string, unknown> : {};
  const timelineRaw = asArray(state.timeline ?? state.points);
  const timeline = timelineRaw
    .map((p) => {
      if (!isObject(p)) return null;
      const startedAt = asString(p.started_at) ?? asString(p.start);
      const endedAt = asString(p.ended_at) ?? asString(p.end);
      if (!startedAt || !endedAt) return null;
      return { started_at: startedAt, ended_at: endedAt, level: asNumber(p.level) };
    })
    .filter((x): x is { started_at: string; ended_at: string; level: number | null } => x !== null);

  const calibTile = findByType(root, "CALIBRATION_INDICATOR");
  const calib = calibTile || asString(root.calibration_text_display) ? "CALIBRATING" : "CALIBRATED";

  const levels = timeline.map((t) => t.level).filter((v): v is number => v !== null);

  return {
    date,
    current_level: levels.length > 0 ? (levels[levels.length - 1] ?? null) : null,
    baseline_level: asNumber(state.baseline_level ?? state.baseline),
    peak_level: levels.length ? Math.max(...levels) : null,
    min_level: levels.length ? Math.min(...levels) : null,
    calibration_state: calib,
    timeline,
  };
}
