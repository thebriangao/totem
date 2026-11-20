import type { RecoveryOutT } from "../schemas/recovery.js";
import { isObject, asArray, asString, asNumber } from "../lib/walk.js";
import { isoDay } from "../lib/dates.js";

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

// SpO2 + skin temperature aren't carried by the deep-dive recovery tiles; they
// live on the lightweight /developer/v2/recovery records (score.spo2_percentage,
// score.skin_temp_celsius). Pick the record whose created date matches; fall back
// to the most recent only when `date` is newer than every record (today, before
// it's scored). A past date with no match gets nothing rather than another day.
export function pickForDate(
  records: Record<string, unknown>[],
  date: string,
  dayOf: (r: Record<string, unknown>) => string | undefined,
): Record<string, unknown> | undefined {
  const match = records.find((r) => dayOf(r) === date);
  if (match) return match;
  return records.every((r) => (dayOf(r) ?? "") < date) ? records[0] : undefined;
}

// The member's calendar day for a timestamp. One carrying a local offset is
// already local; a UTC ("Z") one is shifted into the member's timezone, else
// east-of-UTC members would match the previous day's UTC date.
export function localDay(ts: string | null | undefined): string | undefined {
  if (!ts) return undefined;
  if (!/(Z|[+-]00:?00)$/i.test(ts)) return ts.slice(0, 10);
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? ts.slice(0, 10) : isoDay(new Date(ms));
}

function v2Score(recoveryV2: unknown, date: string): Record<string, unknown> {
  const records = asArray(isObject(recoveryV2) ? recoveryV2.records : null).filter(isObject);
  const pick = pickForDate(records, date, (r) => localDay(asString(r.created_at)));
  return pick && isObject(pick.score) ? (pick.score as Record<string, unknown>) : {};
}

export function projectRecovery(raw: unknown, date: string, recoveryV2?: unknown): RecoveryOutT {
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
  // Fall back to the /developer/v2/recovery record for SpO2/skin temp, which the
  // deep-dive tiles omit.
  const v2 = v2Score(recoveryV2, date);
  const spo2Pct = spo2.current ?? asNumber(v2.spo2_percentage);
  const skinTempCRaw = skinTemp.current ?? asNumber(v2.skin_temp_celsius);
  const skinTempC = skinTempCRaw === null ? null : Math.round(skinTempCRaw * 10) / 10;

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
    spo2_pct: spo2Pct,
    skin_temp_c: skinTempC,
    sleep_performance_pct: sleepPerf.current,
    contributors: [],
    calibration_state: null,
  };
}
