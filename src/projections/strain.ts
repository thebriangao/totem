import type { StrainOutT } from "../schemas/strain.js";
import { isObject, asArray, asString } from "../lib/walk.js";

// Whoop migrated /home-service/v1/deep-dive/strain in May 2026 from
// GRAPHING_CARD tiles to a SCORE_GAUGE + CONTRIBUTORS_TILE + ACTIVITY structure:
//
//   sections[].items[].type === "SCORE_GAUGE"
//     content.id === "STRAIN_SCORE_GAUGE"
//     content.score_display: "18.9"
//
//   sections[].items[].type === "CONTRIBUTORS_TILE"
//     content.id === "STRAIN_CONTRIBUTORS_TILE"
//     content.metrics[] each:
//       id: "CONTRIBUTORS_TILE_HR_ZONES_1_3" | "CONTRIBUTORS_TILE_HR_ZONES_4_5" |
//           "CONTRIBUTORS_TILE_STRENGTH_TRAINING_TIME" | "CONTRIBUTORS_TILE_STEPS"
//       status: "2:18" (h:mm or "10,616" for steps)
//
//   sections[].items[].type === "ACTIVITY"
//     score: "17.7", title: "STRENGTH TRAINER"
//
// Calories, avg_hr_bpm, max_hr_bpm, and per-zone (zone_0..zone_5) granularity
// are NOT in this endpoint anymore. They live in per-workout /cardio-details.
// We populate zone_1 with the 1-3 aggregate and zone_4 with the 4-5 aggregate.

function parseNumberWithCommas(s: string | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,%]/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Parse "2:35" → 2h35m → ms. Also handles "2:35:12" (h:m:s).
function timeToMs(s: string | null): number | null {
  if (!s) return null;
  const parts = s.trim().split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 2) return ((parts[0]! * 60) + parts[1]!) * 60 * 1000;
  if (parts.length === 3) return ((parts[0]! * 3600) + (parts[1]! * 60) + parts[2]!) * 1000;
  return null;
}

function collectItems(node: unknown, out: Array<{ type: string; content: Record<string, unknown> }>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) collectItems(n, out); return; }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === "string" && isObject(obj.content)) {
    out.push({ type: obj.type, content: obj.content as Record<string, unknown> });
  }
  for (const k of Object.keys(obj)) collectItems(obj[k], out);
}

function findContributor(metrics: unknown[], idSuffix: string): Record<string, unknown> | null {
  for (const m of metrics) {
    if (!isObject(m)) continue;
    const id = asString((m as Record<string, unknown>).id);
    if (id && id.toUpperCase().endsWith(idSuffix.toUpperCase())) return m as Record<string, unknown>;
  }
  return null;
}

export function projectStrain(raw: unknown, date: string): StrainOutT {
  const items: Array<{ type: string; content: Record<string, unknown> }> = [];
  collectItems(raw, items);

  const gauge = items.find((it) =>
    it.type === "SCORE_GAUGE" && asString(it.content.id) === "STRAIN_SCORE_GAUGE",
  );
  const score = gauge ? parseNumberWithCommas(asString(gauge.content.score_display)) : null;

  const contributors = items.find((it) =>
    it.type === "CONTRIBUTORS_TILE" && asString(it.content.id) === "STRAIN_CONTRIBUTORS_TILE",
  );
  const metrics = contributors ? asArray(contributors.content.metrics) : [];

  function readTimeMetric(idSuffix: string): number | null {
    const m = findContributor(metrics, idSuffix);
    if (!m) return null;
    return timeToMs(asString(m.status));
  }
  function readNumericMetric(idSuffix: string): number | null {
    const m = findContributor(metrics, idSuffix);
    if (!m) return null;
    return parseNumberWithCommas(asString(m.status));
  }

  const zones13Ms = readTimeMetric("HR_ZONES_1_3");
  const zones45Ms = readTimeMetric("HR_ZONES_4_5");
  const strengthTimeMs = readTimeMetric("STRENGTH_TRAINING_TIME");
  const steps = readNumericMetric("STEPS");

  // Count today's ACTIVITY items
  const workoutsCount = items.filter((it) => it.type === "ACTIVITY").length;

  return {
    date,
    score,
    calories: null,
    avg_hr_bpm: null,
    max_hr_bpm: null,
    zone_durations: {
      zone_0_ms: null,
      zone_1_ms: zones13Ms,
      zone_2_ms: null,
      zone_3_ms: null,
      zone_4_ms: zones45Ms,
      zone_5_ms: null,
    },
    workouts_count: workoutsCount,
    steps,
    strength_activity_time_ms: strengthTimeMs,
  };
}
