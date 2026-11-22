import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, lstatSync, readdirSync,
  openSync, readSync, closeSync, symlinkSync, chmodSync,
} from "node:fs";
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

  // dotenv reads `\'` as an escaped quote, so 'hunter2\' kept going to the next
  // quote in the file. A backslash is harmless in a bare value.
  it("writes a plain value containing backslashes bare", () => {
    expect(serializeEnvValue("hunter2\\")).toBe("hunter2\\");
    expect(serializeEnvValue("C:\\path\\to")).toBe("C:\\path\\to");
    expect(serializeEnvValue("literal\\nnotnewline")).toBe("literal\\nnotnewline");
  });

  // dotenv converts every CR in the file to LF before parsing; only "\r" inside
  // double quotes yields one.
  for (const value of ["a\rb", "\r", "line1\r\nline2", "tab\tand\rcr #x"]) {
    it(`round-trips a carriage return: ${JSON.stringify(value)}`, () => {
      expect(parse(`${serializeEnvLine("K", value)}\nNEXT=1\n`)).toEqual({ K: value, NEXT: "1" });
    });
  }
  it("throws for a carriage return it cannot escape", () => {
    expect(() => serializeEnvValue('cr\r and "quote"')).toThrow(/Cannot represent/);
    expect(() => serializeEnvValue("cr\r and back\\slash")).toThrow(/Cannot represent/);
  });
});

describe("a value ending in a backslash", () => {
  it("does not swallow the next quoted value", () => {
    // Was written as WHOOP_PASSWORD='hunter2\' and read back as
    // { WHOOP_PASSWORD: "hunter2\\'\nAUTH_PASSWORD=" } with AUTH_PASSWORD gone.
    upsertEnvFile(envPath, { WHOOP_PASSWORD: "hunter2\\", AUTH_PASSWORD: "#secret" });
    expect(readEnvFile(envPath)).toEqual({ WHOOP_PASSWORD: "hunter2\\", AUTH_PASSWORD: "#secret" });
  });

  it("round-trips next to every kind of quoted neighbour", () => {
    const neighbours = ["#hash", " padded ", "it's", 'say "hi"', "a'b\"c", "multi\nline", ""];
    for (const value of ["pw\\", "\\", "a\\\\", "C:\\dir\\"]) {
      for (const neighbour of neighbours) {
        rmSync(envPath, { force: true });
        upsertEnvFile(envPath, { BEFORE: neighbour, K: value, AFTER: neighbour });
        expect(readEnvFile(envPath), JSON.stringify([value, neighbour])).toEqual({ BEFORE: neighbour, K: value, AFTER: neighbour });
      }
    }
  });

  it("refuses, leaving the file untouched, when the value must be quoted and would swallow a neighbour", () => {
    writeFileSync(envPath, "AUTH_PASSWORD='#secret'\n");
    // `#` forces quotes and the trailing backslash escapes the closing one.
    expect(() => upsertEnvFile(envPath, { WHOOP_PASSWORD: "#pw\\" })).not.toThrow(); // appended after: nothing follows it
    expect(readEnvFile(envPath)).toEqual({ AUTH_PASSWORD: "#secret", WHOOP_PASSWORD: "#pw\\" });

    const before = "WHOOP_PASSWORD=old\nAUTH_PASSWORD='#secret'\n";
    writeFileSync(envPath, before);
    expect(() => upsertEnvFile(envPath, { WHOOP_PASSWORD: "#pw\\" })).toThrow(/would not read back intact/);
    expect(readFileSync(envPath, "utf8")).toBe(before);
  });

  it("repairs a file an older version already wrote this way", () => {
    // On disk from before the fix: the password swallowed the next line.
    writeFileSync(envPath, "WHOOP_PASSWORD='hunter2\\'\nAUTH_PASSWORD='#secret'\nOTHER=1\n");
    expect(readEnvFile(envPath).AUTH_PASSWORD).toBeUndefined();
    // An unrelated write (a token refresh) must still go through…
    upsertEnvFile(envPath, { WHOOP_IOS_BEARER_TOKEN: "eyJ.abc" });
    expect(readEnvFile(envPath)).toMatchObject({ WHOOP_IOS_BEARER_TOKEN: "eyJ.abc", OTHER: "1" });
    // …and re-saving the password brings the swallowed key back.
    upsertEnvFile(envPath, { WHOOP_PASSWORD: "hunter2\\" });
    expect(readEnvFile(envPath)).toEqual({ WHOOP_PASSWORD: "hunter2\\", AUTH_PASSWORD: "#secret", OTHER: "1", WHOOP_IOS_BEARER_TOKEN: "eyJ.abc" });
  });

  it("deleting the swallowing key also brings the swallowed one back", () => {
    writeFileSync(envPath, "WHOOP_PASSWORD='hunter2\\'\nAUTH_PASSWORD='#secret'\n");
    deleteEnvKeys(envPath, ["WHOOP_PASSWORD"]);
    expect(readEnvFile(envPath)).toEqual({ AUTH_PASSWORD: "#secret" });
  });

  it("never puts a secret's value in the refusal message", () => {
    writeFileSync(envPath, "WHOOP_PASSWORD=old\nAUTH_PASSWORD='#secret'\n");
    let message = "";
    try { upsertEnvFile(envPath, { WHOOP_PASSWORD: "#topsecret\\" }); } catch (error) { message = String(error); }
    expect(message).toMatch(/WHOOP_PASSWORD/);
    expect(message).not.toMatch(/topsecret|#secret/);
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

// The file is swapped in whole, never truncated and rewritten: a second totem
// process reading mid-write used to see an empty file (measured: ~1 read in 6
// while another process was rewriting it).
describe("the .env is replaced atomically", () => {
  const readAll = (fd: number): string => {
    const buffer = Buffer.alloc(4096);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  };

  it("a reader holding the old file still sees all of it, and the new file is complete", () => {
    const before = "WHOOP_EMAIL=a@b.com\nWHOOP_IOS_BEARER_TOKEN=old\n";
    writeFileSync(envPath, before);
    const fd = openSync(envPath, "r");
    try {
      upsertEnvFile(envPath, { WHOOP_IOS_BEARER_TOKEN: "new" });
      expect(readAll(fd)).toBe(before); // written in place, this handle read the new text (or none)
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(envPath, "utf8")).toBe("WHOOP_EMAIL=a@b.com\nWHOOP_IOS_BEARER_TOKEN=new\n");
  });

  it("does the same for deleteEnvKeys", () => {
    const before = "WHOOP_PASSWORD=pw\nWHOOP_EMAIL=a@b.com\n";
    writeFileSync(envPath, before);
    const fd = openSync(envPath, "r");
    try {
      deleteEnvKeys(envPath, ["WHOOP_PASSWORD"]);
      expect(readAll(fd)).toBe(before);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(envPath, "utf8")).toBe("WHOOP_EMAIL=a@b.com\n");
  });

  it("leaves no temp file behind and keeps the file 0600", () => {
    writeFileSync(envPath, "A=1\n", { mode: 0o644 });
    upsertEnvFile(envPath, { B: "2" });
    deleteEnvKeys(envPath, ["A"]);
    expect(readdirSync(dir)).toEqual([".env"]);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlinked .env and leaves the link in place", () => {
    const real = resolve(dir, "secrets.env");
    writeFileSync(real, "A=1\n");
    symlinkSync(real, envPath);
    upsertEnvFile(envPath, { B: "2" });
    expect(lstatSync(envPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("A=1\nB=2\n");
  });

  it("falls back to writing in place where a sibling file can't be created", () => {
    writeFileSync(envPath, "A=1\n");
    chmodSync(dir, 0o500); // e.g. a read-only config dir, or a single bind-mounted file
    try {
      upsertEnvFile(envPath, { B: "2" });
      expect(readEnvFile(envPath)).toEqual({ A: "1", B: "2" });
    } finally {
      chmodSync(dir, 0o700);
    }
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
