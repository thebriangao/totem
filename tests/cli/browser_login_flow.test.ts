// captureBrowserLogin end to end against a stand-in browser (fixtures/fake_browser.mjs):
// how the browser is started, what is read from it, and what is left behind.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserLoginError, LOGIN_URL, captureBrowserLogin, type BrowserLoginEvent } from "../../src/cli/browser_login.js";
import { WEB_CLIENT_ID } from "../../src/whoop/constants.js";
import { jwt } from "../whoop/jwt_helper.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake_browser.mjs", import.meta.url));
const RUNNER = fileURLToPath(new URL("./fixtures/browser_login_runner.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const access = jwt({ client_id: WEB_CLIENT_ID, who: "member" });
const refresh = `refresh-${"r".repeat(60)}`;
const COOKIES = [
  { name: "whoop-auth-token", value: jwt({ client_id: WEB_CLIENT_ID, who: "decoy", exp: 4_000_000_000 }), domain: "evilwhoop.com" },
  { name: "whoop-auth-refresh-token", value: `decoy-${"d".repeat(60)}`, domain: "whoop.com.evil.test" },
  { name: "_ga", value: "GA1.2.3", domain: ".whoop.com" },
  { name: "whoop-auth-token", value: access, domain: ".whoop.com", late: true },
  { name: "whoop-auth-refresh-token", value: refresh, domain: ".whoop.com", late: true },
];

type LogEntry = { event: "start"; pid: number; args: string[]; port: number } | { event: "cdp"; method: string; sessionId: string | null };

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const until = async (what: () => boolean, ms = 5_000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (what()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return what();
};

describe.skipIf(process.platform === "win32")("captureBrowserLogin", () => {
  let dir: string;
  let profiles: string;
  let logFile: string;
  let browser: { name: string; path: string };
  const saved: Record<string, string | undefined> = {};
  const readLog = (): LogEntry[] =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEntry) : [];
  const started = (): Extract<LogEntry, { event: "start" }> | undefined =>
    readLog().find((l): l is Extract<LogEntry, { event: "start" }> => l.event === "start");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "totem-browser-"));
    profiles = join(dir, "profiles");
    mkdirSync(profiles);
    logFile = join(dir, "browser.log");
    const exe = join(dir, "fake-chrome");
    writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(exe, 0o755);
    browser = { name: "Fake", path: exe };
    for (const k of ["TOTEM_PROFILE_DIR", "FAKE_BROWSER_LOG", "FAKE_BROWSER_COOKIES", "FAKE_BROWSER_MODE"]) saved[k] = process.env[k];
    process.env.TOTEM_PROFILE_DIR = profiles;
    process.env.FAKE_BROWSER_LOG = logFile;
    process.env.FAKE_BROWSER_COOKIES = JSON.stringify(COOKIES);
    process.env.FAKE_BROWSER_MODE = "login";
  });
  afterEach(() => {
    const pid = started()?.pid;
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts the browser on a debugging port it chose (never 0), on loopback, with a temporary profile", async () => {
    await captureBrowserLogin({ browser, pollMs: 20, timeoutMs: 10_000 });
    const { args } = started()!;
    const port = Number(args.find((a) => a.startsWith("--remote-debugging-port="))?.split("=")[1]);
    // Chromium treats port 0 as "driven by automation" and sets
    // navigator.webdriver, which a login page's fraud check reads.
    expect(port).toBeGreaterThan(1023);
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args.some((a) => /^--(headless|enable-automation|remote-debugging-pipe)/.test(a))).toBe(false);
    expect(args.find((a) => a.startsWith("--user-data-dir="))).toMatch(new RegExp(`^--user-data-dir=${profiles}/totem-login-`));
    expect(args.at(-1)).toBe(LOGIN_URL);
  });

  it("reads WHOOP's two cookies off the browser target and nothing else", async () => {
    const events: BrowserLoginEvent[] = [];
    const tokens = await captureBrowserLogin({ browser, pollMs: 20, timeoutMs: 10_000, onEvent: (e) => events.push(e) });
    expect(tokens).toEqual({ accessToken: access, refreshToken: refresh, clientId: WEB_CLIENT_ID, accessCookie: "whoop-auth-token", refreshCookie: "whoop-auth-refresh-token" });
    const cdp = readLog().filter((l): l is Extract<LogEntry, { event: "cdp" }> => l.event === "cdp");
    expect(new Set(cdp.map((l) => l.method))).toEqual(new Set(["Storage.getCookies", "Browser.close"]));
    expect(cdp.every((l) => l.sessionId === null)).toBe(true); // never attached to a page
    // Events name cookies; they never carry a value, and never a look-alike domain's.
    expect(events.filter((e) => e.type === "cookie")).toEqual([
      { type: "cookie", name: "_ga", domain: ".whoop.com" },
      { type: "cookie", name: "whoop-auth-token", domain: ".whoop.com" },
      { type: "cookie", name: "whoop-auth-refresh-token", domain: ".whoop.com" },
    ]);
    for (const c of COOKIES) expect(JSON.stringify(events)).not.toContain(c.value);
  });

  it("closes the browser and deletes the profile after a login", async () => {
    await captureBrowserLogin({ browser, pollMs: 20, timeoutMs: 10_000 });
    expect(readdirSync(profiles)).toEqual([]);
    expect(await until(() => !alive(started()!.pid))).toBe(true);
  });

  it("does the same when the login times out or the browser is closed", async () => {
    process.env.FAKE_BROWSER_MODE = "never";
    await expect(captureBrowserLogin({ browser, pollMs: 20, timeoutMs: 600 })).rejects.toMatchObject({ reason: "timeout" });
    expect(readdirSync(profiles)).toEqual([]);
    expect(await until(() => !alive(started()!.pid))).toBe(true);

    rmSync(logFile);
    const pending = captureBrowserLogin({ browser, pollMs: 20, timeoutMs: 10_000 });
    const closed = expect(pending).rejects.toBeInstanceOf(BrowserLoginError);
    expect(await until(() => readLog().some((l) => l.event === "cdp"))).toBe(true);
    process.kill(started()!.pid, "SIGTERM"); // the user quit the browser
    await closed;
    await expect(pending).rejects.toMatchObject({ reason: "closed" });
    expect(readdirSync(profiles)).toEqual([]);
  });
});
