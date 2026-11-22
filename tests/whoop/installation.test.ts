import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInstallationId } from "../../src/whoop/installation.js";

const originalId = process.env.WHOOP_INSTALLATION_ID;
const originalEmail = process.env.WHOOP_EMAIL;
const dirs: string[] = [];

afterEach(() => {
  if (originalId === undefined) delete process.env.WHOOP_INSTALLATION_ID;
  else process.env.WHOOP_INSTALLATION_ID = originalId;
  if (originalEmail === undefined) delete process.env.WHOOP_EMAIL;
  else process.env.WHOOP_EMAIL = originalEmail;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveInstallationId", () => {
  it("replaces a blank env entry and reuses the persisted ID after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "totem-installation-"));
    dirs.push(dir);
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "WHOOP_INSTALLATION_ID=\nWHOOP_EMAIL=test@example.com\n");
    delete process.env.WHOOP_INSTALLATION_ID;
    process.env.WHOOP_EMAIL = "test@example.com";

    const first = resolveInstallationId(envPath);
    expect(readFileSync(envPath, "utf8")).toContain(`WHOOP_INSTALLATION_ID=${first}`);
    delete process.env.WHOOP_INSTALLATION_ID;
    const second = resolveInstallationId(envPath);
    expect(second).toBe(first);
  });

  it("deduplicates blank installation-ID entries while persisting", () => {
    const dir = mkdtempSync(join(tmpdir(), "totem-installation-"));
    dirs.push(dir);
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "WHOOP_INSTALLATION_ID=\nWHOOP_INSTALLATION_ID=\n");
    delete process.env.WHOOP_INSTALLATION_ID;
    process.env.WHOOP_EMAIL = "test@example.com";
    const id = resolveInstallationId(envPath);
    const idLines = readFileSync(envPath, "utf8").split("\n").filter((line) => line.startsWith("WHOOP_INSTALLATION_ID="));
    expect(idLines).toEqual([`WHOOP_INSTALLATION_ID=${id}`]);
  });

  // It used its own writer: truncate-and-rewrite in place (the tokens live in
  // this file too), a blank line before the entry and no newline after it.
  it("persists through the shared .env writer: whole-file swap, file shape kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "totem-installation-"));
    dirs.push(dir);
    const envPath = join(dir, ".env");
    const before = "WHOOP_EMAIL=test@example.com\nWHOOP_IOS_BEARER_TOKEN=tok\n";
    writeFileSync(envPath, before);
    delete process.env.WHOOP_INSTALLATION_ID;
    const fd = openSync(envPath, "r");
    try {
      const id = resolveInstallationId(envPath);
      const snapshot = Buffer.alloc(4096);
      // A reader that opened the file before the write still sees all of the old file.
      expect(snapshot.subarray(0, readSync(fd, snapshot, 0, snapshot.length, 0)).toString("utf8")).toBe(before);
      expect(readFileSync(envPath, "utf8")).toBe(`${before}WHOOP_INSTALLATION_ID=${id}\n`);
    } finally {
      closeSync(fd);
    }
    expect(readdirSync(dir)).toEqual([".env"]);
  });

  it("reads a quoted persisted id the way dotenv does", () => {
    const dir = mkdtempSync(join(tmpdir(), "totem-installation-"));
    dirs.push(dir);
    const envPath = join(dir, ".env");
    writeFileSync(envPath, 'export WHOOP_INSTALLATION_ID="ABCDEF12-0000-4000-8000-000000000001" # mine\n');
    delete process.env.WHOOP_INSTALLATION_ID;
    expect(resolveInstallationId(envPath)).toBe("ABCDEF12-0000-4000-8000-000000000001");
  });
});
