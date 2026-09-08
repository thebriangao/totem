import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse } from "dotenv";
import {
  serializeEnvValue,
  serializeEnvLine,
  readEnvFile,
  upsertEnvFile,
  deleteEnvKeys,
} from "../../src/lib/env_file.js";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "totem-env-"));
  envPath = resolve(dir, ".env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The regression from issue #27: an unquoted `#` is an inline comment to dotenv,
// so `#hunter2` came back as "" and `abc#def` as "abc" — a wrong-password 401
// for a correct password.
describe("serializeEnvValue round-trips through dotenv", () => {
  const values = [
    "plain",
    "#hunter2",          // leading # → parsed as "" when bare
    "abc#def",           // inline # → truncated when bare
    "  padded  ",        // bare values are trimmed
    "",
    "it's",
    'say "hi"',
    "back\\slash",
    "literal\\nnotnewline",
    "a'b\"c",            // needs backticks
    "eyJhbGciOi.jwt-like_value",
    "semi;colon and space",
    "=equals=",
  ];

  for (const value of values) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      const parsed = parse(serializeEnvLine("K", value));
      expect(parsed.K).toBe(value);
    });
  }

  it("prefers the bare form for plain values", () => {
    expect(serializeEnvValue("plain")).toBe("plain");
    expect(serializeEnvValue("eyJhbGciOi.jwt-like_value")).toBe("eyJhbGciOi.jwt-like_value");
  });

  it("quotes anything dotenv would mangle", () => {
    expect(serializeEnvValue("#hunter2")).toBe("'#hunter2'");
    expect(serializeEnvValue("  padded  ")).toBe("'  padded  '");
  });

  it("throws rather than silently corrupting an unrepresentable value", () => {
    expect(() => serializeEnvValue("all three ' \" `")).toThrow(/Cannot represent/);
  });
});

describe("upsertEnvFile", () => {
  it("creates the file with 0600 and appends keys", () => {
    upsertEnvFile(envPath, { WHOOP_EMAIL: "a@b.com", WHOOP_PASSWORD: "#hunter2" });
    expect(readEnvFile(envPath)).toEqual({ WHOOP_EMAIL: "a@b.com", WHOOP_PASSWORD: "#hunter2" });
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("updates in place, preserving comments, blanks and unrelated keys", () => {
    writeFileSync(envPath, [
      "# a comment",
      "WHOOP_EMAIL=old@example.com",
      "",
      "OTHER=keepme",
      "# trailing note",
    ].join("\n") + "\n");

    upsertEnvFile(envPath, { WHOOP_EMAIL: "new@example.com" });

    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("# a comment");
    expect(text).toContain("# trailing note");
    expect(text).toContain("OTHER=keepme");
    expect(text).toContain("WHOOP_EMAIL=new@example.com");
    expect(text).not.toContain("old@example.com");
    // the update replaces the original line rather than appending a second one
    expect(text.match(/^WHOOP_EMAIL=/gm)).toHaveLength(1);
  });

  it("collapses duplicate assignments of an updated key", () => {
    writeFileSync(envPath, "K=one\nK=two\nOTHER=x\n");
    upsertEnvFile(envPath, { K: "three" });
    expect(readFileSync(envPath, "utf8").match(/^K=/gm)).toHaveLength(1);
    expect(readEnvFile(envPath)).toEqual({ K: "three", OTHER: "x" });
  });

  it("does not leave a blank line between existing content and appended keys", () => {
    writeFileSync(envPath, "EXISTING=1\n");
    upsertEnvFile(envPath, { ADDED: "2" });
    expect(readFileSync(envPath, "utf8")).toBe("EXISTING=1\nADDED=2\n");
  });

  it("survives a value that would otherwise be read back as a comment", () => {
    upsertEnvFile(envPath, { WHOOP_PASSWORD: "#hunter2" });
    upsertEnvFile(envPath, { WHOOP_IOS_BEARER_TOKEN: "eyJ.abc" });
    expect(readEnvFile(envPath).WHOOP_PASSWORD).toBe("#hunter2");
  });
});

describe("readEnvFile", () => {
  it("returns {} for a missing file", () => {
    expect(readEnvFile(resolve(dir, "nope.env"))).toEqual({});
  });
});

describe("deleteEnvKeys", () => {
  it("removes only the named keys and keeps comments", () => {
    writeFileSync(envPath, "# keep\nWHOOP_PASSWORD='#hunter2'\nWHOOP_EMAIL=a@b.com\n");
    deleteEnvKeys(envPath, ["WHOOP_PASSWORD"]);
    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("# keep");
    expect(text).toContain("WHOOP_EMAIL=a@b.com");
    expect(text).not.toContain("WHOOP_PASSWORD");
  });

  it("is a no-op on a missing file", () => {
    expect(() => deleteEnvKeys(resolve(dir, "nope.env"), ["K"])).not.toThrow();
  });
});
