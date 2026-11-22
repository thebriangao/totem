// The `totem` command: the command table, help, and the short commands
// (status, ping, logs, deploy, tools, token, start, dev, build, test).
// The guided flows live in setup.ts, auth.ts and update.ts.
//
// `runCli(argv, ctx, io)` is the whole program as a function of its arguments,
// so tests can render any screen. index.ts is only the entry point.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { realAuthDeps, runAuth } from "./auth.js";
import { CLIENTS, tildify } from "./clients.js";
import { readDeployRecord } from "./deploy_record.js";
import { runCloudSetup, runConnect, runLocalSetup } from "./setup.js";
import { pkgBin } from "./spawn.js";
import { scriptCommand, type ExecResult, type Io } from "./sys.js";
import { resolveTokenFilePath } from "../whoop/token_store.js";
import { runUpdate } from "./update.js";
import { padEnd, when, wrap, type Fix, type Kit } from "./ui.js";

export interface AppCtx {
  /** The install directory (where package.json is). */
  root: string;
  version: string;
  pkgName: string;
  pkgPath: string;
  /** The running CLI entry file, for the auto-update scheduler. */
  cliEntry: string;
}

type Group = "Set up" | "Run and maintain" | "Develop";
const GROUPS: Group[] = ["Set up", "Run and maintain", "Develop"];

interface Command {
  group: Group;
  /** One line for the command table. */
  summary: string;
  usage: string;
  /** What it does, for `totem <command> --help`. */
  about: string;
  options?: Array<[flag: string, text: string]>;
  env?: Array<[name: string, text: string]>;
  examples?: string[];
  run(args: string[], app: AppCtx, io: Io): Promise<number>;
}

// ── where the server runs ───────────────────────────────────────────────────

export interface DeployInfo { platform: string; app?: string | undefined; url?: string | undefined; region?: string | undefined; project?: string | undefined; mcp_auth_token?: string | undefined }
const HOST_NAME: Record<string, string> = { fly: "Fly.io", railway: "Railway", cloudrun: "Google Cloud Run", custom: "your own server", local: "this computer" };
const cleanUrl = (u: string): string => u.replace(/\/+$/, "");

/**
 * Where the server is deployed: the `.totem-deploy.json` record written by
 * `totem cloud` / `totem local`, else (deploys older than the record) the Fly
 * app named by $FLY_APP or fly.toml.
 */
export function detectDeploy(root: string, env: Record<string, string | undefined>): DeployInfo | null {
  const record = readDeployRecord(root);
  if (record) return record;
  let app = env.FLY_APP || null;
  const toml = resolve(root, "fly.toml");
  if (!app && existsSync(toml)) app = readFileSync(toml, "utf8").match(/^app\s*=\s*['"]([^'"]+)['"]/m)?.[1] ?? null;
  return app ? { platform: "fly", app, url: `https://${app}.fly.dev` } : null;
}

const NOT_SET_UP: Fix[] = [["Run on this computer", "totem local"], ["Deploy a server", "totem cloud"]];

/** The deployment, or an explanation printed and null. */
function remoteDeploy(app: AppCtx, io: Io, what: string): DeployInfo | null {
  const d = detectDeploy(app.root, io.sys.env);
  if (d && d.platform !== "local") return d;
  if (d) io.ui.error(`${what} is for a deployed server. This install runs on this computer.`, { fix: [["Deploy a server", "totem cloud"]] });
  else io.ui.error("totem isn't set up yet.", { fix: NOT_SET_UP });
  return null;
}

// ── deploy / logs / status ──────────────────────────────────────────────────

const HOST_CLI: Record<string, { names: string[]; install: string }> = {
  fly: { names: ["fly", "flyctl"], install: "brew install flyctl" },
  railway: { names: ["railway"], install: "npm i -g @railway/cli" },
  cloudrun: { names: ["gcloud"], install: "brew install --cask google-cloud-sdk" },
};

/**
 * The host's CLI on this machine ("fly" or "flyctl", whichever is installed),
 * or an explanation printed and null. A server deployed from another machine
 * leaves this one without the CLI: say that, not "spawn fly ENOENT".
 */
function hostCli(io: Io, d: DeployInfo, command: string): string | null {
  const cli = HOST_CLI[d.platform];
  if (!cli) return null;
  const found = cli.names.find((n) => io.sys.has(n));
  if (found) return found;
  io.ui.error(`${command} needs the ${HOST_NAME[d.platform] ?? d.platform} CLI (${cli.names[0]}), which isn't installed on this machine.`, {
    fix: [["Install it", cli.install], ["Then", command]],
  });
  return null;
}

/** The host commands that deploy this install's code again, in order. `fly` is the Fly binary to use. */
export function deployCommands(d: DeployInfo, extra: string[] = [], fly = "fly"): Array<[cmd: string, args: string[]]> | null {
  switch (d.platform) {
    case "fly":
      return [[fly, ["deploy", ...(d.app ? ["-a", d.app] : []), ...extra]]];
    case "railway":
      return [...(d.app ? [["railway", ["link", "--project", d.app]] as [string, string[]]] : []), ["railway", ["up", ...extra]]];
    case "cloudrun":
      return [["gcloud", ["run", "deploy", d.app ?? "totem", "--source", ".", "--region", d.region ?? "us-west1", "--min-instances", "1",
        ...(d.project ? ["--project", d.project] : []), "--quiet", ...extra]]];
    default:
      return null;
  }
}

/** `totem deploy` with its output captured (for the updater). */
export async function redeployCaptured(app: AppCtx, io: Io, onLine: (line: string) => void): Promise<ExecResult> {
  const d = detectDeploy(app.root, io.sys.env);
  const fly = ["fly", "flyctl"].find((n) => io.sys.has(n)) ?? "fly";
  const commands = d ? deployCommands(d, [], fly) : null;
  if (!commands) return { code: 1, stdout: "", stderr: "no deployment that totem can deploy to" };
  let last: ExecResult = { code: 0, stdout: "", stderr: "" };
  for (const [cmd, args] of commands) {
    last = await io.sys.exec(cmd, args, { cwd: app.root, onLine });
    if (last.code !== 0) return last;
  }
  return last;
}

async function deploy(args: string[], app: AppCtx, io: Io): Promise<number> {
  const { ui, sys } = io;
  const d = remoteDeploy(app, io, "totem deploy");
  if (!d) return 1;
  const extra = args.filter((a) => a !== "--");
  if (!HOST_CLI[d.platform]) {
    ui.error("totem can't deploy to a self-hosted server from here.", {
      detail: "On its host: rebuild the image (docker build -t totem .) and start it again.",
    });
    return 1;
  }
  const cli = hostCli(io, d, "totem deploy");
  if (!cli) return 1;
  const commands = deployCommands(d, extra, cli)!;
  ui.header("totem deploy", `Deploy this install's code to ${HOST_NAME[d.platform] ?? d.platform}${d.app ? ` (${d.app})` : ""}.`);
  if (d.platform === "fly") {
    const toml = resolve(app.root, "fly.toml");
    if (existsSync(toml) && !/^\[mounts\]/m.test(readFileSync(toml, "utf8"))) {
      ui.warn("fly.toml has no [mounts]: the server keeps its WHOOP login on the machine's own disk and loses it on every restart.");
      ui.para("To keep it, create a volume and mount it, then deploy again:", 4);
      ui.code([`fly volumes create totem_data --app ${d.app ?? "<app>"} --size 1`, "", "[mounts]", '  source = "totem_data"', '  destination = "/data"']);
      ui.line();
    }
  }
  for (const [cmd, cmdArgs] of commands) {
    ui.hint(`$ ${cmd} ${cmdArgs.join(" ")}`, 2);
    const code = await sys.run(cmd, cmdArgs, { cwd: app.root });
    if (code !== 0) {
      ui.line();
      ui.error(`${cmd} ${cmdArgs[0]} failed (exit ${code}). The server is unchanged.`, { fix: [["Try again", "totem deploy"], ["Read the server's logs", "totem logs"]] });
      return code;
    }
  }
  ui.line();
  ui.ok("Deployed");
  ui.hint("Check it: totem status");
  return 0;
}

async function logs(args: string[], app: AppCtx, io: Io): Promise<number> {
  const { ui, sys } = io;
  const d = remoteDeploy(app, io, "totem logs");
  if (!d) return 1;
  const extra = args.filter((a) => a !== "--");
  if (!HOST_CLI[d.platform]) {
    ui.error("The logs of a self-hosted server are on its host.", { detail: "There: docker logs <container>" });
    return 1;
  }
  const cli = hostCli(io, d, "totem logs");
  if (!cli) return 1;
  switch (d.platform) {
    case "fly":
      return sys.run(cli, ["logs", ...(d.app ? ["-a", d.app] : []), ...extra], { cwd: app.root });
    case "railway":
      if (d.app) await sys.run("railway", ["link", "--project", d.app], { cwd: app.root });
      return sys.run("railway", ["logs", ...extra], { cwd: app.root });
    case "cloudrun":
      return sys.run("gcloud", ["run", "services", "logs", "read", d.app ?? "totem", "--region", d.region ?? "us-west1",
        ...(d.project ? ["--project", d.project] : []), ...extra], { cwd: app.root });
    default:
      return 1;
  }
}

/** One health check line. Returns whether the server answered. */
async function health(io: Io, url: string): Promise<boolean> {
  const { ui, sys } = io;
  const r = await ui.task(`Asking ${url}`, () => sys.httpGet(`${url}/health`, 10_000));
  if (r.status >= 200 && r.status < 300) {
    let build = "";
    try { build = String((JSON.parse(r.body) as { build?: unknown }).build ?? ""); } catch { /* not JSON */ }
    ui.ok("The server is up", `answered in ${r.ms} ms${build ? `, build ${build}` : ""}`);
    return true;
  }
  ui.fail("The server isn't answering", r.status ? `HTTP ${r.status} from /health` : r.error ?? "no answer");
  return false;
}

async function ping(_args: string[], app: AppCtx, io: Io): Promise<number> {
  const { ui } = io;
  const d = remoteDeploy(app, io, "totem ping");
  if (!d) return 1;
  if (!d.url) {
    ui.error("No address is recorded for the server.", { fix: [["Set it up again", "totem cloud"]] });
    return 1;
  }
  ui.header("totem ping");
  if (await health(io, cleanUrl(d.url))) return 0;
  ui.rows([["Read its logs", ui.kit.c.accent("totem logs")], ["The full picture", ui.kit.c.accent("totem status")]], 4);
  return 1;
}

async function status(args: string[], app: AppCtx, io: Io): Promise<number> {
  const { ui, sys } = io;
  const auth = io.auth ?? realAuthDeps;
  const d = detectDeploy(app.root, sys.env);
  ui.header("totem status");
  const rows: Array<[string, string]> = [["Version", app.version], ["Install", tildify(app.root, sys.home)]];
  if (!d) {
    ui.rows(rows);
    ui.line();
    ui.problem("totem isn't set up yet.", { fix: NOT_SET_UP });
    return 1;
  }
  const local = d.platform === "local";
  rows.push(["Runs on", local ? "this computer, started by your AI client" : `${HOST_NAME[d.platform] ?? d.platform}${d.app ? `, ${d.platform === "railway" ? "project" : d.platform === "cloudrun" ? "service" : "app"} ${d.app}` : ""}`]);
  if (d.url) rows.push(["Address", cleanUrl(d.url)]);
  ui.rows(rows);
  ui.line();

  if (local) {
    const built = existsSync(resolve(app.root, "dist", "server.js"));
    if (built) ui.ok("The server is built");
    else ui.problem("The server isn't built.", { fix: [["Build it", "totem build"]] });
    const login = auth.readLocalStatus(resolveTokenFilePath(auth.cliEnv(resolve(app.root, ".env"))));
    if (login.state === "tokens") ui.ok("WHOOP login saved", `${when(login.savedAt)}${login.refreshedAt ? `, refreshed ${when(login.refreshedAt)}` : ""}`);
    else ui.problem(login.state === "unreadable" ? "The WHOOP login file can't be read." : "There is no WHOOP login on this computer.", { fix: [["Log in", "totem auth"]] });
    return built && login.state === "tokens" ? 0 : 1;
  }

  if (args.includes("--host")) {
    // The host's own view, in its own words.
    const fly = ["fly", "flyctl"].find((n) => sys.has(n)) ?? "fly";
    const view: [string, string[]] | null = d.platform === "fly" && d.app ? [fly, ["status", "-a", d.app]]
      : d.platform === "railway" ? ["railway", ["status"]]
      : d.platform === "cloudrun" && d.app ? ["gcloud", ["run", "services", "describe", d.app, "--region", d.region ?? "us-west1", ...(d.project ? ["--project", d.project] : []), "--format=value(status.url,status.latestReadyRevisionName)"]]
      : null;
    if (view) {
      if (d.platform === "railway" && d.app) await sys.run("railway", ["link", "--project", d.app], { cwd: app.root });
      ui.hint(`$ ${view[0]} ${view[1].join(" ")}`, 2);
      await sys.run(view[0], view[1], { cwd: app.root });
      ui.line();
    }
  }
  if (!d.url) {
    ui.warn("No address is recorded for the server, so it can't be checked.");
    return 0;
  }
  const up = await health(io, cleanUrl(d.url));
  if (!up) {
    ui.rows([["Read its logs", ui.kit.c.accent("totem logs")], ...(d.platform === "custom" ? [] : [["Deploy it again", ui.kit.c.accent("totem deploy")] as [string, string]])], 4);
    return 1;
  }
  const token = d.mcp_auth_token;
  if (!token) {
    ui.info("WHOOP login: unknown from here", "totem has no MCP_AUTH_TOKEN recorded for this server");
    return 0;
  }
  const r = await ui.task("Asking about its WHOOP login", () => auth.fetchRemoteStatus(cleanUrl(d.url!), token));
  if (!r.ok) {
    ui.warn("Couldn't ask the server about its WHOOP login", r.detail || r.reason);
    return 0;
  }
  const s = r.status;
  if (s.state === "ok") ui.ok("The server has a WHOOP login", s.refreshed_at ? `refreshed ${when(s.refreshed_at)}` : undefined);
  else ui.problem(`The server's WHOOP login is ${s.state ?? "missing"}.`, { detail: s.detail, fix: [["Log in again", "totem auth"]] });
  if (s.durable === false) ui.warn("Its token file isn't on a volume", "a restart loses the login");
  return s.state === "ok" ? 0 : 1;
}

// ── tools ────────────────────────────────────────────────────────────────────

/** The tool names the server registers, read from the real registry. */
async function registeredTools(): Promise<{ read: string[]; write: string[] }> {
  const { READ_TOOLS, WRITE_TOOLS } = await import("../tools/register.js");
  const names = (registers: ReadonlyArray<(server: never, client: never) => void>): string[] => {
    const seen: string[] = [];
    const recorder = { registerTool: (name: string) => { seen.push(name); } };
    for (const register of registers) register(recorder as never, {} as never);
    return seen;
  };
  return { read: names(READ_TOOLS as never), write: names(WRITE_TOOLS as never) };
}

export function toolsScreen(k: Kit, tools: { read: string[]; write: string[] }): string[] {
  const total = tools.read.length + tools.write.length;
  const columnWidth = Math.max(...[...tools.read, ...tools.write].map((n) => n.length)) + 2;
  const columns = Math.max(1, Math.floor((k.style.width - 2) / columnWidth));
  const grid = (names: string[]): string[] => {
    const rows: string[] = [];
    for (let i = 0; i < names.length; i += columns) rows.push("  " + names.slice(i, i + columns).map((n) => padEnd(n, columnWidth)).join("").trimEnd());
    return rows;
  };
  return [
    ...k.header("totem tools", `${total} tools: ${tools.read.length} read your WHOOP data and ${tools.write.length} change it. A tool that changes something returns a preview and does nothing until the client confirms.`),
    k.c.bold(`Read (${tools.read.length})`),
    ...grid(tools.read),
    "",
    k.c.bold(`Write (${tools.write.length})`),
    ...grid(tools.write),
    "",
    ...k.hint("What each one does: TOOLS.md", 0),
  ];
}

// ── token ────────────────────────────────────────────────────────────────────

async function token(args: string[], app: AppCtx, io: Io): Promise<number> {
  const { ui, sys } = io;
  const d = remoteDeploy(app, io, "totem token");
  if (!d) return 1;
  if (!d.mcp_auth_token) {
    ui.error("totem has no MCP_AUTH_TOKEN recorded for this server.", {
      detail: "It is the MCP_AUTH_TOKEN secret on the host. totem records it the next time you log in.",
      fix: [["Log in and record it", "totem auth"]],
    });
    return 1;
  }
  // The token is the server's master key. On a terminal it would stay in the
  // scrollback, so it only prints into a pipe or a $(…) unless asked.
  if (sys.tty && !args.includes("--show")) {
    ui.error("totem token doesn't put the token on your screen.", {
      detail: "It is the server's master key. Use it inside a command, where it is never displayed:",
      fix: [["In a header", 'curl -H "Authorization: Bearer $(totem token)" <url>'], ["Show it anyway", "totem token --show"]],
    });
    return 1;
  }
  ui.line(d.mcp_auth_token);
  return 0;
}

// ── running the server and dev tools ─────────────────────────────────────────

async function devTool(app: AppCtx, io: Io, pkg: string, bin: string, args: string[]): Promise<number> {
  const path = pkgBin(app.root, pkg, bin);
  if (!path) {
    io.ui.error(`${pkg} isn't installed in this install.`, { detail: "It is a development dependency: a source checkout has it after npm install.", fix: [["Install", "npm install"]] });
    return 1;
  }
  return io.sys.run(io.sys.node, [path, ...args], { cwd: app.root });
}

const commands: Record<string, Command> = {
  cloud: {
    group: "Set up",
    summary: "Deploy your own server; connect claude.ai, ChatGPT and others",
    usage: "totem cloud [--verbose]",
    about: "Guides you through deploying totem to Fly.io, Railway, Google Cloud Run or your own Docker host: pick a host, confirm the plan, wait for the deploy, log in to WHOOP in a browser window, then connect your clients. Nothing is created before you confirm the plan.",
    options: [["--verbose", "Show the host CLI's full output instead of one progress line"]],
    examples: ["totem cloud"],
    run: (args, app, io) => runCloudSetup(app.root, io, { verbose: args.includes("--verbose") }),
  },
  local: {
    group: "Set up",
    summary: "Run on this computer; connect a desktop or terminal client",
    usage: "totem local",
    about: "Sets totem up on this computer: builds the server if needed, logs you in to WHOOP in a browser window, and adds totem to the client you pick (Claude Desktop, Claude Code, Cursor, Codex, OpenCode and more). The client starts the server itself; nothing is hosted.",
    examples: ["totem local"],
    run: (_args, app, io) => runLocalSetup(app.root, io),
  },
  connect: {
    group: "Set up",
    summary: "Connect another client, or show what to paste where",
    usage: "totem connect [client] [--print]",
    about: `With no client, shows how to connect every client to this install. With one, sets it up (a local install) or shows its steps (a deployed server). Clients: ${CLIENTS.map((c) => c.id).join(", ")}, other.`,
    options: [["--print", "Show what to add instead of writing the client's config"]],
    examples: ["totem connect", "totem connect cursor", "totem connect claude-code --print"],
    run: (args, app, io) => runConnect(app.root, args, io),
  },
  auth: {
    group: "Set up",
    summary: "Log in to WHOOP, in a browser window",
    usage: "totem auth [options]",
    about: "Opens a browser window on WHOOP's site, where you log in yourself; totem never sees your password. The login is saved on this computer, or sent to your deployed server, which keeps it fresh from then on.",
    options: [
      ["--status", "Show where the login lives and when it was last refreshed"],
      ["--paste", "Paste the whoop-auth-refresh-token cookie instead of using a browser"],
      ["--local", "Save on this computer even when a server is set up"],
      ["--url <url>", "Send the login to the totem server at <url>"],
      ["--allow-http", "Let --url be plain http (a private network you trust)"],
      ["--browser <path>", "Use this browser"],
    ],
    env: [
      ["TOTEM_TOKEN_FILE", "Where the login is kept on this computer"],
      ["TOTEM_BROWSER", "Path of the browser to use"],
      ["TOTEM_ADMIN_TOKEN", "The server's MCP_AUTH_TOKEN, when totem has none recorded"],
    ],
    examples: ["totem auth", "totem auth --status", "TOTEM_ADMIN_TOKEN=<token> totem auth --url https://totem.example.com"],
    run: (args, app, io) => runAuth(app.root, args, {}, io),
  },
  status: {
    group: "Run and maintain",
    summary: "Show how this install, its server and its login are doing",
    usage: "totem status [--host]",
    about: "Shows the version, where totem runs, whether the server answers, and whether it has a WHOOP login. Exits non-zero when something needs attention.",
    options: [["--host", "Also show the host's own view (on Fly: fly status)"]],
    run: status,
  },
  ping: {
    group: "Run and maintain",
    summary: "Check that the server answers",
    usage: "totem ping",
    about: "Requests /health from the deployed server and reports the answer.",
    run: ping,
  },
  logs: {
    group: "Run and maintain",
    summary: "Show the server's logs",
    usage: "totem logs [-- <host options>]",
    about: "Runs the host's log command for your server (fly logs, railway logs, gcloud run services logs read). Anything after -- goes to that command.",
    run: logs,
  },
  deploy: {
    group: "Run and maintain",
    summary: "Deploy this install's code to the server again",
    usage: "totem deploy [-- <host options>]",
    about: "Builds and deploys the code in this install to the server set up by totem cloud. Secrets and the WHOOP login stay as they are. Anything after -- goes to the host's deploy command.",
    run: deploy,
  },
  update: {
    group: "Run and maintain",
    summary: "Update totem; --check, --auto on|off",
    usage: "totem update [--check | --auto on|off]",
    about: "Installs a release: pick one (the newest is first), and totem installs it, rebuilds, deploys it to your server and checks the server answers. If a step fails it goes back to the version you had.",
    options: [
      ["--check", "Only show the installed and the latest version"],
      ["--auto on", "Install new releases automatically, checking every 6 hours"],
      ["--auto off", "Stop installing them automatically"],
    ],
    examples: ["totem update", "totem update --check"],
    run: (args, app, io) => runUpdate(args, {
      root: app.root, version: app.version, pkgPath: app.pkgPath, pkgName: app.pkgName, cliEntry: app.cliEntry,
      isGit: existsSync(resolve(app.root, ".git")),
      detectDeploy: () => detectDeploy(app.root, io.sys.env),
      redeploy: (onLine) => redeployCaptured(app, io, onLine),
    }, io),
  },
  tools: {
    group: "Run and maintain",
    summary: "List the tools the server gives a client",
    usage: "totem tools",
    about: "Lists the MCP tools by name: the ones that read your WHOOP data and the ones that change it.",
    run: async (_args, _app, io) => { io.ui.lines(toolsScreen(io.ui.kit, await registeredTools())); return 0; },
  },
  token: {
    group: "Run and maintain",
    summary: "Print the server's MCP_AUTH_TOKEN, for use in a command",
    usage: "totem token [--show]",
    about: "Prints the deployed server's MCP_AUTH_TOKEN so a command can use it without the token appearing on screen: --header \"Authorization: Bearer $(totem token)\". On a terminal it prints only with --show.",
    options: [["--show", "Print it even to a terminal"]],
    run: token,
  },
  start: {
    group: "Develop",
    summary: "Start the MCP server (stdio; --http for HTTP)",
    usage: "totem start [--http]",
    about: "Starts the built server. Over stdio it is what a local client runs. With --http it listens on PORT (default 3000) and needs MCP_AUTH_TOKEN set to at least 32 characters.",
    options: [["--http", "Serve over HTTP instead of stdio"]],
    run: async (args, app, io) => {
      const serverJs = resolve(app.root, "dist", "server.js");
      if (!existsSync(serverJs)) {
        io.ui.error("The server isn't built yet.", { fix: [["Build it", "totem build"]] });
        return 1;
      }
      return io.sys.run(io.sys.node, [serverJs], { cwd: app.root, env: { ...io.sys.env, MCP_TRANSPORT: args.includes("--http") ? "http" : "stdio" } });
    },
  },
  dev: {
    group: "Develop",
    summary: "Start the server from source (--http for HTTP)",
    usage: "totem dev [--http]",
    about: "Starts the server from the TypeScript source when this is a source checkout (no rebuild needed), else from the build.",
    options: [["--http", "Serve over HTTP instead of stdio"]],
    run: async (args, app, io) => {
      const script = scriptCommand(app.root, "server", true);
      if (!script) {
        io.ui.error("There is no server to start: no build and no source checkout.", { fix: [["Install and build", "npm install && totem build"]] });
        return 1;
      }
      return io.sys.run(io.sys.node, script, { cwd: app.root, env: args.includes("--http") ? { ...io.sys.env, MCP_TRANSPORT: "http" } : io.sys.env });
    },
  },
  build: {
    group: "Develop",
    summary: "Compile the TypeScript source to dist/",
    usage: "totem build",
    about: "Runs the TypeScript compiler over src/.",
    run: (args, app, io) => devTool(app, io, "typescript", "tsc", args),
  },
  test: {
    group: "Develop",
    summary: "Run the tests",
    usage: "totem test [filter]",
    about: "Runs the test suite with vitest. A filter runs only the test files whose path matches.",
    run: (args, app, io) => devTool(app, io, "vitest", "vitest", ["run", ...args]),
  },
  typecheck: {
    group: "Develop",
    summary: "Check types without building",
    usage: "totem typecheck",
    about: "Runs the TypeScript compiler with --noEmit.",
    run: (args, app, io) => devTool(app, io, "typescript", "tsc", ["--noEmit", ...args]),
  },
};

/** Other names for a command: old ones kept working, and the usual flags. */
const ALIASES: Record<string, string[]> = {
  info: ["status"],
  config: ["connect"],
  "dev:http": ["dev", "--http"],
};

/**
 * A table's own entry for what was typed. `commands[name]` alone also finds
 * what every object inherits: `totem constructor` and `totem toString` were
 * "commands" with nothing to run, and crashed with a TypeError.
 */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

// ── help ─────────────────────────────────────────────────────────────────────

export function helpScreen(k: Kit, app: Pick<AppCtx, "version">): string[] {
  const nameWidth = Math.max(...Object.keys(commands).map((n) => n.length)) + 3;
  const lines = [
    "",
    `${k.c.bold("totem")} ${k.c.dim(app.version)}`,
    ...k.para("Your WHOOP data in Claude, ChatGPT and other AI clients, over MCP.", 0),
    "",
    k.c.bold("Usage"),
    "  totem <command> [options]",
  ];
  for (const group of GROUPS) {
    lines.push("", k.c.bold(group));
    for (const [name, cmd] of Object.entries(commands)) {
      if (cmd.group !== group) continue;
      // Summaries are written to fit; on a narrow terminal they wrap under themselves.
      wrap(cmd.summary, k.style.width - 2 - nameWidth).forEach((line, i) => lines.push(`  ${i === 0 ? k.c.accent(padEnd(name, nameWidth)) : " ".repeat(nameWidth)}${line}`));
    }
  }
  lines.push("", k.c.bold("Options"));
  for (const [flag, text] of [["-h, --help", "Show this; totem <command> --help for one command"], ["-v, --version", "Print the version"], ["--no-color", "Plain output (NO_COLOR=1 does the same)"]] as const) {
    wrap(text, k.style.width - 2 - 16).forEach((line, i) => lines.push(`  ${i === 0 ? padEnd(flag, 16) : " ".repeat(16)}${line}`));
  }
  lines.push("", `New here? Start with  ${k.c.accent("totem cloud")}`, "");
  return lines;
}

export function commandHelp(k: Kit, name: string): string[] | null {
  const cmd = own(commands, name);
  if (!cmd) return null;
  const table = (pairs: Array<[string, string]>): string[] => {
    const w = Math.max(...pairs.map(([a]) => a.length)) + 3;
    return pairs.flatMap(([a, b]) => wrap(b, k.style.width - 2 - w).map((line, i) => `  ${i === 0 ? padEnd(a, w) : " ".repeat(w)}${line}`));
  };
  const lines = ["", k.c.bold(`totem ${name}`), ...k.para(cmd.about, 0), "", k.c.bold("Usage"), `  ${cmd.usage}`];
  if (cmd.options?.length) lines.push("", k.c.bold("Options"), ...table(cmd.options));
  if (cmd.env?.length) lines.push("", k.c.bold("Environment"), ...table(cmd.env));
  if (cmd.examples?.length) lines.push("", k.c.bold("Examples"), ...cmd.examples.map((e) => `  ${k.c.accent(e)}`));
  lines.push("");
  return lines;
}

/** The command a mistyped one most likely meant, if one is close. */
export function nearest(name: string): string | null {
  const names = [...Object.keys(commands), ...Object.keys(ALIASES)];
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length]!;
  };
  const prefixed = names.find((n) => n.startsWith(name) && name.length >= 2);
  if (prefixed) return prefixed;
  const [best] = names.map((n) => [n, distance(name, n)] as const).sort((a, b) => a[1] - b[1]);
  return best && best[1] <= 2 ? best[0] : null;
}

// ── entry ────────────────────────────────────────────────────────────────────

export async function runCli(argv: string[], app: AppCtx, io: Io): Promise<number> {
  const { ui } = io;
  let [name, ...args] = argv;
  if (name === undefined || name === "help" || name === "-h" || name === "--help") {
    const topic = name === "help" ? args[0] : undefined;
    if (topic) {
      const help = commandHelp(ui.kit, own(ALIASES, topic)?.[0] ?? topic);
      if (help) { ui.lines(help); return 0; }
      name = topic; // falls through to "unknown command"
    } else {
      ui.lines(helpScreen(ui.kit, app));
      return 0;
    }
  }
  if (name === "version" || name === "-v" || name === "--version") {
    ui.line(app.version);
    return 0;
  }
  const alias = own(ALIASES, name);
  if (alias) { name = alias[0]!; args = [...alias.slice(1), ...args]; }

  const cmd = own(commands, name);
  if (!cmd) {
    const close = nearest(name);
    ui.error(`"${name}" isn't a totem command.`, { fix: [...(close ? [["Did you mean", `totem ${close}`] as Fix] : []), ["See them all", "totem help"]] });
    return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    ui.lines(commandHelp(ui.kit, name)!);
    return 0;
  }
  return cmd.run(args, app, io);
}
