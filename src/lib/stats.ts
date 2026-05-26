export function mean(xs: Array<number | null | undefined>): number | null {
  const clean = xs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

export interface TimedPoint {
  t: number; // epoch ms
  v: number;
}

const MS_PER_DAY = 86_400_000;

export function slopePerDay(points: TimedPoint[]): number | null {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.t / MS_PER_DAY);
  const ys = points.map((p) => p.v);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - xMean;
    num += dx * (ys[i]! - yMean);
    den += dx * dx;
  }
  if (den === 0) return 0;
  return num / den;
}

export function deltaVsWindow(latest: number, window: number[]): number | null {
  const m = mean(window);
  if (m === null) return null;
  return latest - m;
}
