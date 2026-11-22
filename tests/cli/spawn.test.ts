import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnArgs, quoteCmdArg, pkgBin, appConfigDir, claudeDesktopConfigPath, vscodeUserMcpPath } from "../../src/cli/spawn.js";
import { exec } from "../../src/cli/sys.js";

const root = resolve(import.meta.dirname, "..", "..");
const isWin = process.platform === "win32";

describe("pkgBin", () => {
  it("resolves dependency JS bin entries from package.json", () => {
    expect(pkgBin(root, "typescript", "tsc")).toMatch(/typescript[\\/]bin[\\/]tsc$/);
    expect(pkgBin(root, "vitest")).toMatch(/vitest[\\/]vitest\.mjs$/);
    expect(pkgBin(root, "tsx")).toMatch(/tsx[\\/]dist[\\/]cli\.mjs$/);
  });
  it("returns null for a missing package or bin", () => {
    expect(pkgBin(root, "definitely-not-installed-pkg")).toBeNull();
    expect(pkgBin(root, "typescript", "nope")).toBeNull();
  });
  it("the tsc entry runs under node", async () => {
    const r = await exec(process.execPath, [pkgBin(root, "typescript", "tsc")!, "--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Version \d+\./);
  });
});

describe("spawnArgs", () => {
  it("is a no-op off Windows", () => {
    expect(spawnArgs("npm", ["install"], {}, "linux")).toEqual(["npm", ["install"], {}]);
  });
  it("is a no-op with shell set", () => {
    expect(spawnArgs("npm", ["i"], { shell: true }, "win32")).toEqual(["npm", ["i"], { shell: true }]);
  });
  it("wraps a .cmd found on PATH in cmd.exe with quoted args; leaves .exe alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "totem-spawn-"));
    try {
      writeFileSync(join(dir, "fake.CMD"), "@echo off\r\n");
      writeFileSync(join(dir, "real.EXE"), "");
      const env = { Path: dir, PATHEXT: ".EXE;.CMD" };
      const [cmd, args, opts] = spawnArgs("fake", ["a b", "x&y"], { env }, "win32");
      expect(cmd.toLowerCase()).toMatch(/cmd(\.exe)?$/);
      expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(args[3]!.toLowerCase()).toContain("fake.cmd");
      expect(args[3]).toContain('^^^"a^^^ b^^^"');
      expect(opts.windowsVerbatimArguments).toBe(true);
      expect(spawnArgs("real", ["x"], { env }, "win32")).toEqual(["real", ["x"], { env }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("quoteCmdArg double-escapes cmd metacharacters for .cmd shims", () => {
    expect(quoteCmdArg("plain")).toBe('^^^"plain^^^"');
    expect(quoteCmdArg("dir\\")).toBe('^^^"dir\\\\^^^"');
    expect(quoteCmdArg("a&b|c")).toBe('^^^"a^^^&b^^^|c^^^"');
  });
});

describe.runIf(isWin)("Windows .cmd shims via exec()", () => {
  it("runs npm (a .cmd shim) without a shell", async () => {
    const r = await exec("npm", ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("passes tricky args through a .cmd unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "totem-spawn-"));
    try {
      const script = join(dir, "argv.js");
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
      writeFileSync(join(dir, "echoargs.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      const tricky = ["a b", "--format=value(account)", "x&y", "100%", "k=v,w=z", "a^b", "<in>", "trail\\", "", 'pw"&echo INJECTED&"x', 'q"uote', "pct%PATH%", "bang!x", 'say "hi"'];
      const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      const env = { ...process.env, [pathKey]: `${dir};${process.env[pathKey] ?? ""}` };
      const r = await exec("echoargs", tricky, { env });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(tricky);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("client config paths", () => {
  const home = "/home/u";
  it("Claude Desktop: %APPDATA% on Windows, Library on macOS, ~/.config on Linux", () => {
    expect(claudeDesktopConfigPath("win32", "C:\\Users\\u", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }))
      .toBe(join("C:\\Users\\u\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
    expect(claudeDesktopConfigPath("darwin", home, {})).toBe(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    expect(claudeDesktopConfigPath("linux", home, {})).toBe(join(home, ".config", "Claude", "claude_desktop_config.json"));
  });
  it("VS Code user mcp.json follows the same roots", () => {
    expect(vscodeUserMcpPath("win32", "C:\\Users\\u", { APPDATA: "D:\\roam" })).toBe(join("D:\\roam", "Code", "User", "mcp.json"));
    expect(vscodeUserMcpPath("darwin", home, {})).toBe(join(home, "Library", "Application Support", "Code", "User", "mcp.json"));
    expect(vscodeUserMcpPath("linux", home, {})).toBe(join(home, ".config", "Code", "User", "mcp.json"));
  });
  it("never falls back to a literal ~", () => {
    expect(appConfigDir("win32", "C:\\Users\\u", {})).toBe(join("C:\\Users\\u", "AppData", "Roaming"));
    expect(appConfigDir().startsWith("~")).toBe(false);
  });
});
