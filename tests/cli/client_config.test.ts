// `totem local` writes its server into another app's config file. That file is
// the user's: totem may add its own entry, and nothing else.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigNotMergeableError, mergeJsonConfig } from "../../src/cli/clients.js";

const ENTRY = { command: "/usr/local/bin/node", args: ["/opt/totem/dist/server.js"] };

describe("mergeJsonConfig", () => {
  let dir = "";
  let file = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "totem-config-"));
    file = join(dir, "nested", "mcp.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (text: string): void => {
    file = join(dir, "mcp.json");
    writeFileSync(file, text);
  };
  const read = (): Record<string, any> => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

  it("creates the file (and its directory) when there is none", () => {
    expect(mergeJsonConfig(file, "mcpServers", "whoop", ENTRY)).toEqual({ changed: true });
    expect(read()).toEqual({ mcpServers: { whoop: ENTRY } });
    expect(existsSync(`${file}.totem-backup`)).toBe(false);
  });

  it("adds its entry next to the user's servers and settings, and keeps a backup", () => {
    const before = JSON.stringify({ theme: "dark", mcpServers: { github: { command: "gh-mcp" }, whoop: { command: "old" } } }, null, 2);
    put(before);
    expect(mergeJsonConfig(file, "mcpServers", "whoop", ENTRY)).toEqual({ changed: true, backup: `${file}.totem-backup` });
    expect(read()).toEqual({ theme: "dark", mcpServers: { github: { command: "gh-mcp" }, whoop: ENTRY } });
    expect(readFileSync(`${file}.totem-backup`, "utf8")).toBe(before);
  });

  it("treats an empty file as an empty config", () => {
    put("  \n");
    mergeJsonConfig(file, "servers", "whoop", ENTRY);
    expect(read()).toEqual({ servers: { whoop: ENTRY } });
  });

  it("changes nothing the second time", () => {
    mergeJsonConfig(file, "mcpServers", "whoop", ENTRY);
    const first = readFileSync(file, "utf8");
    expect(mergeJsonConfig(file, "mcpServers", "whoop", ENTRY)).toEqual({ changed: false });
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(existsSync(`${file}.totem-backup`)).toBe(false);
  });

  // The data-loss case: VS Code's mcp.json allows comments, and hand-edited
  // configs pick up trailing commas. Either used to be read as "empty" and
  // overwritten with a file holding only totem's entry.
  it.each([
    ["a comment", '{\n  // my servers\n  "servers": { "github": { "command": "gh-mcp" }, "linear": { "url": "https://x" } },\n  "inputs": []\n}\n'],
    ["a trailing comma", '{ "mcpServers": { "github": { "command": "gh-mcp" }, } }'],
    ["a truncated file", '{ "mcpServers": { "github": '],
  ])("refuses a config with %s and leaves it byte for byte", (_label, text) => {
    put(text);
    expect(() => mergeJsonConfig(file, "mcpServers", "whoop", ENTRY)).toThrow(ConfigNotMergeableError);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(existsSync(`${file}.totem-backup`)).toBe(false);
  });

  it.each([
    ["an array", "[1, 2]"],
    ["a string", '"hello"'],
    ["null", "null"],
  ])("refuses a config that is %s", (_label, text) => {
    put(text);
    expect(() => mergeJsonConfig(file, "mcpServers", "whoop", ENTRY)).toThrow(/doesn't hold a JSON object/);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("refuses when the servers key holds something that isn't an object", () => {
    const text = '{ "mcpServers": ["github"] }';
    put(text);
    expect(() => mergeJsonConfig(file, "mcpServers", "whoop", ENTRY)).toThrow(/isn't an object/);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("names the file in the reason it gives", () => {
    put("{ // x\n}");
    expect(() => mergeJsonConfig(file, "mcpServers", "whoop", ENTRY)).toThrow(file);
  });
});
