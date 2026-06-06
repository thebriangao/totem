// Shared CLI primitives: colors, subprocess runner, HTTP ping, interactive
// prompts, and small helpers used by both the command dispatcher (index.ts)
// and the guided setup flows (setup.ts).
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
// Modern truecolor palette (Tailwind-400-ish) — vivid but easy on a dark terminal.
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  brand: "\x1b[38;2;235;235;235m",
  brandDim: "\x1b[38;2;150;150;150m",
  gray: "\x1b[38;2;128;128;128m",
  white: "\x1b[38;2;245;245;245m",
  green: "\x1b[38;2;52;211;153m",   // emerald
  red: "\x1b[38;2;248;113;113m",    // red
  yellow: "\x1b[38;2;251;191;36m",  // amber
  cyan: "\x1b[38;2;34;211;238m",    // cyan
  violet: "\x1b[38;2;167;139;250m", // violet
  pink: "\x1b[38;2;244;114;182m",   // pink
};
function wrap(code: string, s: string): string {
  return useColor ? `${code}${s}${ANSI.reset}` : s;
}
export const c = {
  brand: (s: string) => wrap(ANSI.brand, s),
  brandDim: (s: string) => wrap(ANSI.brandDim, s),
  gray: (s: string) => wrap(ANSI.gray, s),
  white: (s: string) => wrap(ANSI.white, s),
  green: (s: string) => wrap(ANSI.green, s),
  red: (s: string) => wrap(ANSI.red, s),
  yellow: (s: string) => wrap(ANSI.yellow, s),
  cyan: (s: string) => wrap(ANSI.cyan, s),
  violet: (s: string) => wrap(ANSI.violet, s),
  pink: (s: string) => wrap(ANSI.pink, s),
  bold: (s: string) => wrap(ANSI.bold, s),
  dim: (s: string) => wrap(ANSI.dim, s),
};

// Spawn a command, inheriting stdio. Resolves with the exit code.
export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(c.red(`\nKilled by signal ${signal}`));
        res(128);
        return;
      }
      res(code ?? 1);
    });
    child.on("error", (err) => {
      console.error(c.red("Failed to spawn:"), (err as Error).message);
      res(1);
    });
  });
}

// Run a command and capture stdout (for parsing CLI output like a deploy URL).
export function capture(cmd: string, args: string[], opts: SpawnOptions = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Async sibling of capture(). `capture` uses spawnSync, which BLOCKS the event
// loop for the whole subprocess — so a spinner (setInterval) can't animate over
// it. For slow, network-bound lookups (gcloud/railway/fly API calls) run them
// through this instead and wrap with withSpinner() so the UI stays alive.
export function captureAsync(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { input, ...spawnOpts } = opts;
  return new Promise((res) => {
    // input set → pipe stdin so secrets can be fed over a pipe (off the argv,
    // which is visible in `ps`/`/proc`); otherwise ignore stdin as before.
    const child = spawn(cmd, args, { stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"], ...spawnOpts });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => res({ code: 1, stdout, stderr }));
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) { child.stdin?.write(input); child.stdin?.end(); }
  });
}

// ── spinner ──────────────────────────────────────────────────────────────
// A braille spinner for the "thinking" gaps where we do work with no visible
// output (our own network lookups, HTTP polling, backoff waits). Subprocesses
// run with inherited stdio print their own progress, so they don't need this.
// IMPORTANT: a spinner only animates while the event loop is free — pair it
// with async work (await captureAsync / httpGet / setTimeout), never spawnSync.
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export interface Spinner {
  stop: (final?: string) => void;
}

export function spin(message: string | (() => string)): Spinner {
  // Message can be a live function (e.g. an elapsed-time counter), re-evaluated
  // on every frame.
  const msg = (): string => (typeof message === "function" ? message() : message);
  // No TTY (piped/CI): no cursor tricks — print the message once, plainly.
  if (!process.stdout.isTTY) {
    console.log(c.gray(`  ${msg()}…`));
    return { stop: (final) => { if (final) console.log(final); } };
  }
  let i = 0;
  process.stdout.write("\x1b[?25l"); // hide cursor
  const draw = (): void => {
    process.stdout.write(`\r\x1b[2K${c.cyan(SPIN_FRAMES[i % SPIN_FRAMES.length]!)} ${c.gray(msg())}`);
    i++;
  };
  draw();
  const timer = setInterval(draw, 80);
  return {
    stop: (final?: string): void => {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K\x1b[?25h"); // clear line + restore cursor
      if (final) console.log(final);
    },
  };
}

// Run async work under a spinner; always stops the spinner, even on throw.
export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const s = spin(message);
  try {
    return await fn();
  } finally {
    s.stop();
  }
}

// A visible backoff: spin for `ms` so a silent wait doesn't look like a hang.
export async function pause(ms: number, message: string): Promise<void> {
  const s = spin(message);
  await new Promise((r) => setTimeout(r, ms));
  s.stop();
}

// Is a CLI tool on PATH? Uses which/where (real executables) rather than the
// `command -v` shell builtin, so we avoid `shell: true` — which both triggers
// Node 25's DEP0190 warning and is an injection risk.
export function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8" });
  return (r.status ?? 1) === 0 && (r.stdout ?? "").trim().length > 0;
}

// 256-bit random hex token (for MCP_AUTH_TOKEN / signing secret).
export function genToken(): string {
  return randomBytes(32).toString("hex");
}

// Cryptographically-random password. Rejection sampling over an unambiguous
// alphabet (no 0/O/1/l/I) plus symbols for entropy — safe to read/retype.
export function genPassword(len = 18): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
  const max = Math.floor(256 / alphabet.length) * alphabet.length; // reject modulo bias
  let out = "";
  while (out.length < len) {
    const b = randomBytes(1)[0]!;
    if (b < max) out += alphabet[b % alphabet.length];
  }
  return out;
}

// Best-effort copy to the OS clipboard. Returns true on success, false if no
// clipboard tool is available (never throws).
export function copyToClipboard(text: string): boolean {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["pbcopy", []]
    : process.platform === "win32" ? ["clip", []]
    : ["xclip", ["-selection", "clipboard"]];
  try {
    const r = spawnSync(cmd, args, { input: text });
    return (r.status ?? 1) === 0;
  } catch {
    return false;
  }
}

// Run a bundled script resiliently. A published install (`npm install -g`)
// ships the compiled `dist/*.js` and only runtime deps — no `tsx`/`typescript`.
// A dev checkout has `tsx` + the TypeScript source. Prefer whichever fits:
// dist+node by default (works everywhere), source+tsx when `preferSource` is set
// (live dev, picks up edits without a rebuild). `relNoExt` is relative to src/
// or dist/ without extension, e.g. "scripts/cognito_bootstrap" or "server".
export function runScript(
  root: string,
  relNoExt: string,
  args: string[] = [],
  opts: { preferSource?: boolean } & SpawnOptions = {},
): Promise<number> {
  const { preferSource = false, ...spawnOpts } = opts;
  const distJs = resolve(root, "dist", `${relNoExt}.js`);
  const srcTs = resolve(root, "src", `${relNoExt}.ts`);
  const tsx = resolve(root, "node_modules", ".bin", "tsx");
  const viaDist: [string, string] = [process.execPath, distJs];
  const viaTsx: [string, string] = [tsx, srcTs];
  const order = preferSource ? [viaTsx, viaDist] : [viaDist, viaTsx];
  for (const [bin, script] of order) {
    const binOk = bin === process.execPath || existsSync(bin);
    if (binOk && existsSync(script)) return run(bin, [script, ...args], { cwd: root, ...spawnOpts });
  }
  console.error(c.red(`Can't run ${relNoExt}: need either a built dist/ or the tsx dev dependency.`));
  console.error(c.gray("Run ") + c.bold("npm install && totem build") + c.gray(" in a source checkout, or reinstall the published package."));
  return Promise.resolve(1);
}

// Ensure a CLI tool is on PATH; if not, offer to install it (with permission).
// Tries brew → npm → install script, in that order, based on what's available.
// Note: a freshly installed tool often isn't on this process's PATH yet, so we
// re-check and, if still missing, tell the user to re-run in a new shell.
export async function ensureCli(
  name: string,
  opts: { brewPkg?: string; npmPkg?: string; scriptUrl?: string; manualHint: string },
): Promise<boolean> {
  if (commandExists(name)) return true;
  console.log(c.yellow(`  ${name} isn't installed.`));
  // Collect the install methods that are actually available and try them in
  // order (brew → npm → script), falling THROUGH if one fails (e.g. a brew
  // formula doesn't exist) instead of giving up after the first.
  const methods: Array<[string, string[]]> = [];
  if (opts.brewPkg && commandExists("brew")) methods.push(["brew", ["install", opts.brewPkg]]);
  if (opts.npmPkg && commandExists("npm")) methods.push(["npm", ["install", "-g", opts.npmPkg]]);
  if (opts.scriptUrl) methods.push(["sh", ["-c", `curl -fsSL ${opts.scriptUrl} | sh`]]);
  if (methods.length === 0) {
    console.log(c.gray(`  Install it manually: ${opts.manualHint}`));
    return false;
  }
  for (const [cmd, args] of methods) {
    console.log(c.gray(`    $ ${cmd} ${args.join(" ")}`));
    if (!(await promptYesNo(`Install ${name} via \`${cmd}\`?`, true))) continue;
    if ((await run(cmd, args)) === 0 && commandExists(name)) return true;
    console.log(c.yellow(`  ${cmd} didn't get ${name} working${methods.length > 1 ? " — trying the next method" : ""}.`));
  }
  if (!commandExists(name)) {
    console.log(c.yellow(`  ${name} still isn't on this shell's PATH.`));
    console.log(c.gray(`  ${opts.manualHint} — or open a new terminal and re-run.`));
    return false;
  }
  return true;
}

// Open a URL in the default browser, cross-platform. Best-effort, never throws.
export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawnSync(cmd, args, { stdio: "ignore" }); } catch { /* best-effort */ }
}

// GET a URL, resolve with {status, body}. Used for health + OAuth metadata checks.
export function httpGet(url: string, timeoutMs = 12_000): Promise<{ status: number; body: string }> {
  return new Promise((res) => {
    const u = new URL(url);
    const req = httpsRequest(
      { method: "GET", hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { "user-agent": "totem-setup" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (ch: string) => (body += ch));
        response.on("end", () => res({ status: response.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); res({ status: 0, body: "" }); });
    req.on("error", () => res({ status: 0, body: "" }));
    req.end();
  });
}

export function ping(url: string, timeoutMs = 10_000): Promise<number> {
  return httpGet(url, timeoutMs).then((r) => {
    const ok = r.status >= 200 && r.status < 300;
    const label = ok ? c.green(`✓ ${r.status}`) : c.red(`✗ ${r.status || "timeout"}`);
    const preview = r.body.length > 100 ? r.body.slice(0, 97) + "..." : r.body;
    console.log(`${label}  ${url}  ${c.gray(preview.replace(/\s+/g, " ").trim())}`);
    return ok ? 0 : 1;
  });
}

// ── interactive prompts ─────────────────────────────────────────────────────
// A fresh readline per question. Long-lived readlines break when a subprocess
// in between (e.g. the build step) inherits stdin, so we open/close per ask.
// On EOF (piped input) the question resolves empty instead of throwing.
async function ask(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl-C during a text prompt: readline swallows SIGINT (emits it on the
  // interface). Handle it here — restore the cursor, drop a line, exit.
  rl.on("SIGINT", () => { process.stderr.write("\x1b[?25h"); process.stdout.write("\n"); process.exit(130); });
  try {
    // Resolve "" if the stream closes (EOF) so the caller falls back to its
    // default instead of hanging.
    return await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      rl.question(query).then((a) => resolve(a.trim())).catch(() => resolve(""));
    });
  } finally {
    rl.close();
  }
}

// Kept for API compatibility; no-op now that prompts are per-call.
export function closePrompts(): void {}

export async function prompt(question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? c.gray(` [${fallback}]`) : "";
  const answer = await ask(`${c.violet("?")} ${c.white(question)}${suffix}${c.gray(" ›")} `);
  return answer || fallback;
}

// Like `ask`, but typed characters are NOT echoed — standard password-prompt
// behavior, so a secret never appears on screen (or on camera). The override
// lets the prompt itself and the commit newline through and swallows every
// per-character echo; readline still captures the full value in its buffer.
async function askHidden(query: string): Promise<string> {
  // Explicit raw-mode read: readline's _writeToOutput trick doesn't reliably
  // disable the TERMINAL's own echo, so the secret can still render. Here we set
  // raw mode ourselves (terminal echo off), read char-by-char, and echo nothing
  // — the password never appears on screen. Falls back to a normal line read
  // when there's no TTY to put in raw mode (piped/CI).
  const stdin = process.stdin;
  if (!(stdin.isTTY && typeof stdin.setRawMode === "function")) return ask(query);

  process.stdout.write(query);
  return new Promise<string>((resolve) => {
    let buf = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(false); } catch { /* */ }
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") { cleanup(); process.stdout.write("\n"); resolve(buf.trim()); return; }
        if (ch === "\u0003") { cleanup(); process.stdout.write("\n"); process.exit(130); }     // Ctrl-C
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }              // backspace
        if (ch >= " ") buf += ch;                                                              // printable: captured, not echoed
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

// A masked prompt for secrets (the Whoop account password). Same look as
// `prompt`, but nothing you type is shown.
export async function promptHidden(question: string): Promise<string> {
  return askHidden(`${c.violet("?")} ${c.white(question)}${c.gray(" ›")} `);
}

// Enter — and ANY answer that isn't an explicit "no" — proceeds when `defaultYes`
// is set. To decline you must actually type n / no / N / NO. (When `defaultYes`
// is false it's the mirror: only an explicit y / yes proceeds.)
export async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? `${c.green(c.bold("Y"))}${c.gray("/n")}` : `${c.gray("y/")}${c.red(c.bold("N"))}`;
  const answer = (await ask(`${c.violet("?")} ${c.white(question)} ${c.gray("(")}${hint}${c.gray(")")}${c.gray(" ›")} `)).trim().toLowerCase();
  if (defaultYes) return !/^(n|no)$/.test(answer);
  return /^(y|yes)$/.test(answer);
}

// Numbered menu. Returns the 0-based index of the choice. Used as the non-TTY
// fallback for select() (piped stdin can't do raw-mode arrow keys).
export async function promptChoice(question: string, choices: string[]): Promise<number> {
  console.log(`${c.violet("?")} ${c.bold(c.white(question))}`);
  choices.forEach((ch, i) => console.log(`  ${c.cyan(c.bold(String(i + 1)))}${c.gray(".")} ${ch}`));
  for (let attempts = 0; attempts < 100; attempts++) {
    const raw = await ask(`  ${c.gray("enter a number")}: `);
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
    if (raw === "") return 0; // EOF / piped input → first choice (safe default)
    console.log(c.red(`  Please enter 1-${choices.length}.`));
  }
  return 0;
}

// ── arrow-key selector ──────────────────────────────────────────────────────
// Up/down (or j/k, or 1-9) to move, Enter to pick, Ctrl-C to cancel. Each choice
// is a label with an optional dim hint. Returns the 0-based index. Falls back to
// the numbered prompt when stdin/stdout isn't an interactive TTY (pipes, CI).
export interface SelectChoice {
  label: string;
  hint?: string | undefined;
}

export async function select(
  question: string,
  choices: Array<string | SelectChoice>,
  opts: { defaultIndex?: number } = {},
): Promise<number> {
  const items = choices.map((ch) => (typeof ch === "string" ? { label: ch } : ch));
  const stdin = process.stdin;
  const interactive = Boolean(stdin.isTTY) && Boolean(process.stdout.isTTY) && typeof stdin.setRawMode === "function";
  if (!interactive) {
    return promptChoice(question, items.map((it) => (it.hint ? `${it.label} ${c.gray(it.hint)}` : it.label)));
  }

  let idx = Math.min(Math.max(opts.defaultIndex ?? 0, 0), items.length - 1);

  const render = (first: boolean): void => {
    if (!first) process.stdout.write(`\x1b[${items.length + 1}A`); // back up to the question line
    process.stdout.write(`\r\x1b[2K${c.violet("?")} ${c.bold(c.white(question))}  ${c.dim("↑/↓ · enter")}\n`);
    items.forEach((it, i) => {
      const selected = i === idx;
      const pointer = selected ? c.cyan("❯") : " ";
      const label = selected ? c.bold(c.cyan(it.label)) : c.white(it.label);
      const hint = it.hint ? "  " + c.dim(it.hint) : "";
      process.stdout.write(`\r\x1b[2K ${pointer} ${label}${hint}\n`);
    });
  };

  render(true);
  process.stdout.write("\x1b[?25l"); // hide the blinking cursor while the menu is active
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const n = items.length;
  return new Promise<number>((resolveSel) => {
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\x1b[?25h"); // restore the cursor once a choice is made
    };
    // Scan the chunk left-to-right rather than exact-matching the whole thing:
    // a single read can batch several bytes (a paste, a fast double-press, or a
    // terminal/PTY that delivers the arrow sequence and the Enter together like
    // "\x1b[B\r"). Incomplete escape sequences at a chunk boundary are stashed in
    // `pending` and prepended to the next read so a split "\x1b" + "[B" still works.
    let pending = "";
    const onData = (raw: string): void => {
      const chunk = pending + raw;
      pending = "";
      if (chunk.includes("\x03")) { cleanup(); process.stdout.write("\n"); process.exit(130); }
      let moved = false;
      let i = 0;
      while (i < chunk.length) {
        const rest = chunk.slice(i);
        const ch = rest[0]!;
        if (ch === "\r" || ch === "\n") { cleanup(); if (moved) render(false); resolveSel(idx); return; }
        if (ch === "\x1b") {
          if (rest === "\x1b" || rest === "\x1b[") { pending = rest; break; } // incomplete — wait for more
          if (rest.startsWith("\x1b[A")) { idx = (idx - 1 + n) % n; moved = true; i += 3; continue; }
          if (rest.startsWith("\x1b[B")) { idx = (idx + 1) % n; moved = true; i += 3; continue; }
          i += rest.length >= 3 ? 3 : rest.length; continue; // unknown escape — skip it
        }
        if (ch === "k") { idx = (idx - 1 + n) % n; moved = true; }
        else if (ch === "j") { idx = (idx + 1) % n; moved = true; }
        else if (/[1-9]/.test(ch)) { const x = parseInt(ch, 10) - 1; if (x < n) { idx = x; moved = true; } }
        i += 1;
      }
      if (moved) render(false);
    };
    stdin.on("data", onData);
  });
}

// ── confirmation for sensitive actions ──────────────────────────────────────
// A loud, explicit y/n gate for anything that mutates cloud state, spends money,
// or changes permissions. Shows exactly what will run + why, so the user is
// giving informed consent rather than watching it happen.
export interface ConfirmOpts {
  detail?: string;        // one-line consequence ("grants build access to …")
  cmd?: string;           // the exact command we're about to run
  defaultYes?: boolean;   // Enter = proceed (true) vs Enter = decline (false)
}

export async function confirmStep(summary: string, opts: ConfirmOpts = {}): Promise<boolean> {
  console.log(`  ${c.yellow("⚠")}  ${c.bold(c.white(summary))}`);
  if (opts.detail) console.log(`     ${c.gray(opts.detail)}`);
  if (opts.cmd) console.log(`     ${c.dim("$")} ${c.cyan(opts.cmd)}`);
  return promptYesNo("  Proceed?", opts.defaultYes ?? true);
}

// Redact secret values when echoing a command so tokens/passwords never hit the
// screen or scrollback. Masks the value of any KEY=value whose key looks
// sensitive (or whose value is long enough to be a token).
export function maskArgs(args: string[]): string {
  return args
    .map((a) => {
      const eq = a.indexOf("=");
      if (eq <= 0) return a;
      const key = a.slice(0, eq);
      if (/(_?TOKEN|PASSWORD|_SECRET|BEARER|REFRESH|EMAIL)/i.test(key)) return `${key}=${c.dim("•••")}`;
      return a;
    })
    .join(" ");
}

// Section header for the guided flows — a violet rule + step counter + title.
export function step(n: number, total: number, title: string): void {
  console.log("");
  console.log(`${c.violet("▌")} ${c.violet(c.bold(`${n}/${total}`))}  ${c.bold(c.white(title))}`);
}
