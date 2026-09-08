import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EnvFileTokenStore, MemoryTokenStore } from "../../src/whoop/token_store.js";
import { readEnvFile } from "../../src/lib/env_file.js";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "totem-store-"));
  envPath = resolve(dir, ".env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("EnvFileTokenStore", () => {
  it("writes both tokens and reads them back", () => {
    writeFileSync(envPath, "WHOOP_EMAIL=a@b.com\n");
    new EnvFileTokenStore(envPath).save({ accessToken: "eyJ.access", refreshToken: "eyJ.refresh" });
    expect(readEnvFile(envPath)).toMatchObject({
      WHOOP_EMAIL: "a@b.com",
      WHOOP_IOS_BEARER_TOKEN: "eyJ.access",
      WHOOP_COGNITO_REFRESH_TOKEN: "eyJ.refresh",
    });
  });

  // A token refresh rewrites .env. It must not mangle a password containing `#`
  // that dotenv would otherwise read back truncated (issue #27).
  it("preserves a #-containing password across a refresh", () => {
    writeFileSync(envPath, "# comment\nWHOOP_PASSWORD='#hunter2'\nWHOOP_EMAIL=a@b.com\n");
    new EnvFileTokenStore(envPath).save({ accessToken: "t1", refreshToken: "r1" });
    expect(readEnvFile(envPath).WHOOP_PASSWORD).toBe("#hunter2");
    expect(readFileSync(envPath, "utf8")).toContain("# comment");
  });

  it("updates existing token lines in place rather than appending duplicates", () => {
    writeFileSync(envPath, "WHOOP_IOS_BEARER_TOKEN=old\nWHOOP_COGNITO_REFRESH_TOKEN=older\n");
    const store = new EnvFileTokenStore(envPath);
    store.save({ accessToken: "new", refreshToken: "newer" });
    store.save({ accessToken: "newest", refreshToken: "newester" });
    const text = readFileSync(envPath, "utf8");
    expect(text.match(/^WHOOP_IOS_BEARER_TOKEN=/gm)).toHaveLength(1);
    expect(readEnvFile(envPath)).toEqual({
      WHOOP_IOS_BEARER_TOKEN: "newest",
      WHOOP_COGNITO_REFRESH_TOKEN: "newester",
    });
  });

  it("keeps 0600 on the token file", () => {
    writeFileSync(envPath, "WHOOP_EMAIL=a@b.com\n", { mode: 0o644 });
    new EnvFileTokenStore(envPath).save({ accessToken: "t", refreshToken: "r" });
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("does nothing when the env file is absent (memory-store hosts)", () => {
    const missing = resolve(dir, "nope.env");
    expect(() => new EnvFileTokenStore(missing).save({ accessToken: "t", refreshToken: "r" })).not.toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});

describe("MemoryTokenStore", () => {
  it("persists nothing", () => {
    expect(() => new MemoryTokenStore().save({ accessToken: "t", refreshToken: "r" })).not.toThrow();
  });
});
