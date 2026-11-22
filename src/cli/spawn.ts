// Cross-platform spawn helpers.
//
// Windows: npm, npx, gcloud, railway (npm -g installs) are `.cmd` shims. Node
// can't spawn them directly — no shell means ENOENT (CreateProcess only tries
// .com/.exe), and naming the .cmd explicitly is rejected with EINVAL since the
// CVE-2024-27980 fix. So a .cmd/.bat found on PATH is run through
// `cmd.exe /d /s /c "<line>"` with every argument quoted + ^-escaped (the same
// rules cross-spawn uses), keeping args out of cmd's metacharacter handling.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SpawnOptions, SpawnSyncOptions } from "node:child_process";

type Env = NodeJS.ProcessEnv;
const envGet = (env: Env, key: string): string | undefined => {
  const k = Object.keys(env).find((x) => x.toUpperCase() === key);
  return k ? env[k] : undefined;
};

// First PATH × PATHEXT match for a bare command name (Windows lookup order).
export function findOnPath(cmd: string, env: Env = process.env): string | null {
  const dirs = (envGet(env, "PATH") ?? "").split(";").map((d) => d.replace(/"/g, "").trim()).filter(Boolean);
  const exts = (envGet(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, cmd + e);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// Only ever used for .cmd/.bat targets, and those shims hand %* to another
// program, so cmd parses the line twice: escape metacharacters twice, like
// cross-spawn does for npm-style shims. One level lets `"&cmd` inject a command.
export function quoteCmdArg(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

// Map (cmd, args, opts) to what to actually spawn. A no-op off Windows, with
// `shell` set, or when the command resolves to a real executable.
export function spawnArgs<O extends SpawnOptions | SpawnSyncOptions>(
  cmd: string,
  args: string[],
  opts: O,
  platform: NodeJS.Platform = process.platform,
): [string, string[], O] {
  if (platform !== "win32" || opts.shell) return [cmd, args, opts];
  const full = /[\\/]/.test(cmd) || extname(cmd) ? cmd : findOnPath(cmd, opts.env ?? process.env);
  if (!full || !/\.(cmd|bat)$/i.test(full)) return [cmd, args, opts];
  const line = [full.replace(CMD_META, "^$1"), ...args.map(quoteCmdArg)].join(" ");
  return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true }];
}

// Absolute path to a dependency's JS bin entry (from its package.json "bin"),
// to run with process.execPath. node_modules/.bin/* are sh/cmd shims, which
// can't be spawned directly on Windows or run by node. Null if not installed.
export function pkgBin(root: string, pkg: string, bin: string = pkg): string | null {
  try {
    const pkgJson = createRequire(resolve(root, "package.json")).resolve(`${pkg}/package.json`);
    const field = (JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> }).bin;
    const rel = typeof field === "string" ? field : field?.[bin];
    if (!rel) return null;
    const p = resolve(dirname(pkgJson), rel);
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// Per-OS user config root used by Electron apps (Claude Desktop, VS Code).
export function appConfigDir(platform: NodeJS.Platform = process.platform, home: string = homedir(), env: Env = process.env): string {
  if (platform === "win32") return env.APPDATA || join(home, "AppData", "Roaming");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  return join(home, ".config");
}

export function claudeDesktopConfigPath(platform: NodeJS.Platform = process.platform, home: string = homedir(), env: Env = process.env): string {
  return join(appConfigDir(platform, home, env), "Claude", "claude_desktop_config.json");
}

export function vscodeUserMcpPath(platform: NodeJS.Platform = process.platform, home: string = homedir(), env: Env = process.env): string {
  return join(appConfigDir(platform, home, env), "Code", "User", "mcp.json");
}
