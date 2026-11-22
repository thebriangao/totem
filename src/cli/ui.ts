// The CLI's visual language: one small set of primitives every screen is built
// from, so `totem local`, `totem cloud`, `totem auth`, `totem update` and the
// rest read as one tool.
//
//   header      title + one-line purpose, at the top of a screen
//   step        "2/6  Secrets": where you are in a guided flow
//   ok/warn/fail/info   one-line results, each led by a mark
//   para/hint   wrapped prose: what is happening, what to do now
//   rows        aligned key/value facts
//   code        something to paste, alone on its line with no decoration
//   next        the boxed "what to do now" block that ends a screen
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
//     is off for NO_COLOR, TERM=dumb and anything that isn't a terminal.
//   - The 8 basic ANSI colours, bold and dim, so the terminal's own theme
//     decides the shades (truecolor greys vanish on a light background).
//   - ASCII glyphs where Unicode can't be trusted (legacy Windows consoles,
//     TERM=dumb/linux, a non-UTF-8 locale).
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

// ── style ───────────────────────────────────────────────────────────────────

export interface Style {
  color: boolean;
  unicode: boolean;
  /** Columns to lay out for: the terminal's width, kept between 40 and 80. */
  width: number;
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
  return { color, unicode, width: Math.max(40, Math.min(80, columns)) };
}

export const PLAIN: Style = { color: false, unicode: true, width: 80 };

// ── glyphs ──────────────────────────────────────────────────────────────────

export interface Glyphs {
  ok: string; fail: string; warn: string; info: string;
  /** Menu path separator: Settings → Connectors. */
  arrow: string;
  pointer: string; ask: string; dot: string; ellipsis: string; dash: string;
  h: string; v: string; tl: string; tr: string; bl: string; br: string;
  spinner: string[];
}
const UNICODE: Glyphs = {
  ok: "✓", fail: "✗", warn: "!", info: "•", arrow: "→", pointer: "›", ask: "?", dot: "·", ellipsis: "…", dash: "–",
  h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};
const ASCII: Glyphs = {
  ok: "+", fail: "x", warn: "!", info: "-", arrow: ">", pointer: ">", ask: "?", dot: "-", ellipsis: "...", dash: "-",
  h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+",
  spinner: ["-", "\\", "|", "/"],
};
export const glyphs = (style: Style): Glyphs => (style.unicode ? UNICODE : ASCII);

// ── colour ──────────────────────────────────────────────────────────────────

export interface Paint {
  bold(s: string): string; dim(s: string): string;
  red(s: string): string; green(s: string): string; yellow(s: string): string;
  /** The one accent: step counters, things to copy, the selected choice. */
  accent(s: string): string;
}
export function paint(style: Style): Paint {
  const sgr = (open: number, close: number) => (s: string): string => (style.color && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), accent: sgr(36, 39) };
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

export interface Kit {
  style: Style;
  g: Glyphs;
  c: Paint;
  header(title: string, subtitle?: string): string[];
  step(n: number, total: number, title: string): string[];
  section(title: string): string[];
  mark(kind: Mark, text: string, detail?: string): string[];
  para(text: string, indent?: number): string[];
  hint(text: string, indent?: number): string[];
  rows(pairs: Array<[key: string, value: string]>, indent?: number): string[];
  code(lines: string[], indent?: number): string[];
  next(lines: string[], title?: string): string[];
  problem(what: string, opts?: { detail?: string | string[] | undefined; fix?: Fix[] | undefined }, indent?: number): string[];
}

export function kit(style: Style): Kit {
  const g = glyphs(style);
  const c = paint(style);
  const W = style.width;
  const symbol: Record<Mark, string> = { ok: c.green(g.ok), fail: c.red(g.fail), warn: c.yellow(g.warn), info: c.dim(g.info) };

  const mark = (kind: Mark, text: string, detail?: string): string[] => {
    const body = wrap(text, W - 4);
    const tail = detail ? `  ${c.dim(detail)}` : "";
    // The detail rides on the last line when it fits, else gets its own.
    const fits = visibleWidth(body[body.length - 1]!) + visibleWidth(tail) <= W - 4;
    const lines = body.map((line, i) => `  ${i === 0 ? symbol[kind] : " "} ${line}${fits && i === body.length - 1 ? tail : ""}`);
    if (detail && !fits) for (const d of wrap(detail, W - 4)) lines.push(`    ${c.dim(d)}`);
    return lines;
  };

  const rows = (pairs: Array<[string, string]>, indent = 2): string[] => {
    const keyWidth = Math.max(...pairs.map(([k]) => visibleWidth(k))) + 3;
    const pad = " ".repeat(indent);
    return pairs.flatMap(([key, value]) => {
      const lines = wrap(value, Math.max(16, W - indent - keyWidth));
      return lines.map((line, i) => `${pad}${i === 0 ? c.dim(padEnd(key, keyWidth)) : " ".repeat(keyWidth)}${line}`);
    });
  };

  return {
    style, g, c,
    header: (title, subtitle) => ["", c.bold(title), ...(subtitle ? wrap(subtitle, W).map(c.dim) : []), ""],
    step: (n, total, title) => ["", `${c.accent(`${n}/${total}`)}  ${c.bold(title)}`],
    section: (title) => ["", c.bold(title)],
    mark,
    para: (text, indent = 2) => wrapHanging(text, W - indent).map((l) => " ".repeat(indent) + l),
    hint: (text, indent = 4) => wrap(text, W - indent).map((l) => " ".repeat(indent) + c.dim(l)),
    rows,
    code: (lines, indent = 4) => lines.map((l) => " ".repeat(indent) + c.accent(l)),
    next: (lines, title = "Next") => {
      // │ + space + inner + space + │: the box is inner + 4 columns wide.
      const body = lines.flatMap((l) => (l === "" ? [""] : wrapHanging(l, W - 4)));
      const inner = Math.max(visibleWidth(title) + 2, ...body.map(visibleWidth));
      return [
        "",
        c.dim(`${g.tl}${g.h} `) + c.bold(title) + c.dim(` ${g.h.repeat(inner - 1 - visibleWidth(title))}${g.tr}`),
        ...body.map((l) => `${c.dim(g.v)} ${padEnd(l, inner)} ${c.dim(g.v)}`),
        c.dim(`${g.bl}${g.h.repeat(inner + 2)}${g.br}`),
      ];
    },
    problem: (what, opts = {}, indent = 0) => {
      const pad = " ".repeat(indent);
      const head = wrap(what, W - indent - 2).map((l, i) => `${pad}${i === 0 ? c.red(g.fail) : " "} ${l}`);
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
function pipedLine(): Promise<string | null> {
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
  if (state.lines.length) return Promise.resolve(state.lines.shift()!);
  if (state.ended) return Promise.resolve(null);
  const waiting = state;
  return new Promise((resolve) => waiting.waiters.push(resolve));
}

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
  readonly kit: Kit;
  readonly live: boolean;
  readonly canAsk: boolean;
  protected readonly write: (text: string) => void;
  protected readonly writeErr: (text: string) => void;
  protected readonly now: () => number;

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
  header(title: string, subtitle?: string): void { this.lines(this.kit.header(title, subtitle)); }
  step(n: number, total: number, title: string): void { this.lines(this.kit.step(n, total, title)); }
  section(title: string): void { this.lines(this.kit.section(title)); }
  ok(text: string, detail?: string): void { this.lines(this.kit.mark("ok", text, detail)); }
  warn(text: string, detail?: string): void { this.lines(this.kit.mark("warn", text, detail)); }
  fail(text: string, detail?: string): void { this.lines(this.kit.mark("fail", text, detail)); }
  info(text: string, detail?: string): void { this.lines(this.kit.mark("info", text, detail)); }
  para(text: string, indent?: number): void { this.lines(this.kit.para(text, indent)); }
  hint(text: string, indent?: number): void { this.lines(this.kit.hint(text, indent)); }
  rows(pairs: Array<[string, string]>, indent?: number): void { this.lines(this.kit.rows(pairs, indent)); }
  code(lines: string[], indent?: number): void { this.lines(this.kit.code(lines, indent)); }
  next(lines: string[], title?: string): void { this.lines(this.kit.next(lines, title)); }
  /** What went wrong and how to fix it, inside a flow (indented under its step). */
  problem(what: string, opts?: { detail?: string | string[] | undefined; fix?: Fix[] | undefined }): void {
    this.lines(this.kit.problem(what, opts, 2));
  }
  /** A problem that ends the command: goes to stderr, flush left. */
  error(what: string, opts?: { detail?: string | string[] | undefined; fix?: Fix[] | undefined }): void {
    for (const l of this.kit.problem(what, opts, 0)) this.writeErr(l + "\n");
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
      const elapsed = duration(this.now() - started);
      const head = `  ${c.accent(g.spinner[frame++ % g.spinner.length]!)} ${label}${elapsed && this.now() - started >= 3000 ? c.dim(` ${elapsed}`) : ""}`;
      const room = this.style.width - visibleWidth(head) - 3;
      const tail = detail && room > 8 ? c.dim(`  ${detail.length > room ? detail.slice(0, room - 1) + g.ellipsis : detail}`) : "";
      this.write(`${CLEAR_LINE}${head}${tail}`);
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
  protected async answer(query: string, question: string): Promise<string> {
    let line: string | null;
    if (!process.stdin.isTTY) {
      this.write(query);
      line = await pipedLine();
      this.write("\n");
    } else {
      // A fresh readline per question: a long-lived one breaks when a
      // subprocess in between (a login, a build) inherits stdin.
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // readline swallows Ctrl-C; turn it back into a clean exit.
      rl.on("SIGINT", () => { process.stdout.write(`${SHOW_CURSOR}\n`); process.exit(130); });
      try {
        line = await new Promise<string | null>((resolve) => {
          rl.once("close", () => resolve(null));
          rl.question(query).then(resolve).catch(() => resolve(null));
        });
      } finally {
        rl.close();
      }
    }
    if (line === null) throw new InputClosedError(question);
    return line.trim();
  }

  protected q(question: string, suffix = ""): string {
    const { c, g } = this.kit;
    return `${c.accent(g.ask)} ${c.bold(question)}${suffix ? " " + c.dim(suffix) : ""}`;
  }

  /**
   * Yes or no. Enter takes the default; y/yes and n/no are the only other
   * answers. Anything else is asked again, then counts as no: a stray key is
   * not consent.
   */
  async confirm(question: string, defaultYes = true): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = (await this.answer(`${this.q(question, defaultYes ? "(Y/n)" : "(y/N)")} `, question)).toLowerCase();
      if (a === "") return defaultYes;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      this.hint("Answer y or n.", 2);
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
        return `  ${on ? c.accent(g.pointer) : " "} ${on ? c.accent(label) : label}${hint}`;
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
      choices.forEach((ch, i) => this.line(`  ${c.accent(String(i + 1))}. ${ch.hint ? padEnd(ch.label, labelWidth) + c.dim(ch.hint) : ch.label}`));
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await this.answer(`  ${c.dim(`Number (${idx + 1}):`)} `, question);
        if (raw === "") return idx;
        const picked = Number(raw);
        if (Number.isInteger(picked) && picked >= 1 && picked <= n) return picked - 1;
        this.hint(`Enter a number from 1 to ${n}.`, 2);
      }
      throw new InputClosedError(question);
    }

    const render = (first: boolean, active: boolean): void => {
      if (!first) this.write(`\x1b[${n + 1}A`);
      for (const l of this.menu(question, choices, idx, active)) this.write(`${CLEAR_LINE}${l}\n`);
    };
    render(true, true);
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
          if (ch === "\r" || ch === "\n") { cleanup(); render(false, false); resolve(idx); return; }
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
