// docs/media/totem-local-{light,dark}.svg: the README's hero, an animated
// terminal showing `totem local` in a 24-row window, in a light and a dark
// theme. Each is drawn from the CLI's real output (the same scripted run
// tests/cli/screens.ts uses; the light one with the colours the CLI picks on a
// light terminal), so the picture can't drift from the tool.
// tests/tools/readme_media.test.ts fails when either is stale.
//
//   npx tsx scripts/readme-media.ts      (writes both files)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render, type Screen } from "../tests/cli/screens.js";

// ── layout ──────────────────────────────────────────────────────────────────
const FONT = 13;       // px
const CW = 7.8;        // one column: 0.6 em, the advance of the usual monospace fonts
const LH = 19;         // one row
const PAD_X = 22;
const BAR = 36;        // the window's title bar
const PAD_TOP = 16;
const PAD_BOTTOM = 18;
const COLS = 80;
const ROWS = 24;       // the window shows this many rows and scrolls, like a real terminal

export type Theme = "light" | "dark";
export const THEMES: readonly Theme[] = ["light", "dark"];

/** The window: its fill, its edge, the title bar's dots, and the default, bold and dim text. */
const WINDOW: Record<Theme, { ink: string; edge: string; dot: string; text: string; bold: string; dim: string }> = {
  light: { ink: "#f6f8fa", edge: "#d0d7de", dot: "#d8dee4", text: "#24292f", bold: "#1f2328", dim: "#636c76" },
  dark: { ink: "#0f1318", edge: "#253039", dot: "#2c3742", text: "#d7dee6", bold: "#f3f6f9", dim: "#8591a0" },
};

// ── timing (seconds) ────────────────────────────────────────────────────────
const CYCLE = 17;      // one loop
const HOLD_UNTIL = 0.96; // of the cycle; then the screen clears and it starts again
const pauseAfter = (line: string): number =>
  /Waiting for you to log in/.test(line) ? 1.5
    : /^\? /.test(line) ? 0.9
    : /^\[\d\/\d\]/.test(line) ? 0.25
    : /^(Found on|Next)/.test(line) ? 0.3
    : 0.11;
const pauseBefore = (line: string): number => (/^\[\d\/\d\]/.test(line) || /^Next/.test(line) ? 0.45 : 0);

// ── ANSI → cells ────────────────────────────────────────────────────────────
interface Cell { ch: string; fg: string | null; bg: string | null; bold: boolean; dim: boolean }

function cells(ansi: string): Cell[][] {
  const rows: Cell[][] = [[]];
  let fg: string | null = null, bg: string | null = null, bold = false, dim = false;
  for (const part of ansi.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) {
      for (const ch of part) {
        if (ch === "\n") rows.push([]);
        else rows[rows.length - 1]!.push({ ch, fg, bg, bold, dim });
      }
      continue;
    }
    const codes = m[1]!.split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 38 && codes[i + 1] === 2) { fg = `rgb(${codes.slice(i + 2, i + 5).join(",")})`; i += 4; }
      else if (c === 48 && codes[i + 1] === 2) { bg = `rgb(${codes.slice(i + 2, i + 5).join(",")})`; i += 4; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c === 39) fg = null;
      else if (c === 49) bg = null;
      else if (c === 0) { fg = null; bg = null; bold = false; dim = false; }
    }
  }
  return rows;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (n: number): string => String(Math.round(n * 100) / 100);
const BLOCKS = new Set(["▀", "▄", "█"]);

/** One row as SVG: half-block cells (the logo) as rectangles, the rest as text placed by column. */
function row(line: Cell[], y: number, w: (typeof WINDOW)[Theme]): string {
  const out: string[] = [];
  const spans: string[] = [];
  let run = "", runX = 0, runStyle = "";
  const flush = (): void => {
    if (run.trim()) spans.push(`<tspan x="${num(PAD_X + runX * CW)}"${runStyle}>${esc(run.replace(/\s+$/, ""))}</tspan>`);
    run = "";
  };
  line.forEach((cell, x) => {
    if (BLOCKS.has(cell.ch)) {
      flush();
      const top = cell.ch === "▄" ? null : cell.fg, bottom = cell.ch === "▀" ? cell.bg : cell.fg;
      const px = num(PAD_X + x * CW);
      // A hair bigger than the cell, with crisp edges, so neighbours meet without a seam.
      if (top) out.push(`<rect class="p" x="${px}" y="${num(y)}" width="${num(CW + 0.5)}" height="${num(LH / 2 + 0.5)}" fill="${top}"/>`);
      if (bottom) out.push(`<rect class="p" x="${px}" y="${num(y + LH / 2)}" width="${num(CW + 0.5)}" height="${num(LH / 2 + 0.5)}" fill="${bottom}"/>`);
      return;
    }
    const fill = cell.fg ?? (cell.bold ? w.bold : cell.dim ? w.dim : null);
    const style = `${fill ? ` fill="${fill}"` : ""}${cell.bold ? ' font-weight="700"' : ""}`;
    const prev = line[x - 1]?.ch ?? "";
    // Start a new run at a style change, after a gap of spaces, and around a
    // non-ASCII glyph: each run is placed by its column, so a font whose
    // glyphs are a little wide or narrow can't push the columns apart.
    const gap = cell.ch !== " " && prev === " " && line[x - 2]?.ch === " ";
    const odd = /[^\x20-\x7e]/.test(cell.ch) || /[^\x20-\x7e]/.test(prev);
    if (run === "" || style !== runStyle || gap || odd) { flush(); runX = x; runStyle = style; }
    run += cell.ch;
  });
  flush();
  if (spans.length) out.push(`<text y="${num(y + LH * 0.72)}">${spans.join("")}</text>`);
  return out.join("");
}

export async function heroSvg(theme: Theme): Promise<string> {
  const w = WINDOW[theme];
  const screen: Screen = {
    name: "readme-hero", command: "totem local", about: "The README's hero: a first run that finds five apps.",
    setup: (w) => mkdirSync(join(w.home, "Library", "Application Support", "Claude"), { recursive: true }),
  };
  const { text } = await render(screen, { color: true, unicode: true, width: COLS, palette: "truecolor", light: theme === "light" });
  const lines = cells(text.replace(/^\n+|\n+$/g, ""));
  const plain = lines.map((l) => l.map((c) => c.ch).join(""));

  const width = PAD_X * 2 + COLS * CW;
  const top = BAR + PAD_TOP;
  const total = lines.length + 2; // the prompt, a blank row, then the output
  const height = top + Math.min(total, ROWS) * LH + PAD_BOTTOM;

  // When each row appears. The prompt is there from the start.
  let t = 0.9;
  const at = plain.map((line) => {
    if (line.trim() === "") return t;
    t += pauseBefore(line);
    const mine = t;
    t += pauseAfter(line);
    return mine;
  });
  if (t > CYCLE * HOLD_UNTIL - 2) throw new Error(`The run takes ${t.toFixed(1)}s: raise CYCLE so the finished screen holds for a while.`);

  // The window scrolls like a terminal: a row that would land below the last
  // visible one moves everything up first.
  const scrollAt: Array<[seconds: number, rows: number]> = [];
  plain.forEach((line, i) => {
    const over = i + 3 - ROWS;
    if (line.trim() !== "" && over > (scrollAt.at(-1)?.[1] ?? 0)) scrollAt.push([at[i]!, over]);
  });
  const up = (rows: number): string => `transform:translateY(${num(-rows * LH)}px)`;
  let scroll = `0%{${up(0)}}`, scrolled = 0;
  for (const [seconds, rows] of scrollAt) {
    const p = num((seconds / CYCLE) * 100);
    scroll += `${p}%{${up(scrolled)}}${num(Number(p) + 0.01)}%{${up(rows)}}`;
    scrolled = rows;
  }
  scroll += `100%{${up(scrolled)}}`;

  const css = [
    `text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px;fill:${w.text};white-space:pre}`,
    `.bar{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px;fill:${w.dim}}`,
    `.p{shape-rendering:crispEdges}`,
    // Rows are visible and the window is scrolled to the end unless the
    // animation says otherwise, so a viewer that doesn't animate (or asks for
    // less motion) sees the finished screen.
    `.s{${up(scrolled)};animation:s ${CYCLE}s linear infinite}@keyframes s{${scroll}}`,
    ...at.map((s, i) => {
      const p = num((s / CYCLE) * 100);
      return `@keyframes r${i}{0%,${p}%{opacity:0}${num(Number(p) + 0.01)}%,${HOLD_UNTIL * 100}%{opacity:1}100%{opacity:0}}.r${i}{animation:r${i} ${CYCLE}s linear infinite}`;
    }),
    `@media (prefers-reduced-motion:reduce){g{animation:none}}`,
  ].join("");

  const body = lines.map((line, i) => (plain[i]!.trim() === "" ? "" : `<g class="r${i}">${row(line, top + (i + 2) * LH, w)}</g>`)).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}" width="${num(width)}" height="${num(height)}" role="img" aria-labelledby="t d">`,
    `<title id="t">totem local</title>`,
    `<desc id="d">A terminal running totem local: it checks Node.js, logs in to WHOOP in a browser window, then adds totem to Claude Desktop, Claude Code, ChatGPT, OpenCode and Antigravity.</desc>`,
    `<style>${css}</style>`,
    `<rect x="0.5" y="0.5" width="${num(width - 1)}" height="${num(height - 1)}" rx="10" fill="${w.ink}" stroke="${w.edge}"/>`,
    `<path d="M0.5 ${BAR}.5H${num(width - 0.5)}" stroke="${w.edge}"/>`,
    ...[0, 1, 2].map((i) => `<circle cx="${20 + i * 20}" cy="${BAR / 2}" r="5.5" fill="${w.dot}"/>`),
    `<text class="bar" x="${num(width / 2)}" y="${BAR / 2 + 4}" text-anchor="middle">totem local</text>`,
    `<clipPath id="v"><rect x="0" y="${top + 1}" width="${num(width)}" height="${ROWS * LH}"/></clipPath>`,
    `<g clip-path="url(#v)"><g class="s">`,
    `<text y="${num(top + LH * 0.72)}"><tspan x="${PAD_X}" fill="${w.dim}">$</tspan><tspan x="${num(PAD_X + 2 * CW)}" fill="${w.bold}">totem local</tspan></text>`,
    body,
    `</g></g>`,
    `</svg>`,
    "",
  ].join("\n");
}

export const heroPath = (theme: Theme): URL => new URL(`../docs/media/totem-local-${theme}.svg`, import.meta.url);

if (process.argv[1] && /readme-media\.ts$/.test(process.argv[1])) {
  for (const theme of THEMES) writeFileSync(heroPath(theme), await heroSvg(theme));
}
