import type { RecoveryOutT } from "../schemas/recovery.js";
import { isObject, asArray, asString, asNumber } from "../lib/walk.js";

// Whoop migrated the /home-service/v1/deep-dive/recovery shape in May 2026 from
// GRAPHING_CARD tiles (titled "RECOVERY", "HEART RATE VARIABILITY", etc.) to a
// SCORE_GAUGE + CONTRIBUTORS_TILE structure:
//
//   sections[].items[].type === "SCORE_GAUGE"
//     content.id === "RECOVERY_SCORE_GAUGE"
//     content.score_display: "78"
//     content.score_display_suffix: "%"
//     content.progress_fill_style: "RECOVERY_HIGH" | "RECOVERY_MEDIUM" | "RECOVERY_LOW"
//
//   sections[].items[].type === "CONTRIBUTORS_TILE"
//     content.id === "RECOVERY_CONTRIBUTORS_TILE"
//     content.metrics[] each:
//       id: "CONTRIBUTORS_TILE_HRV" | "CONTRIBUTORS_TILE_RHR" | "CONTRIBUTORS_TILE_RESPIRATORY_RATE" |
//           "CONTRIBUTORS_TILE_SLEEP_PERFORMANCE" | ...
//       status: "42"           — today's value (string, may have "%" or "bpm")
//       status_subtitle: "40"  — baseline (same format)

export function stateFromStyle(style: string | null): "GREEN" | "YELLOW" | "RED" | null {
  if (!style) return null;
  if (style === "RECOVERY_HIGH") return "GREEN";
  if (style === "RECOVERY_MEDIUM") return "YELLOW";
  if (style === "RECOVERY_LOW") return "RED";
  return null;
}

function parseNumber(s: string | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,%]/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function pct(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null || baseline === 0) return null;
  return Math.round(((current - baseline) / baseline) * 1000) / 10;
}

// Walk every nested item with a `type` field. Returns flat list of {type, content} pairs.
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
    if (id && id.toUpperCase().endsWith(idSuffix.toUpperCase())) {
      return m as Record<string, unknown>;
    }
  }
  return null;
}

export function projectRecovery(raw: unknown, date: string): RecoveryOutT {
  const items: Array<{ type: string; content: Record<string, unknown> }> = [];
  collectItems(raw, items);

  // Recovery score from SCORE_GAUGE with id "RECOVERY_SCORE_GAUGE".
  const gauge = items.find((it) =>
    it.type === "SCORE_GAUGE" && asString(it.content.id) === "RECOVERY_SCORE_GAUGE",
  );
  const score = gauge ? parseNumber(asString(gauge.content.score_display)) : null;
  const state = gauge ? stateFromStyle(asString(gauge.content.progress_fill_style)) : null;

  // Contributors tile holds HRV / RHR / respiratory / sleep_performance.
  const contributors = items.find((it) =>
    it.type === "CONTRIBUTORS_TILE" && asString(it.content.id) === "RECOVERY_CONTRIBUTORS_TILE",
  );
  const metrics = contributors ? asArray(contributors.content.metrics) : [];

  function readMetric(idSuffix: string): { current: number | null; baseline: number | null } {
    const m = findContributor(metrics, idSuffix);
    if (!m) return { current: null, baseline: null };
    return {
      current: parseNumber(asString(m.status)),
      baseline: parseNumber(asString(m.status_subtitle)),
    };
  }
  const hrv = readMetric("HRV");
  const rhr = readMetric("RHR");
  const respiratory = readMetric("RESPIRATORY_RATE");
  const sleepPerf = readMetric("SLEEP_PERFORMANCE");
  const spo2 = readMetric("SPO2");
  const skinTemp = readMetric("SKIN_TEMPERATURE");

  // Discard 'asNumber' import warning — used in lib walks elsewhere
  void asNumber;

  return {
    date,
    score,
    state,
    hrv: {
      ms: hrv.current,
      baseline_ms: hrv.baseline,
      delta_pct: pct(hrv.current, hrv.baseline),
    },
    rhr: {
      bpm: rhr.current,
      baseline_bpm: rhr.baseline,
      delta_pct: pct(rhr.current, rhr.baseline),
    },
    respiratory_rate: respiratory.current,
    spo2_pct: spo2.current,
    skin_temp_c: skinTemp.current,
    sleep_performance_pct: sleepPerf.current,
    contributors: [],
    calibration_state: null,
  };
}
