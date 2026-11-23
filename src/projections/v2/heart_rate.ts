// Continuous heart rate from GET /metrics-service/v1/metrics/user/{id}?name=heart_rate
// → {name, start, values: [{time (epoch ms), data (bpm)}]}.
//
// Checked live on 2026-11-21: the series is sparse. WHOOP returns only the
// samples it has (a strap that was off leaves a hole, not padding), each at its
// own timestamp, `step` seconds apart (give or take a few milliseconds of clock
// drift) inside a stretch of wear. Other projects report zero-valued samples as
// gap markers, so a 0 is never a reading.
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {});

export interface HrPoint {
  /** Epoch milliseconds. */
  t: number;
  bpm: number;
}

/** values[] → readings in time order. Zeros, non-numbers and repeated timestamps are dropped. */
export function hrPoints(raw: unknown): HrPoint[] {
  const out: HrPoint[] = [];
  for (const v of arr(rec(raw).values)) {
    const { time, data } = rec(v);
    if (typeof time !== "number" || !Number.isFinite(time)) continue;
    if (typeof data !== "number" || !Number.isFinite(data) || data <= 0) continue;
    out.push({ t: time, bpm: Math.round(data) });
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((p, i) => i === 0 || p.t !== out[i - 1]!.t);
}

export interface HrWindow {
  start: string;
  end: string;
  step_s: number;
  /** Readings in the window. 0 = the strap recorded nothing here. */
  n: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  /** Stretches of continuous wear: bpm[i] is at run.start + i·step_s seconds. */
  runs: Array<{ start: string; bpm: number[] }>;
}

const toSecondIso = (ms: number): string => new Date(Math.round(ms / 1000) * 1000).toISOString();

/** Readings → evenly spaced runs, split wherever the strap left a hole. */
export function hrWindow(points: HrPoint[], startMs: number, endMs: number, stepS: number): HrWindow {
  const runs: HrWindow["runs"] = [];
  let last = -Infinity;
  for (const p of points) {
    // Samples inside a run are `step` apart to within milliseconds; half a step more is a hole.
    if (p.t - last > stepS * 1500) runs.push({ start: toSecondIso(p.t), bpm: [] });
    runs[runs.length - 1]!.bpm.push(p.bpm);
    last = p.t;
  }
  const values = points.map((p) => p.bpm);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    step_s: stepS,
    n: values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    avg: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
    runs,
  };
}

/** The newest reading, for whoop_now. */
export function latestHr(points: HrPoint[]): { bpm: number; at: string } | null {
  const p = points[points.length - 1];
  return p ? { bpm: p.bpm, at: toSecondIso(p.t) } : null;
}
