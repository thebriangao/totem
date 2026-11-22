import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import {
  FileTokenStore, MemoryTokenStore, inContainer, isHandoff, migrateFromEnv, parseTokenFile, resolveTokenFilePath,
  serializeTokenFile, writeFileAtomic, type TokenRecord,
} from "../../src/whoop/token_store.js";
import { WEB_CLIENT_ID } from "../../src/whoop/constants.js";
import { jwt } from "./jwt_helper.js";

const posixOnly = process.platform === "win32" ? it.skip : it;
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const unixNonRoot = process.platform !== "win32" && !asRoot ? it : it.skip;

let dir: string;
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), "totem-store-")); });
afterEach(() => {
  try { chmodSync(dir, 0o700); } catch { /* */ }
  rmSync(dir, { recursive: true, force: true });
});

const record = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  access_token: jwt({ client_id: WEB_CLIENT_ID }),
  refresh_token: "refresh-1".padEnd(40, "x"),
  client_id: WEB_CLIENT_ID,
  source: "browser",
  saved_at: "2026-11-21T00:00:00.000Z",
  ...over,
});

describe("FileTokenStore", () => {
  it("round-trips a login as versioned JSON", () => {
    const store = new FileTokenStore(join(dir, "tokens.json"));
    expect(store.load()).toBeNull();
    store.save(record({ user_id: 7, installation_id: "ABC" }));
    expect(store.load()).toEqual(record({ user_id: 7, installation_id: "ABC" }));
    const raw = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")) as Record<string, unknown>;
    expect(raw.version).toBe(1);
    expect(raw).not.toHaveProperty("refreshed_at"); // undefined fields are dropped
  });

  posixOnly("writes 0600 and creates a 0700 parent directory", () => {
    const path = join(dir, "nested", "deeper", "tokens.json");
    new FileTokenStore(path).save(record());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested", "deeper")).mode & 0o777).toBe(0o700);
  });

  posixOnly("tightens an existing file's mode to 0600 on save", () => {
    const path = join(dir, "tokens.json");
    writeFileSync(path, serializeTokenFile(record()), { mode: 0o644 });
    new FileTokenStore(path).save(record({ refresh_token: "r2".padEnd(40, "y") }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files behind", () => {
    const store = new FileTokenStore(join(dir, "tokens.json"));
    for (let i = 0; i < 5; i++) store.save(record({ refresh_token: `r${i}`.padEnd(40, "z") }));
    expect(readdirSync(dir)).toEqual(["tokens.json"]);
  });

  unixNonRoot("a failed write throws and keeps the previous login intact", () => {
    const path = join(dir, "tokens.json");
    const store = new FileTokenStore(path);
    store.save(record({ refresh_token: "old".padEnd(40, "o") }));
    chmodSync(dir, 0o500); // no new files (the temp file) in the directory
    expect(() => store.save(record({ refresh_token: "new".padEnd(40, "n") }))).toThrow();
    chmodSync(dir, 0o700);
    expect((store.load() as TokenRecord).refresh_token).toBe("old".padEnd(40, "o"));
    expect(readdirSync(dir)).toEqual(["tokens.json"]);
  });

  it("version() changes on every save and is null without a file", () => {
    const store = new FileTokenStore(join(dir, "tokens.json"));
    expect(store.version()).toBeNull();
    store.save(record());
    const v1 = store.version();
    store.save(record({ refresh_token: "other".padEnd(40, "q") }));
    expect(store.version()).not.toBe(v1);
  });

  it("names the file when it is unreadable", () => {
    const path = join(dir, "tokens.json");
    writeFileSync(path, "{not json");
    expect(() => new FileTokenStore(path).load()).toThrow(/tokens\.json is unreadable/);
  });

  unixNonRoot("assertWritable fails fast on a read-only directory", () => {
    mkdirSync(join(dir, "ro"));
    chmodSync(join(dir, "ro"), 0o500);
    expect(() => new FileTokenStore(join(dir, "ro", "tokens.json")).assertWritable()).toThrow(/TOTEM_TOKEN_FILE/);
    chmodSync(join(dir, "ro"), 0o700);
  });
});

describe("writeFileAtomic", () => {
  it("replaces the target in one step", () => {
    const path = join(dir, "f.json");
    writeFileAtomic(path, "one");
    writeFileAtomic(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
  });
});

describe("parseTokenFile", () => {
  it("reads a hand-off marker", () => {
    const content = parseTokenFile(JSON.stringify({ version: 1, handed_off_to: "https://x.fly.dev", saved_at: "t" }));
    expect(isHandoff(content)).toBe(true);
  });

  it("infers the client id when it wasn't recorded", () => {
    const web = parseTokenFile(JSON.stringify({ access_token: jwt({ client_id: WEB_CLIENT_ID }), refresh_token: "r".repeat(30) }));
    const legacy = parseTokenFile(JSON.stringify({ access_token: jwt({ client_id: "ios-client" }), refresh_token: "r".repeat(30) }));
    expect(!isHandoff(web) && web.client_id).toBe(WEB_CLIENT_ID);
    expect(!isHandoff(legacy) && legacy.client_id).toBe("");
  });

  it("rejects a file without both tokens", () => {
    expect(() => parseTokenFile(JSON.stringify({ access_token: "a" }))).toThrow(/missing/);
  });
});

describe("migrateFromEnv (v1 .env / host secrets)", () => {
  it("moves a browser-login pair with the web client id", () => {
    const access = jwt({ client_id: WEB_CLIENT_ID });
    const r = migrateFromEnv({ WHOOP_IOS_BEARER_TOKEN: access, WHOOP_COGNITO_REFRESH_TOKEN: "rt", WHOOP_USER_ID: "42", WHOOP_INSTALLATION_ID: "IID" }, () => 0);
    expect(r).toEqual({
      access_token: access, refresh_token: "rt", client_id: WEB_CLIENT_ID, source: "env-migration",
      saved_at: "1970-01-01T00:00:00.000Z", user_id: 42, installation_id: "IID",
    });
  });

  it("keeps v1 password-flow tokens on the legacy client id", () => {
    const r = migrateFromEnv({ WHOOP_IOS_BEARER_TOKEN: jwt({ client_id: "ios" }), WHOOP_COGNITO_REFRESH_TOKEN: "rt" });
    expect(r?.client_id).toBe("");
  });

  it("needs both tokens", () => {
    expect(migrateFromEnv({ WHOOP_IOS_BEARER_TOKEN: "a" })).toBeNull();
    expect(migrateFromEnv({})).toBeNull();
  });
});

describe("resolveTokenFilePath", () => {
  it("honours TOTEM_TOKEN_FILE", () => {
    expect(resolveTokenFilePath({ TOTEM_TOKEN_FILE: "/data/tokens.json" }, "linux", "/home/u")).toBe("/data/tokens.json");
  });
  it("defaults to ~/.config/totem, or XDG_CONFIG_HOME", () => {
    expect(resolveTokenFilePath({}, "darwin", "/Users/u")).toBe("/Users/u/.config/totem/tokens.json");
    expect(resolveTokenFilePath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/totem/tokens.json");
  });
  it("uses %APPDATA% on Windows", () => {
    expect(resolveTokenFilePath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"))
      .toBe(win32.join("C:\\Users\\u\\AppData\\Roaming", "totem", "tokens.json"));
  });
});

describe("MemoryTokenStore", () => {
  it("holds content and bumps its version", () => {
    const store = new MemoryTokenStore();
    expect(store.version()).toBeNull();
    store.save(record());
    const v = store.version();
    store.save(record());
    expect(store.version()).not.toBe(v);
    expect(store.path).toBeNull();
  });
});

describe("inContainer", () => {
  it("detects Docker and container hosts", () => {
    expect(inContainer({}, (p) => p === "/.dockerenv")).toBe(true);
    expect(inContainer({ FLY_APP_NAME: "x" }, () => false)).toBe(true);
    expect(inContainer({ K_SERVICE: "svc" }, () => false)).toBe(true);
    expect(inContainer({}, () => false)).toBe(false);
  });
});
