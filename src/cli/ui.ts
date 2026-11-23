// The CLI's visual language: one small set of primitives every screen is built
// from, so `totem local`, `totem cloud`, `totem auth`, `totem update` and the
// rest read as one tool. It is plain on purpose, like the CLIs people already
// use (gh, fly, vercel): text first, colour as a seasoning, no boxes or rails.
// The one picture is the logo, at the top of the big flows.
//
//   banner      the logo (rasterized from the SVG) beside a title: home, cloud, local
//   header      "totem <command>" and a one-line purpose, at the top of a command
//   step        "[2/6] Secrets": where you are in a flow
//   section     a bold title inside a screen
//   ok/warn/fail/info   one-line results, each led by a mark: "✓ Deployed [1m 42s]"
//   para/hint   wrapped prose: what is happening, what to do now
//   rows        aligned "Key: value" facts
//   code        something to paste, alone on its line
//   next        "Next" and what to do now
//   problem     what went wrong + the exact commands that fix it
//   task        a spinner with elapsed time for anything slow
//   select/confirm/text/hidden   the four prompts
//
// Rendering is separate from effects. `kit(style)` returns pure functions that
// turn data into lines; `Ui` writes those lines somewhere and asks questions.
// A screen can therefore be rendered in a test with a fixed Style and no
// terminal. Nothing here spawns a process or touches the network (see sys.ts).
//
// Rules the primitives enforce:
//   - 80 columns at most, less on a narrow terminal; prose wraps, pasteable
//     lines never get a border or a prefix.
//   - Colour is decoration only: every state is also a glyph and a word. It
//     is off for NO_COLOR, TERM=dumb and anything that isn't a terminal. The
//     logo is only drawn where there is colour.
//   - One icy palette (see "colour"), bold and dim, nothing else. Exact where
//     the terminal draws 24-bit colour, the nearest of 256 otherwise, the basic
//     colours nearest in meaning on a basic terminal, and darker when the
//     terminal says its background is light.
//   - ASCII glyphs where Unicode can't be trusted (legacy Windows consoles,
//     TERM=dumb/linux, a non-UTF-8 locale).
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { logoPixels, type Pixel } from "./logo.js";

// ── style ───────────────────────────────────────────────────────────────────

export interface Style {
  color: boolean;
  unicode: boolean;
  /** Columns to lay out for: the terminal's width, kept between 40 and 80. */
  width: number;
  /** Colours the terminal can draw; the palette and the logo use more than the basic ones where they can. Default "basic". */
  palette?: "basic" | "256" | "truecolor";
  /** The terminal reports a light background (COLORFGBG), so every colour goes darker. */
  light?: boolean;
  /** Draw the logo in a banner. Default: wherever there is colour and Unicode. */
  logo?: boolean;
}

type Env = Record<string, string | undefined>;
interface StreamLike { isTTY?: boolean | undefined; columns?: number | undefined }

const set = (v: string | undefined): boolean => v !== undefined && v !== "";

export function detectStyle(stream: StreamLike = process.stdout, env: Env = process.env, platform: NodeJS.Platform = process.platform): Style {
  const color = set(env.NO_COLOR) ? false
    : set(env.FORCE_COLOR) && env.FORCE_COLOR !== "0" ? true
    : env.TERM === "dumb" ? false
    : Boolean(stream.isTTY);
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const unicode = env.TOTEM_ASCII === "1" ? false
    : env.TERM === "dumb" || env.TERM === "linux" ? false
    // Windows: only terminals known to render UTF-8 (Windows Terminal, VS Code,
    // ConEmu, anything that sets TERM). The legacy console gets ASCII.
    : platform === "win32" ? Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuTask || env.TERM)
    : locale === "" || /utf-?8/i.test(locale);
  const columns = stream.isTTY && stream.columns ? stream.columns : 80;
  const palette = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") || TRUECOLOR_APPS.has(env.TERM_PROGRAM ?? "") || set(env.WT_SESSION) ? "truecolor"
    : /256/.test(env.TERM ?? "") ? "256"
    : "basic";
  // COLORFGBG is "fg;bg" (sometimes "fg;default;bg"); 7 and 15 are the light greys and white.
  const bg = (env.COLORFGBG ?? "").split(";").pop();
  return { color, unicode, width: Math.max(40, Math.min(80, columns)), palette, light: bg === "7" || bg === "15" };
}

/** Terminals that draw 24-bit colour without saying so in COLORTERM. */
const TRUECOLOR_APPS = new Set(["iTerm.app", "WezTerm", "ghostty", "vscode", "Hyper"]);

export const PLAIN: Style = { color: false, unicode: true, width: 80 };

// ── glyphs ──────────────────────────────────────────────────────────────────

export interface Glyphs {
  ok: string; fail: string; warn: string; info: string;
  /** Menu path separator: Settings → Connectors. */
  arrow: string;
  pointer: string; ask: string; dot: string; ellipsis: string; dash: string;
  spinner: string[];
}
const UNICODE: Glyphs = {
  ok: "✓", fail: "✗", warn: "!", info: "•", arrow: "→", pointer: "›", ask: "?", dot: "·", ellipsis: "…", dash: "–",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};
const ASCII: Glyphs = {
  ok: "+", fail: "x", warn: "!", info: "-", arrow: ">", pointer: ">", ask: "?", dot: "-", ellipsis: "...", dash: "-",
  spinner: ["-", "\\", "|", "/"],
};
export const glyphs = (style: Style): Glyphs => (style.unicode ? UNICODE : ASCII);

// ── colour ──────────────────────────────────────────────────────────────────

// The brand's ice draws the logo and the brand word; the palette marks what
// needs you:
//   lead     the step you are on, the spinner, a question, the choice and the answer
//   command  something to run or paste
//   link     an address
//   secret   the one-time connector password
//   ok / warn / fail   done, a warning, a failure
//   dim: everything secondary
export interface Paint {
  bold(s: string): string; dim(s: string): string;
  /** The palette's ok, warn and fail colours. */
  red(s: string): string; green(s: string): string; yellow(s: string): string;
  /** Ice: the logo and the brand word. */
  brand(s: string): string;
  /** A command to run or paste. */
  accent(s: string): string;
  /** Lead: the current step, the spinner, a question, the highlighted choice and the answer given. */
  ask(s: string): string;
  /** An address: the server and connector URLs. */
  link(s: string): string;
  /** The one-time connector password. */
  secret(s: string): string;
}

type Shade = "ice" | "fold";
// [r, g, b] and the nearest xterm-256 colour, on a dark and on a light background.
const SHADES: Record<"dark" | "light", Record<Shade, [rgb: string, x256: number, basic: number]>> = {
  dark: { ice: ["183;211;242", 153, 94], fold: ["122;156;198", 110, 34] },
  light: { ice: ["122;156;198", 110, 34], fold: ["79;111;153", 67, 34] },
};

/** The SGR code for a brand shade: ice #B7D3F2 (default) or fold #7A9CC6, a step darker on a light background. `bg` paints the cell behind. */
export function brandSgr(style: Style, shade: Shade = "ice", bg = false): string {
  const [rgb, x256, basic] = SHADES[style.light ? "light" : "dark"][shade];
  if (style.palette === "truecolor") return `${bg ? 48 : 38};2;${rgb}`;
  if (style.palette === "256") return `${bg ? 48 : 38};5;${x256}`;
  return String(bg ? basic + 10 : basic);
}

export type Role = "lead" | "command" | "link" | "secret" | "ok" | "warn" | "fail";

/**
 * The palette: glacier colours beside the brand's ice, chosen in OKLCH so
 * their lightness is even and no one colour shouts over the others. Warnings
 * and failures stay warm, so a problem still reads as one. The terminal gets
 * these hues at a lightness it can read: lighter on a dark background
 * (onDark), darker on a light one (onLight).
 */
export const PALETTE: Record<Role, string> = {
  lead: "#71C9FA", // glacier blue
  command: "#72DEE4", // arctic cyan
  link: "#B2B8F7", // frost lavender
  secret: "#E5F4FE", // snow
  ok: "#88E1D0", // glacial mint
  warn: "#F0D49B", // winter sun
  fail: "#EB8A99", // frostbite rose
};
/** A basic terminal has eight colours and its own idea of them: the nearest by meaning. */
const BASIC_ROLE: Record<Role, number> = { lead: 36, command: 37, link: 36, secret: 37, ok: 32, warn: 33, fail: 31 };

type Rgb = [number, number, number];
const hexRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** Relative luminance (WCAG): 0 for black, 1 for white. */
const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** WCAG contrast between two luminances: 1 (none) to 21 (black on white). */
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** The dark background colours are judged against: #1E1E1E, a typical dark terminal theme. */
const DARK_BG = luminance([30, 30, 30]);

/**
 * The same hue at the first lightness, walking from its own in steps of
 * `step`, that has 4.5:1 contrast with a background of luminance `bg`
 * (WCAG's bar for text).
 */
function readableOn([r, g, b]: Rgb, bg: number, step: number): Rgb {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  // The hue as a sixth of the circle, 0 to 6 (a remainder in JS keeps its sign, so wrap it).
  const h = d === 0 ? 0 : max === R ? (((G - B) / d) % 6 + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  const fromHsl = (L: number): Rgb => {
    const C = (1 - Math.abs(2 * L - 1)) * s, X = C * (1 - Math.abs((h % 2) - 1)), m = L - C / 2;
    const [r1, g1, b1] = h < 1 ? [C, X, 0] : h < 2 ? [X, C, 0] : h < 3 ? [0, C, X] : h < 4 ? [0, X, C] : h < 5 ? [X, 0, C] : [C, 0, X];
    return [r1, g1, b1].map((v) => Math.round((v + m) * 255)) as Rgb;
  };
  for (let L = l; L >= 0 && L <= 1; L += step) {
    const out = fromHsl(L);
    if (contrast(luminance(out), bg) >= 4.5) return out;
  }
  return step < 0 ? [0, 0, 0] : [255, 255, 255];
}

/** Dark enough to read on white. Yellow and lime come down much further than violet. */
export const onLight = (rgb: Rgb): Rgb => readableOn(rgb, 1, -0.01);
/** Light enough to read on a dark terminal. Electric indigo comes up to a lavender. */
export const onDark = (rgb: Rgb): Rgb => readableOn(rgb, DARK_BG, 0.01);

/** The nearest of xterm's 256 colours: the 6×6×6 cube or the grey ramp. */
export function xterm256([r, g, b]: Rgb): number {
  const levels = [0, 95, 135, 175, 215, 255];
  const near = (v: number): number => levels.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(levels[best]! - v) ? i : best), 0);
  const [ri, gi, bi] = [near(r), near(g), near(b)];
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const dist = (x: Rgb): number => (x[0] - r) ** 2 + (x[1] - g) ** 2 + (x[2] - b) ** 2;
  const cube: Rgb = [levels[ri]!, levels[gi]!, levels[bi]!];
  const g8 = 8 + 10 * grey;
  return dist(cube) <= dist([g8, g8, g8]) ? 16 + 36 * ri + 6 * gi + bi : 232 + grey;
}

/** The SGR code for one of the palette's colours. */
export function roleSgr(style: Style, role: Role): string {
  if (style.palette !== "truecolor" && style.palette !== "256") return String(BASIC_ROLE[role]);
  const base = hexRgb(PALETTE[role]);
  const rgb = style.light ? onLight(base) : onDark(base);
  return style.palette === "truecolor" ? `38;2;${rgb.join(";")}` : `38;5;${xterm256(rgb)}`;
}

export function paint(style: Style): Paint {
  const sgr = (open: number | string, close: number | string) => (s: string): string => (style.color && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  const role = (r: Role) => sgr(roleSgr(style, r), 39);
  return {
    bold: sgr(1, 22), dim: sgr(2, 22), red: role("fail"), green: role("ok"), yellow: role("warn"),
    brand: sgr(brandSgr(style), 39),
    accent: role("command"), ask: role("lead"), link: role("link"), secret: sgr(`1;${roleSgr(style, "secret")}`, "39;22"),
  };
}

// ── text ────────────────────────────────────────────────────────────────────

/** Columns a string takes on screen (escape sequences don't count). */
export const visibleWidth = (s: string): number => [...stripVTControlCharacters(s)].length;

export const padEnd = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - visibleWidth(s)));

/**
 * Word-wrap to `width` columns. A word longer than the line (a URL, a path, a
 * command) stays whole on its own line: it is never cut, because a cut value
 * can't be pasted.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === "") line = word;
      else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) line += " " + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/**
 * wrap(), keeping a list marker hanging: the lines after "1. " or "- " start
 * under the text, not under the marker.
 */
export function wrapHanging(text: string, width: number): string[] {
  const marker = text.match(/^(\d+\.|[-*])\s+/)?.[0];
  if (!marker) return wrap(text, width);
  const pad = " ".repeat(marker.length);
  return wrap(text.slice(marker.length), width - marker.length).map((l, i) => (i === 0 ? marker + l : pad + l));
}

/** Cut to `width` columns with an ellipsis: for output that must stay one line per line. */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  return visibleWidth(text) <= width ? text : [...text].slice(0, Math.max(0, width - ellipsis.length)).join("") + ellipsis;
}

/** "a", "a and b", "a, b and c". */
export function listOf(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "42s", "1m 42s"; empty under a second. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "";
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** An ISO timestamp as "2026-11-21 23:10 UTC" (the same on every machine). */
export function when(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : `${t.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A path as one shell word: quoted when it has a space or a quote in it. */
export const shellPath = (p: string): string => (/[\s'"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

/**
 * One shell command as lines of at most `width` columns, split between
 * arguments with a trailing backslash so the block still pastes as one
 * command. Windows shells have no shared continuation character, so there the
 * command stays on one line.
 */
export function shellLines(words: string[], width: number, platform: NodeJS.Platform = process.platform): string[] {
  const one = words.join(" ");
  if (platform === "win32" || visibleWidth(one) <= width) return [one];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    // Leave room for the " \" that marks a continued line.
    if (line !== "" && visibleWidth(candidate) + 2 > width) { lines.push(line); line = "  " + word; } else line = candidate;
  }
  lines.push(line);
  return lines.map((l, i) => (i < lines.length - 1 ? `${l} \\` : l));
}

// ── primitives (pure) ───────────────────────────────────────────────────────

export type Mark = "ok" | "fail" | "warn" | "info";
/** A way out of a problem: what it does, and the exact command. */
export type Fix = [label: string, command: string];

/** Columns the logo takes, and the gap after it. */
const LOGO_COLS = 12;
const LOGO_ROWS = 5;
const LOGO_GAP = 3;

export interface Kit {
  style: Style;
  g: Glyphs;
  c: Paint;
  /** Whether banner() draws the logo here. */
  logo: boolean;
  /** The logo with a title and purpose beside it; without a logo, header(). */
  banner(title: string, subtitle?: string, meta?: string): string[];
  /** "totem <command>" and its purpose under it. */
  header(title: string, subtitle?: string): string[];
  /** "[2/6] Secrets". */
  step(n: number, total: number, title: string): string[];
  section(title: string): string[];
  mark(kind: Mark, text: string, detail?: string): string[];
  para(text: string, indent?: number): string[];
  hint(text: string, indent?: number): string[];
  rows(pairs: Array<[key: string, value: string]>, indent?: number): string[];
  code(lines: string[], indent?: number): string[];
  /** "Next" and what to do now. */
  next(lines: string[], title?: string): string[];
  /** A question as it is asked: "? Question (suffix)". */
  question(question: string, suffix?: string): string;
  /** A question once it is answered: "? Question answer", what stays on screen after a choice. */
  answered(question: string, answer: string): string;
  problem(what: string, opts?: { detail?: string | string[] | undefined; fix?: Fix[] | undefined }, indent?: number): string[];
}

/** An http(s) address inside prose, without trailing punctuation. Capturing, so split() keeps it. */
const URL_IN_TEXT = /(https?:\/\/[^\s)]*[^\s).,;:'"])/;
/** A time a step took ("4s", "1m 42s"): shown in brackets, the rest of a detail in parentheses. */
const TIME = /^\d+(m \d{2})?s$/;

export function kit(style: Style): Kit {
  const g = glyphs(style);
  const c = paint(style);
  const W = style.width;
  const symbol: Record<Mark, string> = { ok: c.green(g.ok), fail: c.red(g.fail), warn: c.yellow(g.warn), info: c.dim(g.info) };
  const logo = (style.logo ?? (style.color && style.unicode)) && style.unicode && W >= 56;
  // Addresses in the link colour wherever they turn up, the rest in `rest`.
  // Text that already carries colour is left as it is.
  const urls = (text: string, rest: (s: string) => string = (s) => s): string =>
    text.includes("\x1b[") ? text : text.split(URL_IN_TEXT).map((part, i) => (i % 2 ? c.link(part) : part ? rest(part) : "")).join("");
  // Commands inside prose in the command colour: "…: totem status", "run: codex mcp login whoop".
  const commands = (text: string): string =>
    text.replace(/(: |run: )(totem [a-z][\w -]*|[a-z]+ mcp [\w -]+)(?=\)|\.?$)/, (_m, lead: string, cmd: string) => `${lead}${c.accent(cmd.trimEnd())}`);

  const mark = (kind: Mark, text: string, detail?: string): string[] => {
    const lines = wrap(text, W - 2).map((line, i) => `${i === 0 ? symbol[kind] : " "} ${line}`);
    if (!detail) return lines;
    // "✓ Deployed [1m 42s]", "✓ Signed in to Fly (you@example.com)"; on its own line when it doesn't fit.
    const tail = TIME.test(detail) ? `[${detail}]` : `(${detail})`;
    const last = lines[lines.length - 1]!;
    if (visibleWidth(last) + 1 + visibleWidth(tail) <= W) lines[lines.length - 1] = `${last} ${urls(tail, c.dim)}`;
    else for (const d of wrap(detail, W - 2)) lines.push(`  ${urls(d, c.dim)}`);
    return lines;
  };

  const rows = (pairs: Array<[string, string]>, indent = 2): string[] => {
    const keyWidth = Math.max(...pairs.map(([k]) => visibleWidth(k))) + 3;
    const pad = " ".repeat(indent);
    return pairs.flatMap(([key, value]) => {
      const lines = wrap(value, Math.max(16, W - indent - keyWidth));
      return lines.map((line, i) => `${pad}${i === 0 ? c.dim(padEnd(`${key}:`, keyWidth)) : " ".repeat(keyWidth)}${urls(line)}`);
    });
  };

  // "totem cloud": the brand word in ice, the whole title bold.
  const name = (title: string): string => {
    const [brandWord, ...rest] = title.split(" ");
    return c.bold(`${c.brand(brandWord!)}${rest.length ? ` ${rest.join(" ")}` : ""}`);
  };
  const header = (title: string, subtitle?: string): string[] => [name(title), ...(subtitle ? wrap(subtitle, W).map((l) => c.dim(l)) : [])];

  // Two pixels a cell: the upper in the foreground of a half block, the lower behind it.
  const logoRows = (): string[] => {
    const px = logoPixels(LOGO_COLS, LOGO_ROWS * 2);
    const fg = (p: Exclude<Pixel, null>, ch: string): string => (style.color ? `\x1b[${brandSgr(style, p)}m${ch}\x1b[39m` : ch);
    const cell = (top: Pixel, bottom: Pixel): string => {
      if (!top && !bottom) return " ";
      if (!top) return fg(bottom!, "▄");
      if (!bottom) return fg(top, "▀");
      if (top === bottom) return fg(top, "█");
      return style.color ? `\x1b[${brandSgr(style, top)};${brandSgr(style, bottom, true)}m▀\x1b[39;49m` : "▀";
    };
    return Array.from({ length: LOGO_ROWS }, (_, r) => px[2 * r]!.map((top, x) => cell(top, px[2 * r + 1]![x]!)).join(""));
  };

  return {
    style, g, c, logo,
    banner: (title, subtitle, meta) => {
      if (!logo) return header(title, subtitle);
      const textWidth = W - 1 - LOGO_COLS - LOGO_GAP;
      // The title on the logo's second row, the purpose and meta under it.
      const text = ["", name(title), ...(subtitle ? wrap(subtitle, textWidth).map((l) => c.dim(l)) : []), ...(meta ? [c.dim(meta)] : [])];
      const art = logoRows();
      return Array.from({ length: Math.max(art.length, text.length) }, (_, i) => {
        const left = ` ${art[i] ?? " ".repeat(LOGO_COLS)}`;
        return text[i] ? `${left}${" ".repeat(LOGO_GAP)}${text[i]}` : art[i] ? left : "";
      });
    },
    header,
    step: (n, total, title) => [`${c.dim(`[${n}/${total}]`)} ${c.bold(title)}`],
    section: (title) => [title.includes("\x1b[") ? c.bold(title) : urls(title, c.bold)],
    question: (question, suffix = "") => `${c.ask(g.ask)} ${c.bold(question)}${suffix ? " " + c.dim(suffix) : ""}`,
    answered: (question, answer) => `${c.ask(g.ask)} ${c.bold(question)} ${c.ask(answer)}`,
    mark,
    para: (text, indent = 0) => wrapHanging(text, W - indent).map((l) => " ".repeat(indent) + l),
    hint: (text, indent = 2) => wrap(text, W - indent).map((l) => " ".repeat(indent) + c.dim(l)),
    rows,
    code: (lines, indent = 2) => lines.map((l) => " ".repeat(indent) + c.accent(l)),
    next: (lines, title = "Next") => {
      // Numbered steps keep their number in the lead colour, commands in theirs.
      const body = lines.flatMap((l) => (l === "" ? [""] : wrapHanging(commands(urls(l)), W - 2).map((w) => w.replace(/^(\d+\.)(?= )/, (m) => c.ask(m)))));
      return [c.bold(title), ...body.map((l) => (l === "" ? "" : `  ${l}`))];
    },
    problem: (what, opts = {}, indent = 0) => {
      const pad = " ".repeat(indent);
      const head = wrap(what, W - indent - 2).map((l, i) => `${pad}${i === 0 ? c.red(g.fail) : " "} ${c.bold(l)}`);
      // A string is prose and wraps. An array is a command's own output, line by
      // line: a long line continues indented, so where each one starts stays
      // visible and nothing (the exit code at the end, say) is cut off.
      const details = (Array.isArray(opts.detail)
        ? opts.detail.flatMap((d) => wrap(d, W - indent - 4).map((l, i) => (i === 0 ? l : `  ${l}`)))
        : opts.detail ? wrap(opts.detail, W - indent - 2) : [])
        .map((l) => `${pad}  ${c.dim(l)}`);
      const fix = opts.fix ?? [];
      const labelWidth = fix.length ? Math.max(...fix.map(([label]) => visibleWidth(label))) + 3 : 0;
      const fixes = fix.map(([label, command]) => `${pad}  ${padEnd(label, labelWidth)}${c.accent(command)}`);
      return [...head, ...details, ...fixes];
    },
  };
}

// ── prompts ─────────────────────────────────────────────────────────────────

/**
 * A question was asked and the input ended before an answer came (stdin closed
 * or redirected from /dev/null, Ctrl-D at the prompt).
 *
 * No answer is not an answer: it must never be read as "take the default"
 * (`totem cloud < /dev/null` once said yes to every deploy gate). Every prompt
 * throws this instead, and the command stops.
 */
export class InputClosedError extends Error {
  constructor(public readonly question: string) {
    super("Input ended before the question was answered.");
    this.name = "InputClosedError";
  }
}

export interface Choice {
  label: string;
  hint?: string | undefined;
}

// Piped input: ONE line reader per input stream for the life of the process.
// A readline opened per question reads ahead, so with several answers piped in
// at once the first question's reader swallowed the lines meant for the next.
interface PipedLines { lines: string[]; waiters: Array<(line: string | null) => void>; ended: boolean }
const pipedReaders = new WeakMap<object, PipedLines>();
function pipedLine(signal?: AbortSignal): Promise<string | null> {
  const stdin = process.stdin;
  let state = pipedReaders.get(stdin);
  if (!state) {
    const fresh: PipedLines = { lines: [], waiters: [], ended: false };
    const rl = createInterface({ input: stdin, terminal: false });
    rl.on("line", (line) => { const w = fresh.waiters.shift(); if (w) w(line); else fresh.lines.push(line); });
    rl.on("close", () => { fresh.ended = true; for (const w of fresh.waiters.splice(0)) w(null); });
    pipedReaders.set(stdin, fresh);
    state = fresh;
  }
  if (signal?.aborted) return Promise.resolve(null);
  if (state.lines.length) return Promise.resolve(state.lines.shift()!);
  if (state.ended) return Promise.resolve(null);
  const waiting = state;
  return new Promise((resolve) => {
    // A withdrawn question gives up its place, so its line goes to the next one.
    const take = (line: string | null): void => { signal?.removeEventListener("abort", drop); resolve(line); };
    const drop = (): void => { const i = waiting.waiters.indexOf(take); if (i >= 0) waiting.waiters.splice(i, 1); resolve(null); };
    waiting.waiters.push(take);
    signal?.addEventListener("abort", drop, { once: true });
  });
}

/** A question taken back before anyone answered it (see Ui.confirmUntil). */
class Withdrawn extends Error {}

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const CLEAR_LINE = "\r\x1b[2K";

// ── Ui: writes the primitives and asks the questions ─────────────────────────

export interface UiOptions {
  style?: Style;
  /** Where screens go. Default: stdout. */
  write?: (text: string) => void;
  /** Where top-level problems go. Default: stderr. */
  writeErr?: (text: string) => void;
  /** Animate spinners and menus (a real terminal on both ends). */
  live?: boolean;
  /** Someone can answer a question (stdin is a terminal). */
  canAsk?: boolean;
  now?: () => number;
}

export class Ui {
  readonly style: Style;
  readonly live: boolean;
  readonly canAsk: boolean;
  protected readonly write: (text: string) => void;
  protected readonly writeErr: (text: string) => void;
  protected readonly now: () => number;
  readonly kit: Kit;

  constructor(opts: UiOptions = {}) {
    this.style = opts.style ?? detectStyle();
    this.kit = kit(this.style);
    this.write = opts.write ?? ((text) => { process.stdout.write(text); });
    this.writeErr = opts.writeErr ?? ((text) => { process.stderr.write(text); });
    this.live = opts.live ?? (Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY) && process.env.TERM !== "dumb");
    this.canAsk = opts.canAsk ?? Boolean(process.stdin.isTTY);
    this.now = opts.now ?? Date.now;
  }

  // output ────────────────────────────────────────────────────────────────
  private blank = false;
  /** One line. Two blank lines in a row become one, so primitives can each ask for air. */
  line(text = ""): void {
    if (text === "" && this.blank) return;
    this.blank = text === "";
    this.write(text + "\n");
  }
  lines(lines: string[]): void { for (const l of lines) this.line(l); }
  /** The logo and a title, at the top of a big flow. */
  banner(title: string, subtitle?: string, meta?: string): void { this.lines(["", ...this.kit.banner(title, subtitle, meta), ""]); }
  header(title: string, subtitle?: string): void { this.lines(["", ...this.kit.header(title, subtitle), ""]); }
  step(n: number, total: number, title: string): void { this.lines(["", ...this.kit.step(n, total, title)]); }
  section(title: string): void { this.lines(["", ...this.kit.section(title)]); }
  ok(text: string, detail?: string): void { this.lines(this.kit.mark("ok", text, detail)); }
  warn(text: string, detail?: string): void { this.lines(this.kit.mark("warn", text, detail)); }
  fail(text: string, detail?: string): void { this.lines(this.kit.mark("fail", text, detail)); }
  info(text: string, detail?: string): void { this.lines(this.kit.mark("info", text, detail)); }
  para(text: string, indent?: number): void { this.lines(this.kit.para(text, indent)); }
  hint(text: string, indent?: number): void { this.lines(this.kit.hint(text, indent)); }
  rows(pairs: Array<[string, string]>, indent?: number): void { this.lines(this.kit.rows(pairs, indent)); }
  code(lines: string[], indent?: number): void { this.lines(this.kit.code(lines, indent)); }
  /** "Next" and what to do now. */
  next(lines: string[], title?: string): void { this.lines(["", ...this.kit.next(lines, title)]); }
  /** What went wrong and how to fix it, inside a flow. */
  problem(what: string, opts?: { detail?: string | string[] | undefined; fix?: Fix[] | undefined }): void {
    this.lines(this.kit.problem(what, opts));
  }
  /** A problem that ends the command: goes to stderr. */
  error(what: string, opts?: { detail?: string | string[] | undefined; fix?: Fix[] | undefined }): void {
    for (const l of this.kit.problem(what, opts)) this.writeErr(l + "\n");
  }

  // progress ──────────────────────────────────────────────────────────────
  /**
   * Run slow work under a spinner that counts the seconds, so a wait never
   * looks like a hang. `set(detail)` shows the latest thing happening (the
   * last line a subprocess printed). The spinner line disappears when the work
   * ends; the caller then prints the result with ok()/fail().
   *
   * Without a terminal there is nothing to animate: `slow` work gets one
   * plain "started" line so a log shows what it is waiting on.
   */
  async task<T>(label: string, work: (set: (detail: string) => void) => Promise<T>, opts: { slow?: boolean } = {}): Promise<T> {
    const { g, c } = this.kit;
    if (!this.live) {
      if (opts.slow) this.lines(this.kit.mark("info", c.dim(label + g.ellipsis)));
      return work(() => {});
    }
    const started = this.now();
    let detail = "";
    let frame = 0;
    const draw = (): void => {
      const ms = this.now() - started;
      const clock = ms >= 3000 ? ` ${c.dim(`[${duration(ms)}]`)}` : "";
      const head = `${c.ask(g.spinner[frame++ % g.spinner.length]!)} ${label}`;
      const room = this.style.width - visibleWidth(head) - visibleWidth(clock) - 3;
      const tail = detail && room > 8 ? `  ${c.dim(detail.length > room ? detail.slice(0, room - 1) + g.ellipsis : detail)}` : "";
      this.write(`${CLEAR_LINE}${head}${tail}${clock}`);
    };
    this.write(HIDE_CURSOR);
    draw();
    const timer = setInterval(draw, 90);
    try {
      return await work((d) => { detail = stripVTControlCharacters(d).replace(/\s+/g, " ").trim(); });
    } finally {
      clearInterval(timer);
      this.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
    }
  }

  // prompts ───────────────────────────────────────────────────────────────
  /** One line of input, or InputClosedError when the input ended instead. */
  protected async answer(query: string, question: string, signal?: AbortSignal): Promise<string> {
    let line: string | null;
    if (!process.stdin.isTTY) {
      this.write(query);
      line = await pipedLine(signal);
      this.write("\n");
      if (signal?.aborted) throw new Withdrawn();
    } else {
      // A fresh readline per question: a long-lived one breaks when a
      // subprocess in between (a login, a build) inherits stdin.
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // readline swallows Ctrl-C; turn it back into a clean exit.
      rl.on("SIGINT", () => { process.stdout.write(`${SHOW_CURSOR}\n`); process.exit(130); });
      try {
        line = await new Promise<string | null>((resolve) => {
          rl.once("close", () => resolve(null));
          rl.question(query, signal ? { signal } : {}).then(resolve).catch(() => resolve(null));
        });
      } finally {
        rl.close();
      }
      // Taken back: the question leaves the screen, as if never asked.
      if (signal?.aborted) { this.write(CLEAR_LINE); throw new Withdrawn(); }
    }
    this.blank = false;
    if (line === null) throw new InputClosedError(question);
    return line.trim();
  }

  protected q(question: string, suffix = ""): string {
    return this.kit.question(question, suffix);
  }

  /**
   * Yes or no. Enter takes the default; y/yes and n/no are the only other
   * answers. Anything else is asked again, then counts as no: a stray key is
   * not consent.
   */
  async confirm(question: string, defaultYes = true): Promise<boolean> {
    return this.yesNo(question, defaultYes);
  }

  /**
   * confirm(), unless `until` aborts first: something else settled it while
   * totem was still asking (a sign-in finished from a link pasted elsewhere).
   * Then the question leaves the screen and the answer is null.
   */
  async confirmUntil(question: string, until: AbortSignal, defaultYes = true): Promise<boolean | null> {
    try {
      return await this.yesNo(question, defaultYes, until);
    } catch (error) {
      if (error instanceof Withdrawn) return null;
      throw error;
    }
  }

  private async yesNo(question: string, defaultYes: boolean, signal?: AbortSignal): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = (await this.answer(`${this.q(question, defaultYes ? "(Y/n)" : "(y/N)")} `, question, signal)).toLowerCase();
      if (a === "") return defaultYes;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      this.hint("Answer y or n.");
    }
    return false;
  }

  /** Free text; Enter takes `fallback`. */
  async text(question: string, fallback = ""): Promise<string> {
    const a = await this.answer(`${this.q(question, fallback ? `(${fallback})` : "")}${this.kit.c.dim(":")} `, question);
    return a || fallback;
  }

  /**
   * A secret: nothing typed is shown, and nothing is trimmed. Readline does the
   * editing (paste markers, backspace, Ctrl-U) on a muted stream, so not even
   * its redraws reach the screen. Answers "" when the input ends.
   */
  async hidden(question: string): Promise<string> {
    const query = `${this.q(question, "(hidden)")}${this.kit.c.dim(":")} `;
    const stdin = process.stdin;
    this.blank = false;
    if (!stdin.isTTY) {
      this.write(query);
      const line = await pipedLine();
      this.write("\n");
      return line ?? "";
    }
    const wasRaw = stdin.isRaw;
    const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const rl = createInterface({ input: stdin, output: muted, terminal: true });
    rl.on("SIGINT", () => { rl.close(); process.stdout.write("\n"); process.exit(130); });
    this.write(query);
    try {
      return await new Promise<string>((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question("").then(resolve).catch(() => resolve(""));
      });
    } finally {
      rl.close();
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      muted.end();
      this.write("\n");
    }
  }

  /** The menu as it looks with `selected` chosen: what stays on screen after a choice. */
  menu(question: string, choices: Choice[], selected: number, active = false): string[] {
    const { c, g } = this.kit;
    const labelWidth = Math.max(...choices.map((ch) => visibleWidth(ch.label))) + 3;
    const room = this.style.width - 4 - labelWidth;
    return [
      this.q(question, active ? `(${this.style.unicode ? "↑↓" : "up/down"}, Enter)` : ""),
      ...choices.map((ch, i) => {
        const on = i === selected;
        const hint = ch.hint && room >= 12 ? c.dim(ch.hint.length > room ? ch.hint.slice(0, room - 1) + g.ellipsis : ch.hint) : "";
        const label = hint ? padEnd(ch.label, labelWidth) : ch.label;
        return `  ${on ? c.ask(g.pointer) : " "} ${on ? c.ask(label) : label}${hint}`;
      }),
    ];
  }

  /**
   * Pick one. On a terminal: arrows (or j/k, or a digit) move, Enter chooses.
   * Piped: a numbered list, answered with a number (Enter = the default).
   * Returns the index.
   */
  async select(question: string, choices: Choice[], defaultIndex = 0): Promise<number> {
    const n = choices.length;
    let idx = Math.min(Math.max(defaultIndex, 0), n - 1);
    const stdin = process.stdin;
    if (!this.live || typeof stdin.setRawMode !== "function") {
      const { c } = this.kit;
      const labelWidth = Math.max(...choices.map((ch) => visibleWidth(ch.label))) + 3;
      this.line(this.q(question));
      choices.forEach((ch, i) => this.line(`  ${c.ask(String(i + 1))}. ${ch.hint ? padEnd(ch.label, labelWidth) + c.dim(ch.hint) : ch.label}`));
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await this.answer(`  ${c.dim(`Number (${idx + 1}):`)} `, question);
        if (raw === "") return idx;
        const picked = Number(raw);
        if (Number.isInteger(picked) && picked >= 1 && picked <= n) return picked - 1;
        this.hint(`Enter a number from 1 to ${n}.`);
      }
      throw new InputClosedError(question);
    }

    const render = (first: boolean, active: boolean): void => {
      if (!first) this.write(`\x1b[${n + 1}A`);
      for (const l of this.menu(question, choices, idx, active)) this.write(`${CLEAR_LINE}${l}\n`);
    };
    render(true, true);
    this.blank = false;
    this.write(HIDE_CURSOR);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    return new Promise<number>((resolve) => {
      const cleanup = (): void => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        this.write(SHOW_CURSOR);
      };
      // Scan each chunk left to right: one read can carry several keys (a fast
      // double press, or an arrow and Enter together), and an escape sequence
      // can be split across two reads.
      let pending = "";
      const onData = (raw: string): void => {
        const chunk = pending + raw;
        pending = "";
        if (chunk.includes("\x03")) { cleanup(); this.write("\n"); process.exit(130); }
        if (chunk.includes("\x04")) { cleanup(); this.write("\n"); process.exit(130); }
        let i = 0;
        while (i < chunk.length) {
          const rest = chunk.slice(i);
          const ch = rest[0]!;
          if (ch === "\r" || ch === "\n") {
            // The menu folds into one line: the question and what was chosen.
            cleanup();
            this.write(`\x1b[${n + 1}A`);
            for (let k = 0; k <= n; k++) this.write(`${CLEAR_LINE}\n`);
            this.write(`\x1b[${n + 1}A${CLEAR_LINE}${this.kit.answered(question, choices[idx]!.label)}\n`);
            resolve(idx);
            return;
          }
          if (ch === "\x1b") {
            if (rest === "\x1b" || rest === "\x1b[") { pending = rest; break; }
            if (rest.startsWith("\x1b[A")) { idx = (idx - 1 + n) % n; i += 3; continue; }
            if (rest.startsWith("\x1b[B")) { idx = (idx + 1) % n; i += 3; continue; }
            i += Math.min(rest.length, 3);
            continue;
          }
          if (ch === "k") idx = (idx - 1 + n) % n;
          else if (ch === "j") idx = (idx + 1) % n;
          else if (/[1-9]/.test(ch) && Number(ch) <= n) idx = Number(ch) - 1;
          i += 1;
        }
        render(false, true);
      };
      stdin.on("data", onData);
    });
  }
}

/** Mask the value of any KEY=value whose key names a secret, for showing a command. */
export function maskSecrets(args: string[]): string {
  return args
    .map((a) => {
      const eq = a.indexOf("=");
      return eq > 0 && /(TOKEN|PASSWORD|SECRET|BEARER|REFRESH)/i.test(a.slice(0, eq)) ? `${a.slice(0, eq)}=***` : a;
    })
    .join(" ");
}
