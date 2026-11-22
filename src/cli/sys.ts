// Everything the CLI does to the outside world: run a command, make an HTTP
// request, open a browser, copy to the clipboard, read the clock. The flows
// (setup.ts, auth.ts, update.ts, app.ts) only reach the world through a `Sys`,
// so a test can hand them a fake one and render any screen without a network,
// a host CLI or a WHOOP login. Presentation lives in ui.ts.
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { constants as osConstants, homedir } from "node:os";
import { resolve } from "node:path";
import type { AuthDeps } from "./auth.js";
import { pkgBin, spawnArgs } from "./spawn.js";
import { Ui } from "./ui.js";

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface HttpResult { status: number; body: string; ms: number; error?: string | undefined }
type Env = Record<string, string | undefined>;

export interface RunOptions {
  cwd?: string | undefined;
  env?: Env | undefined;
}
export interface ExecOptions extends RunOptions {
  /** Fed to the command's stdin, then closed. Keeps secrets off its argv. */
  input?: string | undefined;
  /** Called with each line the command prints, as it prints it. */
  onLine?: ((line: string) => void) | undefined;
}

export interface Sys {
  platform: NodeJS.Platform;
  home: string;
  env: Env;
  /** The node running this CLI. */
  node: string;
  /** Its version, "24.3.0". */
  nodeVersion: string;
  /** stdout is a terminal (not a pipe or a file). */
  tty: boolean;
  /** Is this command on PATH? */
  has(cmd: string): boolean;
  /** Run with the terminal attached (logins, anything that may ask). Resolves the exit code. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<number>;
  /** Run and capture the output. Never throws: a command that can't start is code 127. */
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  httpGet(url: string, timeoutMs?: number): Promise<HttpResult>;
  openUrl(url: string): void;
  /** Copy to the clipboard; false when there is no clipboard tool. */
  copy(text: string): boolean;
  /** 256 random bits as hex: MCP_AUTH_TOKEN. */
  token(): string;
  /** A password that is strong and can be read aloud and retyped. */
  password(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** What a flow needs: somewhere to show things and ask, and the outside world. */
export interface Io {
  ui: Ui;
  sys: Sys;
  /** The WHOOP login steps; the real ones unless a test supplies its own. */
  auth?: AuthDeps;
}

// Is a CLI tool on PATH? which/where are real executables, so no shell.
function has(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8" });
  return (r.status ?? 1) === 0 && (r.stdout ?? "").trim().length > 0;
}

// Spawn a command with the terminal attached. Resolves with the exit code.
//
// SIGTERM and SIGHUP are passed on to the child. A supervisor (systemd, a
// container runtime, a closed terminal) signals this process, not the one it
// started: without the hand-off this wrapper died and `totem start` left the
// server running, orphaned, still holding its port. The wrapper then waits for
// the child and exits with its result.
export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((res) => {
    const child = spawn(...spawnArgs(cmd, args, { stdio: "inherit", ...opts }));
    let forwarded = false;
    const onTerm = (): void => { forwarded = true; child.kill("SIGTERM"); };
    const onHup = (): void => { forwarded = true; child.kill("SIGHUP"); };
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);
    const done = (code: number): void => {
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
      res(code);
    };
    child.on("exit", (code, signal) => {
      if (signal) {
        // A signal we passed on is a normal shutdown, not a crash to report.
        if (!forwarded) process.stderr.write(`\nStopped by ${signal}.\n`);
        done(128 + (osConstants.signals[signal] ?? 0));
        return;
      }
      done(code ?? 1);
    });
    child.on("error", (err) => {
      process.stderr.write(`Couldn't start ${cmd}: ${(err as Error).message}\n`);
      done(127);
    });
  });
}

// Run a command and capture what it prints. `input` goes to its stdin (so
// secrets stay off the argv, which `ps` shows); `onLine` sees each line live.
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const { input, onLine, ...spawnOpts } = opts;
  return new Promise((res) => {
    const child = spawn(...spawnArgs(cmd, args, { stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"], ...(spawnOpts as SpawnOptions) }));
    let stdout = "";
    let stderr = "";
    let partial = "";
    const feed = (text: string): void => {
      if (!onLine) return;
      const parts = (partial + text).split(/\r?\n|\r/);
      partial = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) onLine(line);
    };
    child.stdout?.on("data", (d: Buffer) => { const t = d.toString(); stdout += t; feed(t); });
    child.stderr?.on("data", (d: Buffer) => { const t = d.toString(); stderr += t; feed(t); });
    child.on("error", (err) => res({ code: 127, stdout, stderr: stderr || (err as Error).message }));
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin?.on("error", () => { /* the command exited before reading */ });
      child.stdin?.end(input);
    }
  });
}

// GET a URL. Never throws: status 0 means no answer (`error` says why).
// Follows the URL's scheme: a self-hosted or local deployment may be plain
// http, and a TLS request to it never gets an answer.
export function httpGet(url: string, timeoutMs = 12_000): Promise<HttpResult> {
  const started = Date.now();
  return new Promise((res) => {
    const fail = (error: string): void => res({ status: 0, body: "", ms: Date.now() - started, error });
    let u: URL;
    try { u = new URL(url); } catch { fail("not a URL"); return; }
    const plain = u.protocol === "http:";
    const req = (plain ? httpRequest : httpsRequest)(
      { method: "GET", hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || (plain ? 80 : 443), path: u.pathname + u.search, headers: { "user-agent": "totem-cli" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (ch: string) => (body += ch));
        response.on("end", () => res({ status: response.statusCode ?? 0, body, ms: Date.now() - started }));
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); fail(`no answer in ${Math.round(timeoutMs / 1000)}s`); });
    req.on("error", (err) => fail((err as NodeJS.ErrnoException).code ?? err.message));
    req.end();
  });
}

// Open a URL in the default browser. Best-effort, never throws.
function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawnSync(cmd, args, { stdio: "ignore" }); } catch { /* best-effort */ }
}

function copy(text: string): boolean {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["pbcopy", []]
    : process.platform === "win32" ? ["clip", []]
    : ["xclip", ["-selection", "clipboard"]];
  try {
    return (spawnSync(cmd, args, { input: text }).status ?? 1) === 0;
  } catch {
    return false;
  }
}

// Rejection sampling over an unambiguous alphabet (no 0/O/1/l/I), in groups of
// four so it can be read across to a phone: Kq7m-Rt2x-Vb9n-Lp4w-Hd6s.
// 20 characters from 55 is about 115 bits.
export function genPassword(groups = 5): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const max = Math.floor(256 / alphabet.length) * alphabet.length; // reject modulo bias
  let chars = "";
  while (chars.length < groups * 4) {
    const b = randomBytes(1)[0]!;
    if (b < max) chars += alphabet[b % alphabet.length];
  }
  return chars.match(/.{4}/g)!.join("-");
}

export function realSys(): Sys {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    node: process.execPath,
    nodeVersion: process.versions.node,
    tty: Boolean(process.stdout.isTTY),
    has,
    run: (cmd, args, opts = {}) => run(cmd, args, opts as SpawnOptions),
    exec,
    httpGet,
    openUrl,
    copy,
    token: () => randomBytes(32).toString("hex"),
    password: () => genPassword(),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export function realIo(): Io {
  return { ui: new Ui(), sys: realSys() };
}

/**
 * How to run one of totem's own scripts. A published install ships the
 * compiled dist/ and no tsx; a source checkout has both. `preferSource` picks
 * the TypeScript source (live edits, no rebuild) when it can. `relNoExt` is
 * relative to src/ or dist/, e.g. "server". Null when neither can run.
 */
export function scriptCommand(root: string, relNoExt: string, preferSource = false): string[] | null {
  const distJs = resolve(root, "dist", `${relNoExt}.js`);
  const srcTs = resolve(root, "src", `${relNoExt}.ts`);
  const tsx = pkgBin(root, "tsx");
  const viaDist = existsSync(distJs) ? [distJs] : null;
  const viaTsx = tsx && existsSync(srcTs) ? [tsx, srcTs] : null;
  return preferSource ? viaTsx ?? viaDist : viaDist ?? viaTsx;
}
