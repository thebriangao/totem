import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import {
  ACCESS_COOKIE, REFRESH_COOKIE, browserCandidates, findBrowser, isWhoopDomain, parseDevToolsActivePort, pickWhoopTokens,
  type CdpCookie,
} from "../../src/cli/browser_login.js";
import { WEB_CLIENT_ID } from "../../src/whoop/constants.js";
import { jwt } from "../whoop/jwt_helper.js";

const access = jwt({ client_id: WEB_CLIENT_ID });
const refresh = "eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIiwiYWxnIjoiUlNBLU9BRVAifQ.opaque-refresh-token-value";
const cookie = (name: string, value: string, domain = ".whoop.com"): CdpCookie => ({ name, value, domain, path: "/" });

describe("pickWhoopTokens", () => {
  it("reads WHOOP's two session cookies", () => {
    const t = pickWhoopTokens([cookie("_ga", "x"), cookie(ACCESS_COOKIE, access), cookie(REFRESH_COOKIE, refresh)]);
    expect(t).toEqual({ accessToken: access, refreshToken: refresh, clientId: WEB_CLIENT_ID, accessCookie: ACCESS_COOKIE, refreshCookie: REFRESH_COOKIE });
  });

  it("URL-decodes cookie values", () => {
    const t = pickWhoopTokens([cookie(ACCESS_COOKIE, encodeURIComponent(access)), cookie(REFRESH_COOKIE, encodeURIComponent(`${refresh}==`))]);
    expect(t?.accessToken).toBe(access);
    expect(t?.refreshToken).toBe(`${refresh}==`);
  });

  it("waits until both are present", () => {
    expect(pickWhoopTokens([])).toBeNull();
    expect(pickWhoopTokens([cookie(ACCESS_COOKIE, access)])).toBeNull();
    expect(pickWhoopTokens([cookie(REFRESH_COOKIE, refresh)])).toBeNull();
    expect(pickWhoopTokens([cookie(ACCESS_COOKIE, "not-a-jwt"), cookie(REFRESH_COOKIE, refresh)])).toBeNull();
  });

  it("ignores look-alike domains", () => {
    expect(pickWhoopTokens([cookie(ACCESS_COOKIE, access, "evilwhoop.com"), cookie(REFRESH_COOKIE, refresh, "evilwhoop.com")])).toBeNull();
    expect(pickWhoopTokens([cookie(ACCESS_COOKIE, access, "app.whoop.com"), cookie(REFRESH_COOKIE, refresh, "app.whoop.com")])).not.toBeNull();
  });

  it("falls back to name heuristics if WHOOP renames the cookies", () => {
    const t = pickWhoopTokens([cookie("whoop-access-token-v2", access), cookie("whoop-refresh-v2", refresh)]);
    expect(t?.accessCookie).toBe("whoop-access-token-v2");
    expect(t?.refreshCookie).toBe("whoop-refresh-v2");
  });

  it("prefers the newest access token when there are several", () => {
    const older = jwt({ client_id: WEB_CLIENT_ID, exp: 1_000 });
    const t = pickWhoopTokens([cookie(ACCESS_COOKIE, older, "app.whoop.com"), cookie(ACCESS_COOKIE, access), cookie(REFRESH_COOKIE, refresh)]);
    expect(t?.accessToken).toBe(access);
  });
});

describe("isWhoopDomain", () => {
  it("accepts whoop.com and subdomains only", () => {
    expect(isWhoopDomain(".whoop.com")).toBe(true);
    expect(isWhoopDomain("api.prod.whoop.com")).toBe(true);
    expect(isWhoopDomain("whoop.com.evil.io")).toBe(false);
    expect(isWhoopDomain("notwhoop.com")).toBe(false);
  });
});

describe("parseDevToolsActivePort", () => {
  it("reads the port and the browser target path", () => {
    expect(parseDevToolsActivePort("54321\n/devtools/browser/abc-123\n")).toEqual({ port: 54321, browserPath: "/devtools/browser/abc-123" });
    expect(parseDevToolsActivePort("54321\r\n/devtools/browser/x")).toEqual({ port: 54321, browserPath: "/devtools/browser/x" });
  });
  it("rejects anything else (a page target, a half-written file)", () => {
    expect(parseDevToolsActivePort("54321\n/devtools/page/abc")).toBeNull();
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("54321")).toBeNull();
  });
});

describe("findBrowser", () => {
  it("finds Chrome first on macOS, then Chromium, Edge, Brave", () => {
    const only = (path: string) => (p: string) => p === path;
    const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    expect(findBrowser({ platform: "darwin", env: {}, home: "/Users/u", exists: only(edge) })).toEqual({ name: "Microsoft Edge", path: edge });
    const userBrave = "/Users/u/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    expect(findBrowser({ platform: "darwin", env: {}, home: "/Users/u", exists: only(userBrave) })?.name).toBe("Brave");
    const all = () => true;
    expect(findBrowser({ platform: "darwin", env: {}, home: "/Users/u", exists: all })?.name).toBe("Google Chrome");
  });

  it("looks under Program Files and LocalAppData on Windows", () => {
    const env = { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
    const msedge = win32.join("C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe");
    expect(findBrowser({ platform: "win32", env, home: "C:\\Users\\u", exists: (p) => p === msedge })).toEqual({ name: "Microsoft Edge", path: msedge });
    const userChrome = win32.join("C:\\Users\\u\\AppData\\Local", "Google\\Chrome\\Application\\chrome.exe");
    expect(findBrowser({ platform: "win32", env, home: "C:\\Users\\u", exists: (p) => p === userChrome })?.name).toBe("Google Chrome");
  });

  it("searches PATH on Linux, then snap", () => {
    const env = { PATH: "/usr/local/bin:/usr/bin" };
    expect(findBrowser({ platform: "linux", env, home: "/home/u", exists: (p) => p === "/usr/bin/chromium-browser" })).toEqual({ name: "Chromium", path: "/usr/bin/chromium-browser" });
    expect(findBrowser({ platform: "linux", env, home: "/home/u", exists: (p) => p === "/snap/bin/chromium" })?.path).toBe("/snap/bin/chromium");
    expect(findBrowser({ platform: "linux", env, home: "/home/u", exists: () => false })).toBeNull();
  });

  it("honours TOTEM_BROWSER (and CHROME) overrides", () => {
    expect(findBrowser({ platform: "linux", env: { TOTEM_BROWSER: "/opt/vivaldi/vivaldi" }, exists: () => true })).toEqual({ name: "vivaldi", path: "/opt/vivaldi/vivaldi" });
    expect(findBrowser({ platform: "darwin", env: { CHROME: "/x/chrome" }, exists: () => false })).toBeNull();
  });

  it("lists candidates as absolute paths for every platform", () => {
    for (const c of browserCandidates("darwin", {}, "/Users/u")) expect(posix.isAbsolute(c.path)).toBe(true);
    for (const c of browserCandidates("win32", { PROGRAMFILES: "C:\\PF" }, "C:\\Users\\u")) expect(win32.isAbsolute(c.path)).toBe(true);
  });
});
