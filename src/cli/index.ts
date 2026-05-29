#!/usr/bin/env node
// whoop-mcp CLI — the single entry point for everything (build/dev/test/auth/
// deploy/inspect); package.json has no `scripts`. Runs from anywhere on the
// system (after `npm link` or global install).
//
// Architecture:
//   - Single-file CLI dispatcher.
//   - `ROOT` is the package root, resolved from `import.meta.url` so the CLI
//     always operates on its install dir regardless of cwd.
//   - Commands that wrap dev tooling spawn the local node_modules/.bin binaries
//     (tsx, vitest, tsc) so a `npm link`-ed install picks up the right versions.
//   - Commands that wrap Fly assume `fly` is on the system PATH.
//   - Banner uses 24-bit truecolor ANSI escapes (RGB); honors NO_COLOR and
//     skips colors if stdout is not a TTY.

import { spawn, type SpawnOptions } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import { runCloudSetup, runLocalSetup } from "./setup.js";

// ── locate package root ──────────────────────────────────────────────────
// This file lives at one of:
//   <root>/dist/cli/index.js    (compiled, normal install)
//   <root>/src/cli/index.ts     (dev, via tsx)
// Both are 2 dirs deep from the package root.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const PKG_PATH = resolve(ROOT, "package.json");
const PKG = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
  name: string;
  version: string;
};
const VERSION = PKG.version;

// ── color helpers ────────────────────────────────────────────────────────
// Whoop branding is mono (black/white). Banner uses a light-gray block text
// and a slightly dimmer gray for the pulse waveform. Truecolor (24-bit) —
// supported by every modern terminal (Terminal.app, iTerm2, Warp, kitty,
// alacritty, VS Code integrated terminal). Red/green retained for status
// semantics (✓ / ✗).
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  brand: "\x1b[38;2;225;225;225m",     // light gray — block text + accents
  brandDim: "\x1b[38;2;150;150;150m",  // medium gray — pulse waveform
  gray: "\x1b[38;2;120;120;120m",
  white: "\x1b[97m",
  green: "\x1b[92m",
  red: "\x1b[91m",
};
function wrap(code: string, s: string): string {
  return useColor ? `${code}${s}${ANSI.reset}` : s;
}
const c = {
  brand: (s: string) => wrap(ANSI.brand, s),
  brandDim: (s: string) => wrap(ANSI.brandDim, s),
  gray: (s: string) => wrap(ANSI.gray, s),
  white: (s: string) => wrap(ANSI.white, s),
  green: (s: string) => wrap(ANSI.green, s),
  red: (s: string) => wrap(ANSI.red, s),
  bold: (s: string) => wrap(ANSI.bold, s),
  dim: (s: string) => wrap(ANSI.dim, s),
};

// ── banner ───────────────────────────────────────────────────────────────
function printBanner(): void {
  const lines = [
    "",
    c.brand("   ██╗    ██╗██╗  ██╗ ██████╗  ██████╗ ██████╗     ███╗   ███╗ ██████╗██████╗ "),
    c.brand("   ██║    ██║██║  ██║██╔═══██╗██╔═══██╗██╔══██╗    ████╗ ████║██╔════╝██╔══██╗"),
    c.brand("   ██║ █╗ ██║███████║██║   ██║██║   ██║██████╔╝    ██╔████╔██║██║     ██████╔╝"),
    c.brand("   ██║███╗██║██╔══██║██║   ██║██║   ██║██╔═══╝     ██║╚██╔╝██║██║     ██╔═══╝ "),
    c.brand("   ╚███╔███╔╝██║  ██║╚██████╔╝╚██████╔╝██║         ██║ ╚═╝ ██║╚██████╗██║     "),
    c.brand("    ╚══╝╚══╝ ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝         ╚═╝     ╚═╝ ╚═════╝╚═╝     "),
    "",
    c.brandDim("   ▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁▁▁▁▁▁▂▂▆▂▁▁▁"),
    "",
    `   ${c.bold("v" + VERSION)}  ${c.gray("·")}  ${c.white("47 MCP tools")}  ${c.gray("·")}  ${c.white("47 microservices")}  ${c.gray("·")}  ${c.white("remote-ready")}`,
    "",
  ];
  for (const line of lines) console.log(line);
}

function compactHeader(): void {
  console.log(`${c.brand("⚡")} ${c.bold("whoop-mcp")} ${c.gray("v" + VERSION)}`);
}

// ── command registry ─────────────────────────────────────────────────────
interface Cmd {
  group: "Get started" | "Local" | "Setup" | "Deployed" | "Inspect" | "Help";
  desc: string;
  usage?: string;
  run: (args: string[]) => Promise<number>;
}

const GROUP_ORDER: Cmd["group"][] = ["Get started", "Setup", "Deployed", "Local", "Inspect", "Help"];

const commands: Record<string, Cmd> = {
  // ── Get started (headline) ─────────────────────────────────────────────
  cloud: {
    group: "Get started",
    desc: "★ Recommended. Guided deploy to a host (Fly/Railway/Koyeb/Cloud Run/custom) + connect to Claude web/mobile via OAuth, in one command.",
    run: async () => runCloudSetup(ROOT),
  },
  local: {
    group: "Get started",
    desc: "Guided setup to run the MCP on this machine (stdio) and wire it into Claude Desktop / Claude Code.",
    run: async () => runLocalSetup(ROOT),
  },

  // ── Local ────────────────────────────────────────────────────────────
  start: {
    group: "Local",
    desc: "Start the MCP server (stdio by default; --http for HTTP mode)",
    usage: "whoop-mcp start [--http]",
    run: async (args) => {
      const isHttp = args.includes("--http");
      const serverJs = resolve(ROOT, "dist", "server.js");
      if (!existsSync(serverJs)) {
        console.error(c.red("dist/server.js not found.") + " Run " + c.bold("whoop-mcp build") + " first.");
        return 1;
      }
      const env = { ...process.env, MCP_TRANSPORT: isHttp ? "http" : "stdio" };
      return run(process.execPath, [serverJs], { env });
    },
  },
  dev: {
    group: "Local",
    desc: "Run the server in dev mode (tsx, stdio, no build needed)",
    run: async () => run(npmBin("tsx"), [resolve(ROOT, "src", "server.ts")]),
  },
  "dev:http": {
    group: "Local",
    desc: "Run the server in dev mode (tsx, HTTP)",
    run: async () => {
      const env = { ...process.env, MCP_TRANSPORT: "http" };
      return run(npmBin("tsx"), [resolve(ROOT, "src", "server.ts")], { env });
    },
  },
  build: {
    group: "Local",
    desc: "Compile TypeScript to dist/",
    run: async () => run(npmBin("tsc"), []),
  },
  test: {
    group: "Local",
    desc: "Run the test suite (vitest)",
    usage: "whoop-mcp test [test-filter]",
    run: async (args) => run(npmBin("vitest"), ["run", ...args]),
  },
  typecheck: {
    group: "Local",
    desc: "Run `tsc --noEmit`",
    run: async () => run(npmBin("tsc"), ["--noEmit"]),
  },

  // ── Setup ────────────────────────────────────────────────────────────
  auth: {
    group: "Setup",
    desc: "First-time Whoop (Cognito) login — writes tokens to .env",
    run: async () => run(npmBin("tsx"), [resolve(ROOT, "src", "scripts", "cognito_bootstrap.ts")]),
  },
  refresh: {
    group: "Setup",
    desc: "Re-auth when the ~30-day token expires (auto if no SMS MFA; prompts if your account has it) + push to your deployment",
    usage: "whoop-mcp refresh [--app <fly-app>]",
    run: async (args) =>
      run(npmBin("tsx"), [resolve(ROOT, "src", "scripts", "rebootstrap.ts"), ...args]),
  },

  // ── Deployed ─────────────────────────────────────────────────────────
  deploy: {
    group: "Deployed",
    desc: "Deploy to Fly.io (`fly deploy` from the package root)",
    usage: "whoop-mcp deploy [-- <fly args>]",
    run: async (args) => run("fly", ["deploy", ...args]),
  },
  logs: {
    group: "Deployed",
    desc: "Tail Fly logs",
    usage: "whoop-mcp logs [-- <fly args>]",
    run: async (args) => {
      const app = detectFlyApp();
      const flyArgs = ["logs", ...(app ? ["-a", app] : []), ...args];
      return run("fly", flyArgs);
    },
  },
  status: {
    group: "Deployed",
    desc: "Show Fly status + ping /health",
    run: async () => {
      const app = detectFlyApp();
      if (!app) {
        console.error(c.red("No Fly app detected (no fly.toml, no $FLY_APP)."));
        return 1;
      }
      console.log(c.gray(`→ fly status -a ${app}`));
      await run("fly", ["status", "-a", app]);
      console.log("");
      console.log(c.gray(`→ GET https://${app}.fly.dev/health`));
      return ping(`https://${app}.fly.dev/health`);
    },
  },
  ping: {
    group: "Deployed",
    desc: "GET /health on your deployed Fly app",
    run: async () => {
      const app = detectFlyApp();
      if (!app) {
        console.error(c.red("No Fly app detected."));
        return 1;
      }
      return ping(`https://${app}.fly.dev/health`);
    },
  },

  // ── Inspect ──────────────────────────────────────────────────────────
  info: {
    group: "Inspect",
    desc: "Show install path, version, env state, Fly app",
    run: async () => {
      const app = detectFlyApp();
      const envExists = existsSync(resolve(ROOT, ".env"));
      const flyTomlExists = existsSync(resolve(ROOT, "fly.toml"));
      const built = existsSync(resolve(ROOT, "dist", "server.js"));
      console.log(`${c.bold("whoop-mcp")}  ${c.gray("v" + VERSION)}`);
      console.log("");
      const row = (label: string, value: string) =>
        console.log(`  ${c.gray(label.padEnd(15))} ${value}`);
      row("install root", ROOT);
      row("node", process.version);
      row("built (dist/)", built ? c.green("yes") : c.red("no — run `whoop-mcp build`"));
      row(".env", envExists ? c.green("present") : c.red("missing"));
      row("fly.toml", flyTomlExists ? c.green("present") : c.gray("not in repo"));
      row("fly app", app ? c.green(app) : c.gray("(none detected)"));
      if (app) {
        row("deployed url", `https://${app}.fly.dev`);
        row("health probe", `https://${app}.fly.dev/health`);
        row("mcp endpoint", `https://${app}.fly.dev/mcp`);
      }
      return 0;
    },
  },
  tools: {
    group: "Inspect",
    desc: "List the MCP tools the server exposes (48 total)",
    run: async () => {
      const reads = [
        "whoop_today", "whoop_day", "whoop_profile", "whoop_calendar", "whoop_recovery",
        "whoop_sleep", "whoop_strain", "whoop_trend", "whoop_compare", "whoop_stress",
        "whoop_sleep_need", "whoop_live_hr", "whoop_live_state", "whoop_live_stress",
        "whoop_workouts", "whoop_workout", "whoop_sports_catalog", "whoop_lift_prs",
        "whoop_lift_exercise", "whoop_lift_progression", "whoop_lift_history",
        "whoop_lift_library", "whoop_lift_catalog", "whoop_journal", "whoop_journal_catalog",
        "whoop_behavior_impact", "whoop_cycle", "whoop_performance_assessment",
        "whoop_smart_alarm", "whoop_leaderboard", "whoop_communities", "whoop_hr_zones",
      ];
      const writes = [
        "whoop_activity_create", "whoop_activity_delete", "whoop_lift_log",
        "whoop_lift_template_save", "whoop_lift_custom_exercise", "whoop_journal_log",
        "whoop_journal_autopop", "whoop_cycle_log", "whoop_symptom_log",
        "whoop_smart_alarm_set", "whoop_hr_zones_set", "whoop_profile_update",
        "whoop_hidden_metric", "whoop_coach_ask",
      ];
      const raw = ["whoop_raw", "whoop_endpoints"];

      console.log(`${c.bold("Reads")} ${c.gray("(" + reads.length + ")")}`);
      for (const t of reads) console.log(`  ${c.green("●")} ${t}`);
      console.log("");
      console.log(`${c.bold("Writes")} ${c.gray("(" + writes.length + " — preview-first; confirm=false default)")}`);
      for (const t of writes) console.log(`  ${c.brand("●")} ${t}`);
      console.log("");
      console.log(`${c.bold("Escape hatches")} ${c.gray("(" + raw.length + ")")}`);
      for (const t of raw) console.log(`  ${c.gray("●")} ${t}`);
      console.log("");
      console.log(c.gray(`total: ${reads.length + writes.length + raw.length}`));
      return 0;
    },
  },
  config: {
    group: "Inspect",
    desc: "Print a Claude Desktop config snippet",
    usage: "whoop-mcp config <stdio|http>",
    run: async (args) => {
      const mode = args[0];
      if (mode !== "stdio" && mode !== "http") {
        console.log(c.bold("Pick a mode:"));
        console.log("  " + c.brand("whoop-mcp config stdio") + c.gray("   # local install"));
        console.log("  " + c.brand("whoop-mcp config http") + c.gray("    # remote deployment (uses mcp-remote bridge)"));
        return 1;
      }
      const home = process.env.HOME ?? "~";
      const cfgPath = resolve(home, "Library/Application Support/Claude/claude_desktop_config.json");
      console.log(c.gray(`Edit:  ${cfgPath}`));
      console.log("");
      if (mode === "stdio") {
        console.log(JSON.stringify({
          mcpServers: {
            whoop: {
              command: process.execPath,
              args: [resolve(ROOT, "dist", "server.js")],
            },
          },
        }, null, 2));
      } else {
        // Claude Desktop doesn't natively support remote MCP — bridge via npx mcp-remote.
        const app = detectFlyApp();
        const url = app ? `https://${app}.fly.dev/mcp` : "https://YOUR-APP.fly.dev/mcp";
        console.log(JSON.stringify({
          mcpServers: {
            whoop: {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                url,
                "--header",
                "Authorization:Bearer YOUR_MCP_AUTH_TOKEN",
              ],
            },
          },
        }, null, 2));
        console.log("");
        console.log(c.gray("Bridge: https://www.npmjs.com/package/mcp-remote"));
        console.log(c.gray("Claude Desktop only supports stdio — `mcp-remote` proxies your HTTP server through it."));
      }
      return 0;
    },
  },

  // ── Help ─────────────────────────────────────────────────────────────
  version: {
    group: "Help",
    desc: "Print the version string",
    run: async () => {
      console.log(VERSION);
      return 0;
    },
  },
  help: {
    group: "Help",
    desc: "Show this help",
    run: async () => {
      printHelp();
      return 0;
    },
  },
};

// Aliases — helpful shortcuts.
const aliases: Record<string, string> = {
  "-h": "help",
  "--help": "help",
  "-v": "version",
  "--version": "version",
};

// ── helpers ──────────────────────────────────────────────────────────────
function npmBin(name: string): string {
  const path = resolve(ROOT, "node_modules", ".bin", name);
  if (!existsSync(path)) {
    console.error(c.red(`Missing dev dependency: ${name}`));
    console.error(c.gray(`Expected at: ${path}`));
    console.error(c.gray(`Run `) + c.bold(`cd ${ROOT} && npm install`) + c.gray(` first.`));
    process.exit(1);
  }
  return path;
}

function detectFlyApp(): string | null {
  if (process.env.FLY_APP) return process.env.FLY_APP;
  const tomlPath = resolve(ROOT, "fly.toml");
  if (existsSync(tomlPath)) {
    const m = readFileSync(tomlPath, "utf8").match(/^app\s*=\s*['"]([^'"]+)['"]/m);
    if (m && m[1]) return m[1];
  }
  return null;
}

function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(c.red(`\nKilled by signal ${signal}`));
        res(128);
        return;
      }
      res(code ?? 1);
    });
    child.on("error", (err) => {
      console.error(c.red("Failed to spawn:"), err.message);
      res(1);
    });
  });
}

function ping(url: string, timeoutMs = 10_000): Promise<number> {
  return new Promise((res) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { "user-agent": `whoop-mcp/${VERSION}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          const label = ok ? c.green(`✓ ${status}`) : c.red(`✗ ${status}`);
          const preview = body.length > 120 ? body.slice(0, 117) + "..." : body;
          console.log(`${label}  ${url}  ${c.gray("→ " + preview.replace(/\s+/g, " ").trim())}`);
          res(ok ? 0 : 1);
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      console.error(c.red(`✗ timeout after ${timeoutMs}ms:`), url);
      res(1);
    });
    req.on("error", (err) => {
      console.error(c.red("✗ network error:"), err.message);
      res(1);
    });
    req.end();
  });
}

function printHelp(): void {
  console.log(`${c.bold("Usage:")} whoop-mcp ${c.gray("<command>")} ${c.gray("[args]")}`);
  console.log("");
  const byGroup: Record<string, [string, Cmd][]> = {};
  for (const [name, cmd] of Object.entries(commands)) {
    byGroup[cmd.group] ??= [];
    byGroup[cmd.group]!.push([name, cmd]);
  }
  for (const group of GROUP_ORDER) {
    const list = byGroup[group];
    if (!list || list.length === 0) continue;
    console.log(c.bold(group));
    const longest = Math.max(...list.map(([n]) => n.length));
    for (const [name, cmd] of list) {
      const padded = name.padEnd(longest + 2);
      console.log(`  ${c.brand(padded)}${c.white(cmd.desc)}`);
      if (cmd.usage) {
        console.log(`  ${" ".repeat(longest + 2)}${c.gray(cmd.usage)}`);
      }
    }
    console.log("");
  }
  console.log(c.gray("Global flags:"));
  console.log(c.gray("  --help, -h     Show this help"));
  console.log(c.gray("  --version, -v  Show version"));
  console.log(c.gray("  NO_COLOR=1     Disable ANSI colors"));
  console.log("");
  console.log(c.gray("First-time global install (from a clone of this repo):"));
  console.log(c.gray("  cd ") + c.bold(ROOT));
  console.log(c.gray("  npm install && npx tsc && npm link"));
  console.log("");
  console.log(c.gray("Repo: ") + c.white(PKG.name) + c.gray(" · ") + ROOT);
  console.log("");
}

// ── main ─────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printBanner();
    printHelp();
    return 0;
  }

  let name = argv[0]!;
  if (name in aliases) name = aliases[name]!;

  const cmd = commands[name];
  if (!cmd) {
    console.error(`${c.red("Unknown command:")} ${name}`);
    console.error("");
    console.error(`Run ${c.bold("whoop-mcp help")} to see all commands.`);
    return 1;
  }

  // `start` must keep stdout clean for the MCP protocol.
  // `version` is meant to be parsed by tools (just print the number).
  if (name !== "start" && name !== "version") compactHeader();

  return cmd.run(argv.slice(1));
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(c.red("Fatal:"), err instanceof Error ? err.stack : err);
  process.exit(1);
});
