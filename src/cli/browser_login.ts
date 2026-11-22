// Browser login for WHOOP (SPEC G4): a port of whoop-testing/probe/login.mjs.
//
// Opens a Chromium-family browser (Chrome, Chromium, Edge or Brave) with a fresh
// temporary profile on WHOOP's web app. The user logs in there themselves, so
// the real browser supplies WHOOP's device fingerprint and nothing is faked.
// totem only watches the browser's cookie jar over the Chrome DevTools Protocol:
// it talks to the BROWSER target (Storage.getCookies) and never attaches to the
// login page, so it can't see or touch what the user types. Once WHOOP sets its
// session cookies (whoop-auth-token, whoop-auth-refresh-token), the browser is
// closed and the profile deleted.
//
// The debugging port is a free loopback port picked here and passed explicitly,
// open on 127.0.0.1 for the minutes the login takes. It must not be
// --remote-debugging-port=0 or --remote-debugging-pipe: Chromium treats both as
// "driven by automation" and sets navigator.webdriver = true (content/child/
// runtime_features.cc; seen on a headful Chrome), which a login page's fraud
// check reads. An explicit port leaves the browser exactly as a person's, and
// is what the prototype logged in with.
//
// Anything running on this machine can reach that port while the window is
// open. That is inherent in a debugging port; on a shared machine use
// `totem auth --paste` instead.
//
// This module returns results and emits events; it prints nothing. The CLI
// (src/cli/auth.ts) does the talking.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { decodeJwtClientId, decodeJwtExp } from "../whoop/cognito.js";

export const ACCESS_COOKIE = "whoop-auth-token";
export const REFRESH_COOKIE = "whoop-auth-refresh-token";
export const LOGIN_URL = "https://app.whoop.com/";

// ── finding a browser ────────────────────────────────────────────────────────

export interface FoundBrowser {
  name: string;
  path: string;
}

type Env = Record<string, string | undefined>;

function envGet(env: Env, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((x) => x.toUpperCase() === key.toUpperCase());
  return k ? env[k] : undefined;
}

/** Every place a supported browser might live on this OS, most preferred first. */
export function browserCandidates(platform: NodeJS.Platform, env: Env, home: string): FoundBrowser[] {
  if (platform === "darwin") {
    const apps: Array<[string, string]> = [
      ["Google Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
      ["Microsoft Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
    ];
    const roots = ["/Applications", posix.join(home, "Applications")];
    return apps.flatMap(([name, rel]) => roots.map((root) => ({ name, path: posix.join(root, rel) })));
  }
  if (platform === "win32") {
    const roots = [envGet(env, "PROGRAMFILES"), envGet(env, "PROGRAMFILES(X86)"), envGet(env, "LOCALAPPDATA")].filter(
      (r): r is string => Boolean(r),
    );
    const apps: Array<[string, string]> = [
      ["Google Chrome", "Google\\Chrome\\Application\\chrome.exe"],
      ["Chromium", "Chromium\\Application\\chrome.exe"],
      ["Microsoft Edge", "Microsoft\\Edge\\Application\\msedge.exe"],
      ["Brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    ];
    return apps.flatMap(([name, rel]) => roots.map((root) => ({ name, path: win32.join(root, rel) })));
  }
  // Linux and the BSDs: look on PATH, then the snap location.
  const names: Array<[string, string]> = [
    ["Google Chrome", "google-chrome-stable"],
    ["Google Chrome", "google-chrome"],
    ["Chromium", "chromium"],
    ["Chromium", "chromium-browser"],
    ["Microsoft Edge", "microsoft-edge-stable"],
    ["Microsoft Edge", "microsoft-edge"],
    ["Brave", "brave-browser"],
    ["Brave", "brave"],
  ];
  const dirs = (envGet(env, "PATH") ?? "").split(":").filter(Boolean);
  const onPath = names.flatMap(([name, bin]) => dirs.map((d) => ({ name, path: posix.join(d, bin) })));
  return [...onPath, { name: "Chromium", path: "/snap/bin/chromium" }];
}

/**
 * The browser to log in with: TOTEM_BROWSER (or CHROME) when set, else the first
 * installed candidate. Null when none is found.
 */
export function findBrowser(
  opts: { platform?: NodeJS.Platform; env?: Env; home?: string; exists?: (path: string) => boolean } = {},
): FoundBrowser | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p: string) => {
    try { return statSync(p).isFile(); } catch { return false; }
  });
  const override = envGet(env, "TOTEM_BROWSER") || envGet(env, "CHROME");
  if (override) return exists(override) ? { name: basename(override), path: override } : null;
  for (const candidate of browserCandidates(platform, env, opts.home ?? homedir())) {
    if (exists(candidate.path)) return candidate;
  }
  return null;
}

// ── reading WHOOP's cookies ─────────────────────────────────────────────────

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
}

export interface WhoopLoginTokens {
  accessToken: string;
  refreshToken: string;
  /** Cognito client of the access token (the web client for browser logins). */
  clientId: string | null;
  accessCookie: string;
  refreshCookie: string;
}

const looksJwt = (v: string): boolean => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v);

function decodeCookie(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** whoop.com or a subdomain of it (not "evilwhoop.com"). */
export function isWhoopDomain(domain: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  return d === "whoop.com" || d.endsWith(".whoop.com");
}

/**
 * Pick WHOOP's session tokens out of a cookie jar: the access JWT from
 * `whoop-auth-token` and the refresh token from `whoop-auth-refresh-token`,
 * falling back to the prototype's name heuristics if WHOOP renames them.
 * Null until both are present.
 */
export function pickWhoopTokens(cookies: readonly CdpCookie[]): WhoopLoginTokens | null {
  const jar = cookies.filter((c) => isWhoopDomain(c.domain)).map((c) => ({ ...c, value: decodeCookie(c.value) }));
  const newestJwt = (list: typeof jar) =>
    list.filter((c) => looksJwt(c.value)).sort((a, b) => decodeJwtExp(b.value) - decodeJwtExp(a.value))[0];
  const access =
    newestJwt(jar.filter((c) => c.name === ACCESS_COOKIE)) ??
    newestJwt(jar.filter((c) => /(auth-token|access)/i.test(c.name) && !/refresh/i.test(c.name)));
  const refresh =
    jar.find((c) => c.name === REFRESH_COOKIE && c.value.length >= 20) ??
    jar.find((c) => /refresh/i.test(c.name) && c.value.length > 40);
  if (!access || !refresh) return null;
  return {
    accessToken: access.value,
    refreshToken: refresh.value,
    clientId: decodeJwtClientId(access.value),
    accessCookie: access.name,
    refreshCookie: refresh.name,
  };
}

/**
 * The browser target's path from /json/version's `webSocketDebuggerUrl`
 * ("ws://127.0.0.1:9222/devtools/browser/<id>"). Only the path is used: the
 * connection always goes to 127.0.0.1 on the port we chose, whatever host the
 * answer names. Null for anything that isn't a browser target.
 */
export function browserTargetPath(webSocketDebuggerUrl: unknown): string | null {
  if (typeof webSocketDebuggerUrl !== "string") return null;
  let path: string;
  try {
    path = new URL(webSocketDebuggerUrl).pathname;
  } catch {
    return null;
  }
  return /^\/devtools\/browser\/[\w-]+$/.test(path) ? path : null;
}

/** A free port on 127.0.0.1 for the browser's debugging endpoint. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolvePort(port) : rejectPort(new Error("no free port"))));
    });
  });
}

// ── CDP over the browser target ─────────────────────────────────────────────

interface CdpConnection {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

function connectCdp(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const failAll = (error: Error): void => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
      pending.clear();
    };
    ws.onmessage = (event) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.id === undefined) return; // an event; we don't subscribe to any
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result);
    };
    ws.onclose = () => failAll(new Error("the browser's debugging connection closed"));
    ws.onerror = () => rejectConn(new Error("couldn't connect to the browser's debugging endpoint"));
    ws.onopen = () => {
      resolveConn({
        send: <T>(method: string, params: Record<string, unknown> = {}) =>
          new Promise<T>((resolveSend, rejectSend) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectSend(new Error(`${method} timed out`));
            }, timeoutMs);
            pending.set(id, { resolve: resolveSend as (v: unknown) => void, reject: rejectSend, timer });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => {
          try { ws.close(); } catch { /* already closed */ }
        },
      });
    };
  });
}

// ── the login ───────────────────────────────────────────────────────────────

export type BrowserLoginEvent =
  | { type: "launched"; browser: FoundBrowser }
  | { type: "cookie"; name: string; domain: string }
  | { type: "captured"; accessCookie: string; refreshCookie: string };

export interface BrowserLoginOptions {
  browser: FoundBrowser;
  url?: string;
  /** Give up after this long. Default 15 minutes. */
  timeoutMs?: number;
  pollMs?: number;
  /** Only for smoke tests: no visible window. Real logins are headful. */
  headless?: boolean;
  onEvent?: (event: BrowserLoginEvent) => void;
}

export class BrowserLoginError extends Error {
  constructor(message: string, public readonly reason: "closed" | "timeout" | "launch" | "cancelled") {
    super(message);
    this.name = "BrowserLoginError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Where to put the temporary profile. Snap-confined Chromium can't read a private /tmp. */
function profileParent(browser: FoundBrowser): string {
  if (process.env.TOTEM_PROFILE_DIR) return process.env.TOTEM_PROFILE_DIR;
  return browser.path.startsWith("/snap/") ? homedir() : tmpdir();
}

/**
 * Open the browser on WHOOP's web app and wait until the user has logged in.
 * Resolves with the tokens; always closes the browser and deletes the profile.
 */
export async function captureBrowserLogin(opts: BrowserLoginOptions): Promise<WhoopLoginTokens> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 1_500;
  const emit = opts.onEvent ?? (() => undefined);
  // An explicit port, never 0: see the note at the top of this file.
  const port = await freeLoopbackPort();
  const profile = mkdtempSync(join(profileParent(opts.browser), "totem-login-"));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    ...(opts.headless ? ["--headless=new"] : ["--new-window"]),
    opts.url ?? LOGIN_URL,
  ];

  let child: ChildProcess | null = null;
  let exited = false;
  let cdp: CdpConnection | null = null;
  const cleanupSync = (): void => {
    try { cdp?.close(); } catch { /* */ }
    if (child && !exited) {
      try { child.kill(); } catch { /* */ }
    }
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort */ }
  };
  // Ctrl-C exits the CLI from anywhere; don't leave a browser or profile behind.
  process.once("exit", cleanupSync);

  try {
    child = spawn(opts.browser.path, args, { stdio: "ignore" });
    const spawnError = new Promise<never>((_, reject) => {
      child!.once("error", (e) => reject(new BrowserLoginError(`couldn't start ${opts.browser.name}: ${e.message}`, "launch")));
    });
    spawnError.catch(() => undefined); // only consumed by the race below
    child.once("exit", () => { exited = true; });
    emit({ type: "launched", browser: opts.browser });

    // Ask the debugging endpoint for its browser target (with an explicit port
    // Chromium doesn't write DevToolsActivePort).
    const findBrowserTarget = async (): Promise<string> => {
      for (let i = 0; i < 120; i++) {
        if (exited) throw new BrowserLoginError(`${opts.browser.name} closed before it was ready`, "launch");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
          const info = response.ok ? ((await response.json()) as { webSocketDebuggerUrl?: unknown }) : null;
          const path = browserTargetPath(info?.webSocketDebuggerUrl);
          if (path) return path;
        } catch {
          // not listening yet
        }
        await sleep(250);
      }
      throw new BrowserLoginError(`${opts.browser.name} never opened its debugging port`, "launch");
    };
    const browserPath = await Promise.race([findBrowserTarget(), spawnError]);
    cdp = await connectCdp(`ws://127.0.0.1:${port}${browserPath}`);

    const seen = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) throw new BrowserLoginError("The browser was closed before the login finished.", "closed");
      let cookies: CdpCookie[] = [];
      try {
        cookies = (await cdp.send<{ cookies: CdpCookie[] }>("Storage.getCookies")).cookies ?? [];
      } catch {
        if (exited) continue;
      }
      for (const c of cookies) {
        if (!isWhoopDomain(c.domain)) continue;
        const key = `${c.domain} ${c.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        emit({ type: "cookie", name: c.name, domain: c.domain });
      }
      const tokens = pickWhoopTokens(cookies);
      if (tokens) {
        emit({ type: "captured", accessCookie: tokens.accessCookie, refreshCookie: tokens.refreshCookie });
        try {
          await cdp.send("Browser.close"); // graceful: lets the browser flush and exit
        } catch { /* fall through to kill */ }
        for (let i = 0; i < 20 && !exited; i++) await sleep(150);
        return tokens;
      }
      await sleep(pollMs);
    }
    throw new BrowserLoginError(`Timed out after ${Math.round(timeoutMs / 60_000)} minutes without a WHOOP login.`, "timeout");
  } finally {
    process.removeListener("exit", cleanupSync);
    cleanupSync();
  }
}

/** For messages when no browser is found. */
export const SUPPORTED_BROWSERS = "Google Chrome, Chromium, Microsoft Edge or Brave";
