// A fake world for the CLI: a scripted person at the keyboard (ScriptedUi), a
// machine that records commands instead of running them (fakeSys), and a WHOOP
// login that always works unless told otherwise (fakeAuth). With these, every
// screen can be rendered to text with no terminal, network, host CLI or login.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthDeps } from "../../src/cli/auth.js";
import type { LocalStatus, PushResult, Validation } from "../../src/cli/auth_flow.js";
import type { ExecResult, HttpResult, Io, Sys } from "../../src/cli/sys.js";
import { PLAIN, Ui, type Choice, type Style } from "../../src/cli/ui.js";

/** An answer to the first prompt whose question contains (or matches) `match`. */
export type Answer = [match: string | RegExp, answer: number | boolean | string];

/**
 * A Ui that answers its own prompts from a script and records everything it
 * shows. A prompt with no scripted answer takes its default, as Enter would.
 * The transcript shows each prompt the way it is left on a terminal.
 */
export class ScriptedUi extends Ui {
  readonly out: string[];
  private readonly answers: Answer[];

  constructor(answers: Answer[] = [], style: Style = PLAIN, now: () => number = Date.now) {
    const out: string[] = [];
    super({ style, write: (t) => { out.push(t); }, writeErr: (t) => { out.push(t); }, live: false, canAsk: true, now });
    this.out = out;
    this.answers = [...answers];
  }

  private take<T>(question: string, fallback: T): T {
    const i = this.answers.findIndex(([m]) => (typeof m === "string" ? question.includes(m) : m.test(question)));
    if (i === -1) return fallback;
    return this.answers.splice(i, 1)[0]![1] as T;
  }

  override async select(question: string, choices: Choice[], defaultIndex = 0): Promise<number> {
    const idx = this.take(question, defaultIndex);
    // The menu as it was offered, then the line it folds into once answered.
    this.lines(this.menu(question, choices, idx, true));
    this.line(this.kit.answered(question, choices[idx]!.label));
    return idx;
  }

  override async confirm(question: string, defaultYes = true): Promise<boolean> {
    const yes = this.take(question, defaultYes);
    this.line(`${this.q(question, defaultYes ? "(Y/n)" : "(y/N)")} ${yes === defaultYes ? "" : yes ? "y" : "n"}`.trimEnd());
    return yes;
  }

  override async text(question: string, fallback = ""): Promise<string> {
    const typed = this.take(question, "");
    this.line(`${this.q(question, fallback ? `(${fallback})` : "")}: ${typed}`.trimEnd());
    return typed || fallback;
  }

  override async hidden(question: string): Promise<string> {
    this.line(`${this.q(question, "(hidden)")}:`);
    return this.take(question, "");
  }

  /** Everything shown so far. */
  text_(): string {
    return this.out.join("");
  }
}

export interface FakeWorld {
  io: Io;
  ui: ScriptedUi;
  /** A throwaway home directory; the install is at `root` inside it. */
  home: string;
  root: string;
  /** Every command run or captured, in order, secrets as given. */
  commands: string[];
  /** Milliseconds to add to the clock: `clock.t += 12_000` inside an exec handler. */
  clock: { t: number };
  /** Scratch counters for handlers ("fail the first npm install"), fresh per world. */
  counts: Record<string, number>;
  /** The transcript with this machine's temp paths replaced. */
  transcript(): string;
  cleanup(): void;
}

export interface WorldOptions {
  answers?: Answer[];
  style?: Style;
  platform?: NodeJS.Platform;
  /** Commands that are NOT on PATH. */
  missing?: string[];
  /** Answer a captured command; undefined = success with no output. */
  exec?: (cmd: string, args: string[], input: string | undefined, world: FakeWorld) => ExecResult | undefined;
  /** Exit code of an attached command; undefined = 0. */
  run?: (cmd: string, args: string[], world: FakeWorld) => number | undefined;
  http?: (url: string) => Partial<HttpResult> | undefined;
  auth?: Partial<FakeAuthOptions>;
  /** Start with these and not `dist/server.js` / `node_modules`. */
  unbuilt?: boolean;
  tty?: boolean;
}

export interface FakeAuthOptions {
  browser: "ok" | "closed" | "timeout" | "none";
  validate: Validation;
  push: PushResult;
  remoteStatus: PushResult;
  local: Omit<LocalStatus, "tokenFile">;
  pasteError: Error | null;
}

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };
const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** Give a fake install the repo's real dependencies (the flows look up tsc in them). */
export function linkDependencies(installRoot: string): void {
  symlinkSync(join(REPO, "node_modules"), join(installRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}
export const START = Date.parse("2026-11-21T22:10:00Z");
export const TOKEN = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
export const PASSWORD = "Kq7m-Rt2x-Vb9n-Lp4w-Hd6s";

export function fakeAuth(home: string, over: Partial<FakeAuthOptions> = {}): AuthDeps {
  const o: FakeAuthOptions = {
    browser: "ok",
    validate: { accepted: true, userId: 1234567, status: 200 },
    push: { ok: true, status: { state: "ok", role: "owner", durable: true } },
    remoteStatus: {
      ok: true,
      status: { state: "ok", role: "owner", source: "browser", access_expires_at: "2026-11-21T23:10:00.000Z", refreshed_at: "2026-11-21T22:10:00.000Z", next_keepalive_at: "2026-11-22T10:10:00.000Z", durable: true },
    },
    local: { state: "none" },
    pasteError: null,
    ...over,
  };
  return {
    cliEnv: () => ({ TOTEM_TOKEN_FILE: join(home, ".config", "totem", "tokens.json") }),
    findBrowser: () => (o.browser === "none" ? null : { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
    captureBrowserLogin: async () => {
      const { BrowserLoginError } = await import("../../src/cli/browser_login.js");
      if (o.browser === "closed") throw new BrowserLoginError("The browser was closed before the login finished.", "closed");
      if (o.browser === "timeout") throw new BrowserLoginError("Timed out after 15 minutes without a WHOOP login.", "timeout");
      return { accessToken: "access", refreshToken: "refresh", clientId: null, accessCookie: "whoop-auth-token", refreshCookie: "whoop-auth-refresh-token" };
    },
    loginWithRefreshToken: async () => {
      if (o.pasteError) throw o.pasteError;
      return { accessToken: "access", refreshToken: "refresh", clientId: "web", source: "paste" };
    },
    validateLogin: async () => o.validate,
    saveLocalLogin: (() => ({})) as unknown as AuthDeps["saveLocalLogin"],
    pushLogin: async () => o.push,
    fetchRemoteStatus: async () => o.remoteStatus,
    readLocalStatus: (tokenFile) => ({ tokenFile, ...o.local }),
    readTokenFile: () => null,
    pickInstallationId: () => "00000000-0000-4000-8000-000000000000",
    markHandedOff: () => ({ marked: true, keptLocalLogin: false }),
    retireLegacyEnv: () => [],
  };
}

export function fakeWorld(opts: WorldOptions = {}): FakeWorld {
  const home = mkdtempSync(join(tmpdir(), "totem-world-"));
  const root = join(home, "totem");
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@thebriangao/totem", version: "1.5.1", repository: { url: "https://github.com/thebriangao/totem.git" } }));
  if (!opts.unbuilt) {
    linkDependencies(root);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "server.js"), "");
  }
  const clock = { t: START };
  const commands: string[] = [];
  const ui = new ScriptedUi(opts.answers, opts.style, () => clock.t);
  let tokens = 0;
  const world = {} as FakeWorld;
  const sys: Sys = {
    platform: opts.platform ?? "darwin",
    home,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    node: "/usr/local/bin/node",
    nodeVersion: "24.3.0",
    tty: opts.tty ?? false,
    has: (cmd) => !(opts.missing ?? []).includes(cmd),
    run: async (cmd, args) => {
      commands.push(`run   ${cmd} ${args.join(" ")}`);
      return opts.run?.(cmd, args, world) ?? 0;
    },
    exec: async (cmd, args, o = {}) => {
      commands.push(`exec  ${cmd} ${args.join(" ")}${o.input !== undefined ? "  <stdin>" : ""}`);
      const r = opts.exec?.(cmd, args, o.input, world) ?? OK;
      if (o.onLine) for (const line of `${r.stdout}\n${r.stderr}`.split("\n")) if (line.trim()) o.onLine(line);
      return r;
    },
    httpGet: async (url) => {
      commands.push(`GET   ${url}`);
      const base: HttpResult = url.endsWith("/mcp") && !url.includes(".well-known")
        ? { status: 401, body: "", ms: 96 }
        : { status: 200, body: JSON.stringify({ status: "ok", build: "abc1234", resource: "https://example/mcp" }), ms: 182 };
      return { ...base, ...opts.http?.(url) };
    },
    openUrl: (url) => { commands.push(`open  ${url}`); },
    copy: () => true,
    // The first token is the server's MCP_AUTH_TOKEN; later ones name things.
    token: () => (tokens++ === 0 ? TOKEN : `c0ffee${tokens}`.padEnd(64, "0")),
    password: () => PASSWORD,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
  };
  Object.assign(world, {
    io: { ui, sys, auth: fakeAuth(home, opts.auth) },
    ui, home, root, commands, clock, counts: {},
    transcript: () => ui.text_().split(home).join("/Users/you"),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  });
  return world;
}

// ── ANSI → HTML, for screenshots of a coloured render ───────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The body of a terminal screenshot page: SGR colours as spans. */
export function ansiToHtml(text: string): string {
  const colors: Record<number, string> = { 31: "red", 32: "green", 33: "yellow", 35: "magenta", 36: "cyan", 94: "bright-blue" };
  // The two 256-colour brand shades (ui.ts brandSgr); others render uncoloured.
  const xterm: Record<number, string> = { 153: "#afd7ff", 110: "#87afd7" };
  let bold = false, dim = false, color = "", rgb = "";
  let html = "";
  const open = (): string => {
    const cls = [bold ? "b" : "", dim ? "d" : "", color].filter(Boolean).join(" ");
    const style = rgb ? ` style="color:${rgb}"` : "";
    return cls || style ? `<span${cls ? ` class="${cls}"` : ""}${style}>` : "";
  };
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) {
      if (part) { const o = open(); html += o ? `${o}${esc(part)}</span>` : esc(part); }
      continue;
    }
    const codes = m[1]!.split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 38 && codes[i + 1] === 2) { rgb = `rgb(${codes.slice(i + 2, i + 5).join(",")})`; color = ""; i += 4; }
      else if (code === 38 && codes[i + 1] === 5) { rgb = xterm[codes[i + 2]!] ?? ""; color = ""; i += 2; }
      else if (code === 0) { bold = false; dim = false; color = ""; rgb = ""; }
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) { bold = false; dim = false; }
      else if (code === 39) { color = ""; rgb = ""; }
      else if (colors[code]) { color = colors[code]!; rgb = ""; }
    }
  }
  return html;
}

/** A standalone page that looks like a terminal window `columns` wide. */
export function terminalPage(title: string, ansi: string, columns = 80): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  html { background: #0e1116; }
  body { margin: 0; padding: 24px; display: inline-block; }
  .win { background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; }
  .bar { height: 30px; background: #1f262e; border-bottom: 1px solid #30363d; display: flex; align-items: center; padding: 0 12px;
         font: 12px -apple-system, "Segoe UI", sans-serif; color: #8b949e; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #3d444d; margin-right: 7px; display: inline-block; }
  .bar span { margin-left: 8px; }
  pre { margin: 0; padding: 14px 18px 18px; width: ${columns}ch; color: #d6dde6; white-space: pre;
        font: 14px/1.22 Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", monospace; }
  .b { font-weight: 700; color: #f2f5f8; }
  .d { color: #8b949e; }
  .red { color: #ff7b72; } .green { color: #56d364; } .yellow { color: #e3b341; } .cyan { color: #6cc7e0; } .magenta { color: #d2a8ff; } .bright-blue { color: #79c0ff; }
  .b.d { color: #8b949e; font-weight: 400; }
</style></head>
<body><div class="win"><div class="bar"><i></i><i></i><i></i><span>${esc(title)}</span></div><pre>${ansiToHtml(ansi)}</pre></div></body></html>
`;
}
