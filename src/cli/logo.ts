// The totem mark as terminal pixels, rasterized from the same polygons as
// assets/brand/totem.svg (via TOTEM_LOGO_SVG), so the CLI's logo can't drift
// from the real one. ui.ts draws two pixels per cell with half blocks.
import { BRAND, TOTEM_LOGO_SVG } from "../lib/brand.js";

/** One pixel: the ice face, the darker fold face, or empty. */
export type Pixel = "ice" | "fold" | null;

type Point = [number, number];
interface Shape { pixel: Exclude<Pixel, null>; points: Point[] }

const SHAPES: Shape[] = [...TOTEM_LOGO_SVG.matchAll(/<polygon fill="(#[0-9A-Fa-f]{6})" points="([^"]+)"/g)].map((m) => ({
  pixel: m[1]!.toUpperCase() === BRAND.fold ? "fold" : "ice",
  points: m[2]!.trim().split(/\s+/).map((p) => p.split(",").map(Number) as Point),
}));

const inside = ([x, y]: Point, poly: Point[]): boolean => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

/** Later shapes paint over earlier ones, as in the SVG. */
const pixelAt = (pt: Point): Pixel => {
  let found: Pixel = null;
  for (const s of SHAPES) if (inside(pt, s.points)) found = s.pixel;
  return found;
};

const cache = new Map<string, Pixel[][]>();

/**
 * The mark cut to its own bounds, `cols` × `rows` pixels. Each pixel takes the
 * face that covers most of it (4×4 samples), and is empty when more than half
 * of it is background.
 */
export function logoPixels(cols: number, rows: number): Pixel[][] {
  const key = `${cols}x${rows}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const xs = SHAPES.flatMap((s) => s.points.map((p) => p[0]));
  const ys = SHAPES.flatMap((s) => s.points.map((p) => p[1]));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const grid: Pixel[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Pixel[] = [];
    for (let c = 0; c < cols; c++) {
      let ice = 0, fold = 0, none = 0;
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          const p = pixelAt([x0 + ((c + (a + 0.5) / 4) / cols) * (x1 - x0), y0 + ((r + (b + 0.5) / 4) / rows) * (y1 - y0)]);
          if (p === "ice") ice++; else if (p === "fold") fold++; else none++;
        }
      }
      row.push(none > 8 ? null : fold > ice ? "fold" : "ice");
    }
    grid.push(row);
  }
  cache.set(key, grid);
  return grid;
}
