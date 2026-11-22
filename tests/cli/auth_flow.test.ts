import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loginFromCookies, loginWithRefreshToken, markHandedOff, pickInstallationId, pushLogin, readLocalStatus,
  resolveAuthTarget, retireLegacyEnv, saveLocalLogin, validateLogin, type WhoopLogin,
} from "../../src/cli/auth_flow.js";
import { flyToml } from "../../src/cli/setup.js";
import { readDeployRecord, writeDeployRecord } from "../../src/cli/deploy_record.js";
import { CognitoError } from "../../src/whoop/cognito.js";
import { WEB_CLIENT_ID } from "../../src/whoop/constants.js";
import { FileTokenStore, type TokenRecord } from "../../src/whoop/token_store.js";
import { jwt } from "../whoop/jwt_helper.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "totem-auth-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const login: WhoopLogin = { accessToken: jwt({ client_id: WEB_CLIENT_ID }), refreshToken: "r".repeat(48), clientId: WEB_CLIENT_ID, source: "browser" };

describe("resolveAuthTarget", () => {
  const env = { TOTEM_TOKEN_FILE: "/tmp/t.json" };
  it("pushes to the recorded deployment by default", () => {
    expect(resolveAuthTarget({ platform: "fly", app: "a", url: "https://a.fly.dev/", mcp_auth_token: "tok" }, {}, env))
      .toEqual({ kind: "remote", url: "https://a.fly.dev", adminToken: "tok", platform: "fly" });
  });
  it("saves locally with --local, for a local install, or with no record", () => {
    const local = { kind: "local", tokenFile: "/tmp/t.json" };
    expect(resolveAuthTarget({ platform: "fly", url: "https://a.fly.dev" }, { local: true }, env)).toEqual(local);
    expect(resolveAuthTarget({ platform: "local" }, {}, env)).toEqual(local);
    expect(resolveAuthTarget(null, {}, env)).toEqual(local);
  });
  it("--url targets any server, reusing the recorded token only for the same URL", () => {
    const rec = { platform: "custom", url: "https://me.example", mcp_auth_token: "tok" };
    expect(resolveAuthTarget(rec, { url: "https://me.example/" }, env)).toMatchObject({ kind: "remote", url: "https://me.example", adminToken: "tok" });
    expect(resolveAuthTarget(rec, { url: "https://other.example" }, env)).toMatchObject({ kind: "remote", adminToken: undefined });
  });
});

describe("getting tokens", () => {
  it("browser cookies become a web-client login", () => {
    expect(loginFromCookies({ accessToken: "a", refreshToken: "r", clientId: WEB_CLIENT_ID })).toEqual({ accessToken: "a", refreshToken: "r", clientId: WEB_CLIENT_ID, source: "browser" });
  });

  it("a pasted refresh token is exchanged with the web client, falling back to the legacy one", async () => {
    const refresh = vi.fn()
      .mockRejectedValueOnce(new CognitoError("NotAuthorizedException: Invalid Refresh Token", 400, "NotAuthorizedException"))
      .mockResolvedValueOnce({ accessToken: "acc", refreshToken: "rotated", idToken: "", expiresAt: 0 });
    const result = await loginWithRefreshToken("  pasted  ", { refresh });
    expect(refresh.mock.calls).toEqual([["pasted", WEB_CLIENT_ID], ["pasted", ""]]);
    expect(result).toEqual({ accessToken: "acc", refreshToken: "rotated", clientId: "", source: "paste" });
  });

  it("doesn't try a second client when WHOOP is unreachable", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(loginWithRefreshToken("t", { refresh })).rejects.toThrow("fetch failed");
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("validateLogin", () => {
  it("sends one bootstrap GET with the app's device headers and no apiVersion", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: { id: 44797041 } }), { status: 200 }));
    const v = await validateLogin("ACCESS", { installationId: "IID-1", fetch: fetchMock as unknown as typeof fetch });
    expect(v).toEqual({ accepted: true, userId: 44797041, status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.prod.whoop.com/users-service/v2/bootstrap");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ACCESS");
    expect(headers["user-agent"]).toBe("iOS");
    expect(headers["x-whoop-device-platform"]).toBe("iOS");
    expect(headers["x-whoop-installation-identifier"]).toBe("IID-1");
  });

  it("distinguishes a refused token from an unknown outcome", async () => {
    const mk = (status: number) => vi.fn(async () => new Response("", { status })) as unknown as typeof fetch;
    expect((await validateLogin("x", { installationId: "i", fetch: mk(401) })).accepted).toBe(false);
    expect((await validateLogin("x", { installationId: "i", fetch: mk(503) })).accepted).toBeNull();
    const offline = vi.fn(async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    expect(await validateLogin("x", { installationId: "i", fetch: offline })).toMatchObject({ accepted: null, detail: "ENOTFOUND" });
  });
});

describe("saving and handing off", () => {
  it("saves a local login with its client id, user id and installation id", () => {
    const file = join(dir, "tokens.json");
    saveLocalLogin(file, login, { userId: 5, installationId: "IID", now: () => 0 });
    expect(new FileTokenStore(file).load()).toEqual({
      access_token: login.accessToken, refresh_token: login.refreshToken, client_id: WEB_CLIENT_ID, source: "browser",
      saved_at: "1970-01-01T00:00:00.000Z", user_id: 5, installation_id: "IID",
    });
    expect(readLocalStatus(file)).toMatchObject({ state: "tokens", source: "browser", owner: null });
  });

  it("after a push, leaves a hand-off marker instead of a refreshing copy", () => {
    const file = join(dir, "tokens.json");
    expect(markHandedOff(file, "https://a.fly.dev", { userId: 5, installationId: "IID" })).toEqual({ marked: true, keptLocalLogin: false });
    expect(readLocalStatus(file)).toMatchObject({ state: "handed-off", handedOffTo: "https://a.fly.dev" });
  });

  it("retires v1's migrated copy (which v1 also pushed to the host)", () => {
    const file = join(dir, "tokens.json");
    const v1: TokenRecord = { access_token: login.accessToken, refresh_token: "old", client_id: "", source: "env-migration", saved_at: "t", installation_id: "OLD-IID" };
    new FileTokenStore(file).save(v1);
    expect(markHandedOff(file, "https://a.fly.dev", { userId: null, installationId: "NEW" }).marked).toBe(true);
    const marker = new FileTokenStore(file).load();
    expect(marker).toMatchObject({ handed_off_to: "https://a.fly.dev", installation_id: "OLD-IID" });
    expect(readFileSync(file, "utf8")).not.toContain("old\"");
  });

  it("leaves a separate local login alone", () => {
    const file = join(dir, "tokens.json");
    saveLocalLogin(file, login, { userId: null, installationId: "IID" });
    expect(markHandedOff(file, "https://a.fly.dev", { userId: null, installationId: "IID" })).toEqual({ marked: false, keptLocalLogin: true });
    expect(readLocalStatus(file).state).toBe("tokens");
  });

  it("removes v1's token and password keys from .env, keeping the rest", () => {
    const env = join(dir, ".env");
    writeFileSync(env, "WHOOP_EMAIL=a@b.c\nWHOOP_PASSWORD='#x'\nWHOOP_IOS_BEARER_TOKEN=a\nWHOOP_COGNITO_REFRESH_TOKEN=r\nWHOOP_TIMEZONE=UTC\n");
    expect(retireLegacyEnv(env).sort()).toEqual(["WHOOP_COGNITO_REFRESH_TOKEN", "WHOOP_IOS_BEARER_TOKEN", "WHOOP_PASSWORD"]);
    expect(readFileSync(env, "utf8")).toBe("WHOOP_EMAIL=a@b.c\nWHOOP_TIMEZONE=UTC\n");
    expect(retireLegacyEnv(join(dir, "missing.env"))).toEqual([]);
  });

  it("reuses the device id already on file", () => {
    expect(pickInstallationId({ handed_off_to: "u", saved_at: "t", installation_id: "KEEP" }, {})).toBe("KEEP");
    expect(pickInstallationId(null, { WHOOP_INSTALLATION_ID: "ENV" })).toBe("ENV");
    expect(pickInstallationId(null, {})).toMatch(/^[0-9A-F-]{36}$/);
  });
});

describe("pushLogin", () => {
  it("POSTs the login to /admin/tokens with the MCP_AUTH_TOKEN", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, state: "ok", durable: true }), { status: 200 }));
    const r = await pushLogin("https://a.fly.dev/", "tok", login, { userId: 7 }, { fetch: fetchMock as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, status: { ok: true, state: "ok", durable: true } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://a.fly.dev/admin/tokens");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({
      access_token: login.accessToken, refresh_token: login.refreshToken, client_id: WEB_CLIENT_ID, source: "browser", user_id: 7,
    });
  });

  it("classifies failures", async () => {
    const mk = (status: number, body = "") => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await pushLogin("https://x", "t", login, { userId: null }, { fetch: mk(401) })).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(await pushLogin("https://x", "t", login, { userId: null }, { fetch: mk(404, "<html>") })).toMatchObject({ ok: false, reason: "not-found" });
    expect(await pushLogin("https://x", "t", login, { userId: null }, { fetch: mk(500, JSON.stringify({ error_description: "EROFS" })) }))
      .toMatchObject({ ok: false, reason: "server-error", detail: "EROFS" });
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await pushLogin("https://x", "t", login, { userId: null }, { fetch: down })).toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("deploy record", () => {
  it("is written 0600 because it holds the MCP_AUTH_TOKEN", () => {
    writeDeployRecord(dir, { platform: "fly", app: "a", url: "https://a.fly.dev", mcp_auth_token: "secret" });
    expect(readDeployRecord(dir)).toEqual({ platform: "fly", app: "a", url: "https://a.fly.dev", mcp_auth_token: "secret" });
    if (process.platform !== "win32") expect(statSync(join(dir, ".totem-deploy.json")).mode & 0o777).toBe(0o600);
  });
});

describe("fly.toml", () => {
  it("mounts the token volume at /data", () => {
    const toml = flyToml("totem-abc", true);
    expect(toml).toContain('app = "totem-abc"');
    expect(toml).toMatch(/\[mounts\]\n {2}source = "totem_data"\n {2}destination = "\/data"/);
    expect(flyToml("totem-abc", false)).not.toContain("[mounts]");
  });
});
