// The guided flows: `totem local` (run on this computer), `totem cloud`
// (deploy a server) and `totem connect` (connect another client).
//
// Each screen says what is happening, what the person must do now, and what
// comes next. Prompts are kept to the decisions only a person can make: which
// client, which host, and one confirmation of the whole deploy plan before
// anything is created or billed. Everything else takes a stated default.
//
// What a flow does (which commands run, in which order) is unchanged from the
// original; only how it is shown and asked is new. All effects go through
// io.sys, all output and questions through io.ui, so a test can drive a whole
// flow with a fake host and render the screen.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pkgBin } from "./spawn.js";
import { realAuthDeps, runAuth } from "./auth.js";
import { readDeployRecord, writeDeployRecord, type DeployRecord } from "./deploy_record.js";
import { migrateFromEnv, resolveTokenFilePath, writeFileAtomic } from "../whoop/token_store.js";
import {
  CLIENTS, FIRST_QUESTION, SERVER_NAME, applyRecipe, connectCard, findClient, lastLine, recipeLines, tildify,
  type Client, type Target,
} from "./clients.js";
import { realIo, type ExecResult, type Io } from "./sys.js";
import { duration, listOf, maskSecrets, shellLines, when, type Choice, type Fix } from "./ui.js";

const NODE_MIN = 24;
export const FLY_VOLUME = "totem_data";
export const FLY_REGION = "sjc";
const CLOUD_RUN_REGION = "us-west1";

/** The last few lines a command printed: enough to see why it failed. */
function tail(r: ExecResult, lines = 6): string[] {
  const all = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  return all.slice(-lines);
}

// A connector password the user chooses gates public access to their health
// data. Require length and two character classes, and refuse the obvious.
export function weakPassword(pw: string): string | null {
  if (pw.length < 16) return "Use at least 16 characters.";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 2) return "Mix at least two of: lower case, upper case, digits, symbols.";
  if (/^(.)\1+$/.test(pw)) return "That is one character repeated.";
  if (/^(password|whoop|123456|qwerty|letmein)/i.test(pw)) return "That is too easy to guess.";
  return null;
}

// ── prerequisites ───────────────────────────────────────────────────────────

/** Node, dependencies and (for a local install) the build. Fixes what it can. */
async function prerequisites(root: string, io: Io, build: boolean): Promise<boolean> {
  const { ui, sys } = io;
  if (Number(sys.nodeVersion.split(".")[0] ?? "0") < NODE_MIN) {
    ui.problem(`totem needs Node.js ${NODE_MIN} or newer. This is ${sys.nodeVersion}.`, {
      detail: "Install a newer one from https://nodejs.org, then run this command again.",
    });
    return false;
  }
  ui.ok(`Node.js ${sys.nodeVersion}`);

  if (existsSync(resolve(root, "node_modules"))) {
    ui.ok("Dependencies installed");
  } else {
    const started = sys.now();
    const r = await ui.task("Installing dependencies", (set) => sys.exec("npm", ["install"], { cwd: root, onLine: set }), { slow: true });
    if (r.code !== 0) {
      ui.problem("Installing dependencies failed.", { detail: tail(r), fix: [["Run it yourself", "npm install"]] });
      return false;
    }
    ui.ok("Dependencies installed", duration(sys.now() - started));
  }
  if (!build) return true;

  if (existsSync(resolve(root, "dist", "server.js"))) {
    ui.ok("Server built");
    return true;
  }
  const tsc = pkgBin(root, "typescript", "tsc");
  if (!tsc) {
    ui.problem("The server isn't built, and the TypeScript compiler isn't installed.", { fix: [["Install it", "npm install"], ["Then", "totem local"]] });
    return false;
  }
  const started = sys.now();
  const r = await ui.task("Building the server", (set) => sys.exec(sys.node, [tsc], { cwd: root, onLine: set }), { slow: true });
  if (r.code !== 0) {
    ui.problem("Building the server failed.", { detail: tail(r), fix: [["See the full output", "totem build"]] });
    return false;
  }
  ui.ok("Server built", duration(sys.now() - started));
  return true;
}

interface Installer { brew?: string; npm?: string; script?: string; manual: string; windows?: string }

/** Make sure a host's CLI is installed, offering each way this machine has. */
async function ensureCli(io: Io, names: string[], title: string, install: Installer): Promise<string | null> {
  const { ui, sys } = io;
  const found = (): string | null => names.find((n) => sys.has(n)) ?? null;
  const already = found();
  if (already) {
    ui.ok(`${title} installed`);
    return already;
  }
  ui.warn(`The ${title} isn't installed.`);
  const ways: Array<{ via: string; cmd: string; args: string[] }> = [];
  if (install.brew && sys.has("brew")) ways.push({ via: "Homebrew", cmd: "brew", args: ["install", ...install.brew.split(" ")] });
  if (install.npm && sys.has("npm")) ways.push({ via: "npm", cmd: "npm", args: ["install", "-g", install.npm] });
  if (install.script && sys.platform !== "win32") ways.push({ via: "its install script", cmd: "sh", args: ["-c", install.script] });
  for (const way of ways) {
    const shown = way.cmd === "sh" ? way.args[1]! : `${way.cmd} ${way.args.join(" ")}`;
    ui.code([shown]);
    if (!(await ui.confirm(`Install it with ${way.via}?`, true))) continue;
    await sys.run(way.cmd, way.args);
    const now = found();
    if (now) {
      ui.ok(`${title} installed`);
      return now;
    }
    ui.warn(`That didn't put ${names[0]} on this shell's PATH.`);
  }
  ui.problem(`totem can't go on without the ${title}.`, { fix: [["Install it", sys.platform === "win32" && install.windows ? install.windows : install.manual], ["Then, in a new terminal", "totem cloud"]] });
  return null;
}

// ── connecting a client ─────────────────────────────────────────────────────

function localTarget(root: string, io: Io): Extract<Target, { kind: "local" }> {
  return { kind: "local", node: io.sys.node, serverJs: resolve(root, "dist", "server.js") };
}

/** Where this install runs, from the deploy record: a server with a URL, or this computer. */
export function installTarget(root: string, io: Io): Target {
  const record = readDeployRecord(root);
  if (record && record.platform !== "local" && record.url) return { kind: "remote", mcpUrl: `${record.url.replace(/\/+$/, "")}/mcp` };
  return localTarget(root, io);
}

/** The universal stdio block, for a client totem doesn't know. */
function printOtherClient(io: Io, target: Target): void {
  const { ui, sys } = io;
  if (target.kind === "remote") {
    ui.para("Give the client this URL. It signs in through a totem page in your browser, with the connector password:");
    ui.code([target.mcpUrl]);
    ui.para("If it can't sign in through a browser, send the server's token as a bearer header instead:");
    ui.code(["Authorization: Bearer $(totem token)"]);
    return;
  }
  ui.para(`Most clients take this in their MCP config (the key is usually "mcpServers"):`);
  ui.code(JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: target.node, args: [target.serverJs] } } }, null, 2).split("\n"));
  ui.para("Or, as a command the client runs:");
  ui.code(shellLines([target.node, target.serverJs], ui.style.width - 4, sys.platform));
}

/** Ask which client, then set it up. Returns what the person still does. */
async function chooseAndConnect(io: Io, target: Target): Promise<{ client: Client | null; done: boolean; steps: string[] }> {
  const { ui, sys } = io;
  const offered = CLIENTS.filter((cl) => cl.recipe(target, sys).kind !== "unavailable");
  const found = offered.map((cl) => cl.detect(sys));
  const choices: Choice[] = [
    ...offered.map((cl, i) => ({ label: cl.name, hint: found[i] ? "installed" : undefined })),
    { label: "Another client", hint: "show what to paste" },
  ];
  const idx = await ui.select("Which client?", choices, Math.max(0, found.indexOf(true)));
  const client = offered[idx] ?? null;
  if (!client) {
    printOtherClient(io, target);
    return { client: null, done: false, steps: ["Add the config above to your client."] };
  }
  const applied = await applyRecipe(io, client, client.recipe(target, sys));
  return { client, ...applied };
}

function nextAfterConnect(io: Io, steps: string[]): void {
  const all = [...steps, `Ask it: ${FIRST_QUESTION}`];
  io.ui.next([...all.map((s, i) => `${i + 1}. ${s}`), "", "Connect another client: totem connect"]);
}

/**
 * `totem connect [client] [--print]`: connect a client to the install that is
 * already set up, or show what to paste where for every client.
 */
export async function runConnect(root: string, args: string[], io: Io = realIo()): Promise<number> {
  const { ui, sys } = io;
  const print = args.includes("--print");
  const wanted = args.find((a) => !a.startsWith("-"));
  const target = installTarget(root, io);
  if (target.kind === "local" && !existsSync(target.serverJs)) {
    ui.error("totem isn't set up on this computer yet.", { fix: [["Run on this computer", "totem local"], ["Or deploy a server", "totem cloud"]] });
    return 1;
  }
  const where = target.kind === "remote" ? `your server at ${target.mcpUrl.replace(/\/mcp$/, "")}` : "the totem on this computer";

  // "stdio" and "http" are what `totem config` took before it became connect.
  if (wanted === "other" || wanted === "stdio" || wanted === "http") {
    ui.header("totem connect", `Connect a client to ${where}.`);
    printOtherClient(io, target);
    return 0;
  }
  if (wanted) {
    const client = findClient(wanted);
    if (!client) {
      ui.error(`totem doesn't know a client called "${wanted}".`, {
        detail: `It knows: ${CLIENTS.map((cl) => cl.id).join(", ")}, other.`,
        fix: [["See them all", "totem connect"]],
      });
      return 1;
    }
    ui.header("totem connect", `Connect ${client.name} to ${where}.`);
    const recipe = client.recipe(target, sys);
    // A remote install is finished by signing in from the client, on the server's
    // own page, so the address and which password it wants come first.
    if (target.kind === "remote" && recipe.kind !== "unavailable") {
      ui.rows([["URL", ui.kit.c.accent(target.mcpUrl)], ["Password", "the connector password from totem cloud"]]);
      ui.line();
    }
    // totem sets the client up itself when that is a file or the client's own
    // command (for a server, both hold only its address). Steps in a client's
    // settings, and --print, are shown instead.
    if (print || recipe.kind === "steps" || recipe.kind === "unavailable") {
      ui.line(`  ${ui.kit.c.bold(client.name)}`);
      ui.lines(recipeLines(recipe, ui.kit, sys));
      return recipe.kind === "unavailable" ? 1 : 0;
    }
    const applied = await applyRecipe(io, client, recipe);
    nextAfterConnect(io, applied.steps);
    return 0;
  }

  ui.header("totem connect", `Connect a client to ${where}.`);
  if (target.kind === "local" && ui.canAsk && !print) {
    const { steps } = await chooseAndConnect(io, target);
    nextAfterConnect(io, steps);
    return 0;
  }
  ui.lines(connectCard(ui.kit, sys, { target, password: null }));
  return 0;
}

// ── LOCAL ───────────────────────────────────────────────────────────────────

/** A WHOOP login on this computer: the saved one, v1's from .env, or a new browser login. */
async function ensureLocalLogin(root: string, io: Io): Promise<boolean> {
  const { ui } = io;
  const auth = io.auth ?? realAuthDeps;
  const env = auth.cliEnv(resolve(root, ".env"));
  const local = auth.readLocalStatus(resolveTokenFilePath(env));
  if (local.state === "tokens") {
    ui.ok("Already logged in to WHOOP", `saved ${when(local.savedAt)}`);
    ui.hint("To log in again: totem auth --local");
    return true;
  }
  if (local.state !== "handed-off" && migrateFromEnv(env)) {
    ui.ok("Using the WHOOP login from totem 1.x", "the server moves it out of .env on first start");
    return true;
  }
  return (await runAuth(root, ["--local"], { embedded: true }, io)) === 0;
}

export async function runLocalSetup(root: string, io: Io = realIo()): Promise<number> {
  const { ui } = io;
  const TOTAL = 3;
  ui.header("totem local", "Run totem on this computer and connect an AI client to it.");

  // `totem local` records this install as local. If it is recorded as deployed,
  // that record (and the server's token in it) is what `totem auth`, `status`
  // and `logs` use: don't drop it without asking.
  const record = readDeployRecord(root);
  if (record && record.platform !== "local" && record.url) {
    ui.warn(`This install is set up for the server at ${record.url}.`);
    ui.hint("Setting it up locally makes this computer forget that server (the server itself keeps running). A local server and a deployment must not share one WHOOP login.");
    if (!(await ui.confirm("Switch this install to local?", false))) {
      ui.hint("Nothing changed. To connect a client to the server: totem connect");
      return 1;
    }
  }

  ui.step(1, TOTAL, "Prerequisites");
  if (!(await prerequisites(root, io, true))) return 1;

  ui.step(2, TOTAL, "WHOOP login");
  if (!(await ensureLocalLogin(root, io))) return 1;
  writeDeployRecord(root, { platform: "local" });

  ui.step(3, TOTAL, "Connect a client");
  const { steps } = await chooseAndConnect(io, localTarget(root, io));
  nextAfterConnect(io, steps);
  return 0;
}

// ── CLOUD ───────────────────────────────────────────────────────────────────

type Platform = "fly" | "railway" | "cloudrun" | "custom";
const HOSTS: Array<{ id: Platform; name: string; hint: string }> = [
  { id: "fly", name: "Fly.io", hint: "a small VM with a volume for the login (recommended)" },
  { id: "railway", name: "Railway", hint: "a managed service with a dashboard" },
  { id: "cloudrun", name: "Google Cloud Run", hint: "serverless; no disk, so a restart needs a new login" },
  { id: "custom", name: "My own server", hint: "any Docker host; totem prints the commands" },
];

interface Deploy {
  root: string;
  io: Io;
  platform: Platform;
  /** Everything the server needs except PUBLIC_URL. */
  env: Record<string, string>;
  appName: string;
  /** Show the host CLI's own output instead of a spinner. */
  verbose: boolean;
  /** The host CLI binary (fly or flyctl). */
  cli: string;
  account: string;
  /** How to remove what a failed deploy left behind. */
  cleanup?: Fix;
}

interface HostStep {
  /** While it runs: "Deploying to Fly". */
  label: string;
  /** When it worked: "Deployed". */
  done: string;
  run: (set: (detail: string) => void) => Promise<ExecResult | boolean>;
  /** Silent re-tries first, for hosts whose APIs time out. */
  retries?: number;
  /** May be skipped; the text says what skipping costs. */
  optional?: string;
  /** Runs with the terminal attached (it may ask or open a browser): no spinner. */
  attached?: boolean;
  slow?: boolean;
}

const worked = (r: ExecResult | boolean): boolean => (typeof r === "boolean" ? r : r.code === 0);

/**
 * A host CLI's output with this deploy's secrets blanked. totem shows the
 * latest line a command printed and, when it fails, the end of its output; a
 * CLI that echoes what it was given must not put the token or the password on
 * screen that way.
 */
function redact(d: Deploy, text: string): string {
  let out = text;
  for (const secret of [d.env.MCP_AUTH_TOKEN, d.env.AUTH_PASSWORD]) {
    if (!secret) continue;
    for (const form of secretForms(secret)) out = out.split(form).join("***");
  }
  return out;
}

/**
 * A secret as given, and the ways a CLI writes it back: inside JSON, in a URL
 * or a form body. The generated token and password read the same in all of
 * them; a password the person chose (spaces, quotes, &, \) does not, and the
 * plain text alone would let the escaped one through.
 */
export function secretForms(secret: string): string[] {
  const forms = [secret, JSON.stringify(secret).slice(1, -1)];
  try {
    const percent = encodeURIComponent(secret);
    forms.push(percent, percent.replace(/%20/g, "+"));
  } catch { /* a lone surrogate has no percent form */ }
  return [...new Set(forms)].filter(Boolean);
}

/** A host command: captured under a spinner showing its latest line, or attached with --verbose. */
function hostCommand(d: Deploy, cmd: string, args: string[], input?: string): HostStep["run"] {
  const { ui, sys } = d.io;
  return async (set) => {
    if (d.verbose && input === undefined) {
      ui.hint(`$ ${cmd} ${maskSecrets(args)}`);
      return (await sys.run(cmd, args, { cwd: d.root })) === 0;
    }
    return sys.exec(cmd, args, input === undefined ? { cwd: d.root, onLine: set } : { cwd: d.root, input, onLine: set });
  };
}

/** Run one step. On failure show why and let the person retry, skip (if it can be) or stop. */
async function runStep(d: Deploy, step: HostStep): Promise<"ok" | "skipped" | "cancelled"> {
  const { ui, sys } = d.io;
  for (;;) {
    const started = sys.now();
    let result: ExecResult | boolean = false;
    // An attached command prints for itself: say what it is first.
    if (step.attached || d.verbose) ui.info(`${step.label}${ui.kit.g.ellipsis}`);
    for (let attempt = 0; attempt <= (step.retries ?? 0); attempt++) {
      if (attempt > 0) await ui.task(`The host didn't answer; trying again (${attempt}/${step.retries})`, () => sys.sleep(2500));
      result = step.attached || d.verbose
        ? await step.run(() => {})
        : await ui.task(step.label, (set) => step.run((line) => set(redact(d, line))), { slow: Boolean(step.slow) });
      if (worked(result)) break;
    }
    if (worked(result)) {
      ui.ok(step.done, duration(sys.now() - started));
      return "ok";
    }
    ui.problem(`${step.label} failed.`, { detail: typeof result === "boolean" ? undefined : tail(result).map((line) => redact(d, line)) });
    const choices: Choice[] = [
      { label: "Try again" },
      ...(step.optional ? [{ label: "Skip this step", hint: step.optional }] : []),
      { label: "Stop here" },
    ];
    const pick = await ui.select("What now?", choices);
    if (pick === 0) continue;
    if (step.optional && pick === 1) {
      ui.warn(`Skipped. ${step.optional}`);
      return "skipped";
    }
    return "cancelled";
  }
}

// FLY ─────────────────────────────────────────────────────────────────────────

/**
 * The fly.toml `totem cloud` writes. With a volume, [mounts] puts it at /data,
 * where the image keeps the WHOOP token file (TOTEM_TOKEN_FILE=/data/tokens.json),
 * so the login survives restarts and deploys.
 */
export function flyToml(appName: string, withVolume: boolean): string {
  return [
    `app = "${appName}"`,
    `primary_region = "${FLY_REGION}"`,
    ``,
    `[build]`,
    ``,
    ...(withVolume
      ? [
          `# The WHOOP login lives here (/data/tokens.json). WHOOP rotates the refresh`,
          `# token on every refresh, so it must survive restarts.`,
          `[mounts]`,
          `  source = "${FLY_VOLUME}"`,
          `  destination = "/data"`,
          ``,
        ]
      : []),
    `[http_service]`,
    `  internal_port = 3000`,
    `  force_https = true`,
    `  # Keep one machine warm so the connector never cold-starts — the first`,
    `  # request after an auto-stop would otherwise fail while the VM boots (~10s).`,
    `  auto_stop_machines = "suspend"`,
    `  auto_start_machines = true`,
    `  min_machines_running = 1`,
    ``,
  ].join("\n");
}

async function deployFly(d: Deploy): Promise<string | null> {
  const { ui, sys } = d.io;
  const fly = d.cli;

  // The app. Names are unique across all of Fly: one you already own is reused
  // (a re-run, or a half-finished earlier attempt); one someone else has needs
  // another name.
  for (let attempt = 0; ; attempt++) {
    const name = d.appName;
    const create = await ui.task(`Creating the app ${name}`, () => sys.exec(fly, ["apps", "create", name, "--json"], { cwd: d.root }));
    if (create.code === 0) { ui.ok("App created", name); break; }
    const mine = await ui.task("Checking your Fly apps", () => sys.exec(fly, ["apps", "list"], { cwd: d.root }));
    if (new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(mine.stdout)) { ui.ok("App already exists on your account; using it", name); break; }
    if (attempt >= 9) {
      ui.problem("Couldn't create a Fly app after ten names.", { detail: lastLine(create) });
      return null;
    }
    ui.warn(`Fly wouldn't create "${name}": ${lastLine(create)}`);
    ui.hint("App names are unique across all of Fly, so someone else may have this one.");
    const fresh = `totem-${sys.token().slice(0, 6)}`;
    d.appName = (await ui.text("Another app name", fresh)).trim() || fresh;
  }
  d.cleanup = ["Remove the unfinished app", `${fly} apps destroy ${d.appName}`];
  const url = `https://${d.appName}.fly.dev`;
  const env = { ...d.env, PUBLIC_URL: url };

  // The volume the WHOOP login lives on.
  const list = await ui.task("Looking for the login volume", () => sys.exec(fly, ["volumes", "list", "--app", d.appName, "--json"], { cwd: d.root }));
  let volume = list.code === 0 && new RegExp(`"name"\\s*:\\s*"${FLY_VOLUME}"`).test(list.stdout);
  if (volume) {
    ui.ok("Volume already exists", FLY_VOLUME);
  } else {
    const made = await runStep(d, {
      label: "Creating the volume", done: `Volume created`,
      run: hostCommand(d, fly, ["volumes", "create", FLY_VOLUME, "--app", d.appName, "--region", FLY_REGION, "--size", "1", "--yes"]),
      optional: "Without a volume the server loses its WHOOP login on every restart.",
    });
    if (made === "cancelled") return null;
    volume = made === "ok";
  }
  // Minimal fly.toml so `fly deploy` asks nothing (it builds the Dockerfile).
  writeFileSync(resolve(d.root, "fly.toml"), flyToml(d.appName, volume));

  // Secrets: `secrets import` reads KEY=value lines from stdin, so the token and
  // password never appear on a command line. Staged, they apply on deploy.
  const secretLines = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const secrets = await runStep(d, {
    label: "Setting the secrets", done: "Secrets set",
    run: async (set) => {
      const staged = await sys.exec(fly, ["secrets", "import", "--stage", "--app", d.appName], { cwd: d.root, input: secretLines, onLine: set });
      if (staged.code === 0) return staged;
      return sys.exec(fly, ["secrets", "import", "--app", d.appName], { cwd: d.root, input: secretLines, onLine: set });
    },
  });
  if (secrets !== "ok") return null;

  const deployed = await runStep(d, {
    label: "Building and deploying on Fly", done: "Deployed", slow: true,
    run: hostCommand(d, fly, ["deploy", "--app", d.appName, "--ha=false"]),
  });
  return deployed === "ok" ? url : null;
}

// RAILWAY ─────────────────────────────────────────────────────────────────────

const SECRET_KEY = /(TOKEN|PASSWORD|SECRET)/i;

/**
 * The `railway` invocations that set `env` on the linked service, with every
 * secret value on stdin (`railway variable set KEY --stdin`) instead of the
 * command line, where any local user could read it from `ps` while the command
 * runs. Secrets go first with --skip-deploys; the plain values go last in one
 * call, which triggers the single redeploy. Empty values are skipped (Railway
 * rejects them).
 */
export function railwayVariableCommands(env: Record<string, string>): Array<{ args: string[]; input?: string }> {
  const entries = Object.entries(env).filter(([, v]) => v !== "");
  const secrets = entries.filter(([k]) => SECRET_KEY.test(k));
  const plain = entries.filter(([k]) => !SECRET_KEY.test(k));
  const commands: Array<{ args: string[]; input?: string }> = secrets.map(([k, v], i) => ({
    args: ["variable", "set", k, "--stdin", ...(plain.length || i < secrets.length - 1 ? ["--skip-deploys"] : [])],
    input: v,
  }));
  if (plain.length) commands.push({ args: ["variable", "set", ...plain.map(([k, v]) => `${k}=${v}`)] });
  return commands;
}

type Exec = (cmd: string, args: string[], opts: { cwd: string; input?: string }) => Promise<ExecResult>;

/**
 * Set `env` on the linked Railway service. A Railway CLI too old to know
 * `variable set --stdin` gets the values the old way (`variables --set`), and
 * `onOldCli` is told: that is the only case a secret reaches a command line.
 */
export async function setRailwayVariables(env: Record<string, string>, root: string, exec: Exec, onOldCli: () => void = () => {}): Promise<ExecResult> {
  let last: ExecResult = { code: 0, stdout: "", stderr: "" };
  for (const { args, input } of railwayVariableCommands(env)) {
    last = await exec("railway", args, input === undefined ? { cwd: root } : { cwd: root, input });
    if (last.code === 0) continue;
    if (/unexpected argument|unrecognized subcommand|wasn't expected|found argument/i.test(last.stderr + last.stdout)) {
      onOldCli();
      const legacy = ["variables", ...Object.entries(env).filter(([, v]) => v !== "").flatMap(([k, v]) => ["--set", `${k}=${v}`])];
      return exec("railway", legacy, { cwd: root });
    }
    return last;
  }
  return last;
}

// Railway's API (backboard.railway.com) intermittently times out, and a
// timed-out `init` can still have created the project. So: try init, and if it
// fails, look for the project and LINK to it instead of running init again
// (which would pile up duplicate projects).
async function railwayInitOrLink(d: Deploy): Promise<boolean> {
  const { ui, sys } = d.io;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) await ui.task(`Railway didn't answer; trying again (${attempt - 1}/3)`, () => sys.sleep(2500));
    if ((await sys.run("railway", ["init", "--name", d.appName], { cwd: d.root })) === 0) return true;
    let exists = false;
    for (let i = 0; i < 3 && !exists; i++) {
      const r = await ui.task("Checking whether Railway made the project", () => sys.exec("railway", ["list"], { cwd: d.root }));
      if (r.code === 0) { exists = r.stdout.includes(d.appName); break; }
    }
    if (exists) {
      ui.hint("Railway timed out but did create the project; linking to it.");
      if ((await sys.run("railway", ["link", "--project", d.appName], { cwd: d.root })) === 0) return true;
    }
  }
  return false;
}

async function deployRailway(d: Deploy): Promise<string | null> {
  const { ui, sys } = d.io;
  d.cleanup = ["Remove the unfinished project", "railway delete"];
  // init creates a PROJECT; `up` creates the service, so it runs before the
  // variables exist (that first build starts without them and is replaced by
  // the redeploy the variables trigger).
  const steps: HostStep[] = [
    { label: "Creating the Railway project", done: "Project created", attached: true, run: () => railwayInitOrLink(d) },
    { label: "Starting the first build", done: "Service created", retries: 3, slow: true, run: hostCommand(d, "railway", ["up", "--detach"]) },
    {
      // Railway volumes mount root-owned; the image's entrypoint hands /data to
      // the unprivileged user before starting the server.
      // Attached: with more than one service in the project, Railway asks which.
      label: "Adding the volume for the login", done: "Volume added at /data", retries: 1, attached: true,
      run: async () => (await sys.run("railway", ["volume", "add", "--mount-path", "/data"], { cwd: d.root })) === 0,
      optional: "Without a volume every restart or redeploy needs totem auth again.",
    },
    {
      label: "Setting the secrets", done: "Secrets set", retries: 3,
      run: () => setRailwayVariables(d.env, d.root, (cmd, args, opts) => sys.exec(cmd, args, opts), () => {
        ui.warn("This Railway CLI can't read a value from stdin, so the secrets are passed on its command line.");
        ui.hint("Update it to keep them off it: npm i -g @railway/cli");
      }),
    },
  ];
  for (const step of steps) if ((await runStep(d, step)) === "cancelled") return null;

  // `railway domain` prints the public URL.
  let url: string | null = null;
  for (let i = 0; i < 4 && !url; i++) {
    if (i > 0) await ui.task(`Railway didn't answer; trying again (${i}/3)`, () => sys.sleep(2500));
    const r = await ui.task("Getting the public address", () => sys.exec("railway", ["domain"], { cwd: d.root }));
    url = `${r.stdout}\n${r.stderr}`.match(/https?:\/\/[a-z0-9.-]+\.up\.railway\.app/i)?.[0] ?? null;
  }
  if (url) ui.ok("Public address", url);
  else url = await askUrl(d.io, "Railway didn't report the address. Public URL of the service");
  return setPublicUrl(d, url, [
    { label: "Telling the server its address", done: "PUBLIC_URL set", retries: 3, run: hostCommand(d, "railway", ["variables", "--set", `PUBLIC_URL=${url}`]) },
    { label: "Redeploying with it", done: "Redeployed", retries: 3, slow: true, run: hostCommand(d, "railway", ["up", "--detach"]) },
  ]);
}

/**
 * Sign-in (OAuth) only works when the server knows its own public address,
 * which exists only after the first deploy: set PUBLIC_URL and redeploy.
 */
async function setPublicUrl(d: Deploy, url: string, steps: HostStep[]): Promise<string | null> {
  for (const step of steps) {
    const r = await runStep(d, { ...step, optional: `Sign-in from claude.ai and other clients won't work until PUBLIC_URL=${url} is set on the server.` });
    if (r === "cancelled") return null;
    if (r === "skipped") break;
  }
  return url;
}

// GOOGLE CLOUD RUN ────────────────────────────────────────────────────────────

const gcloud = (d: { io: Io }, args: string[]): Promise<ExecResult> => d.io.sys.exec("gcloud", args);
const value = (r: ExecResult): string => r.stdout.trim().replace(/^\(unset\)$/, "");

/** Pick the Google account to deploy as; signing in to another happens right here. */
async function chooseGcloudAccount(io: Io): Promise<boolean> {
  const { ui, sys } = io;
  for (;;) {
    const all = (await ui.task("Listing your Google accounts", () => gcloud({ io }, ["auth", "list", "--format=value(account)"]))).stdout.trim().split("\n").filter(Boolean);
    const active = value(await gcloud({ io }, ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]));
    const idx = await ui.select("Which Google account?", [
      ...all.map((a) => ({ label: a, hint: a === active ? "active" : undefined })),
      { label: "Sign in to another account" },
    ], Math.max(0, all.indexOf(active)));
    if (idx === all.length) {
      if ((await sys.run("gcloud", ["auth", "login"])) !== 0) {
        ui.fail("The Google sign-in didn't finish.");
        if (!(await ui.confirm("Try again?", true))) return false;
      }
      continue;
    }
    const picked = all[idx]!;
    if (picked !== active) {
      const r = await ui.task(`Switching to ${picked}`, () => gcloud({ io }, ["config", "set", "account", picked]));
      if (r.code !== 0) { ui.fail(`Couldn't switch to ${picked}: ${lastLine(r)}`); continue; }
    }
    ui.ok("Google account", picked);
    return true;
  }
}

/**
 * Pick the GCP project, or create one. Like linking billing below, this
 * happens before the deploy plan is shown: what it creates is added to
 * `already`, so cancelling the plan doesn't claim that nothing was created.
 */
async function chooseGcloudProject(io: Io, already: string[]): Promise<boolean> {
  const { ui, sys } = io;
  const current = value(await gcloud({ io }, ["config", "get-value", "project"]));
  const projects = (await ui.task("Listing your projects", () => gcloud({ io }, ["projects", "list", "--format=value(projectId)"]))).stdout.trim().split("\n").filter(Boolean);
  const idx = await ui.select("Which Google Cloud project?", [
    ...projects.map((p) => ({ label: p, hint: p === current ? "current" : undefined })),
    { label: "Create a new project" },
  ], Math.max(0, projects.indexOf(current)));
  let project = projects[idx];
  if (!project) {
    for (;;) {
      const fresh = `totem-${sys.token().slice(0, 6)}`;
      project = (await ui.text("New project ID (6-30 lower-case letters, digits, hyphens)", fresh)).trim() || fresh;
      const made = await ui.task(`Creating ${project}`, () => gcloud({ io }, ["projects", "create", project!]));
      if (made.code === 0) { ui.ok("Project created", project); already.push(`the Google Cloud project ${project}`); break; }
      ui.fail(`Couldn't create ${project}: ${lastLine(made)}`);
      if (!(await ui.confirm("Try another ID?", true))) return false;
    }
  }
  const chosen = project;
  const set = await ui.task(`Selecting ${chosen}`, () => gcloud({ io }, ["config", "set", "project", chosen]));
  if (set.code !== 0) { ui.fail(`Couldn't select ${chosen}: ${lastLine(set)}`); return false; }
  ui.ok("Project", chosen);
  return true;
}

// Cloud Run needs billing on the project. An existing billing account is linked
// from here; creating one (adding a payment method) only exists in the console.
async function ensureGcloudBilling(io: Io, already: string[]): Promise<boolean> {
  const { ui, sys } = io;
  const project = value(await gcloud({ io }, ["config", "get-value", "project"]));
  const billing = await ui.task("Checking billing", () => gcloud({ io }, ["billing", "projects", "describe", project, "--format=value(billingEnabled)"]));
  if (billing.code === 0 && /true/i.test(billing.stdout)) { ui.ok("Billing is on for the project"); return true; }

  const accounts = (await ui.task("Listing your billing accounts", () => gcloud({ io }, ["billing", "accounts", "list", "--filter=open=true", "--format=value(name)"]))).stdout.trim().split("\n").filter(Boolean);
  if (accounts.length > 0) {
    const idx = await ui.select("Cloud Run needs billing on the project. Link which billing account?", [
      ...accounts.map((a) => ({ label: a })),
      { label: "None of these", hint: "set one up in the console" },
    ]);
    const account = accounts[idx];
    if (account) {
      const link = await ui.task("Linking billing", () => gcloud({ io }, ["billing", "projects", "link", project, "--billing-account", account]));
      if (link.code === 0) { ui.ok("Billing linked", account); already.push(`billing on ${project}`); return true; }
      ui.fail(`Couldn't link billing: ${lastLine(link)}`);
    }
  }
  const url = `https://console.cloud.google.com/billing/linkedaccount?project=${project}`;
  ui.warn("The project needs a billing account, and only the Google Cloud console can create one.");
  ui.para("Opening it in your browser:", 4);
  ui.code([url]);
  sys.openUrl(url);
  return ui.confirm("Is billing on for the project now?", true);
}

async function deployCloudRun(d: Deploy): Promise<string | null> {
  const { ui, sys } = d.io;
  d.cleanup = ["Remove the unfinished service", `gcloud run services delete ${d.appName} --region ${CLOUD_RUN_REGION}`];
  // The settings go in a temp YAML file (--env-vars-file), not --set-env-vars:
  // values would otherwise sit on the command line, and a random password can
  // collide with any inline delimiter. The file lives in the OS temp dir, never
  // the uploaded source dir, and is deleted afterwards. PUBLIC_URL follows once
  // the address is known.
  const envFile = resolve(tmpdir(), `totem-env-${randomUUID()}.yaml`);
  writeFileSync(envFile, Object.entries(d.env).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });
  try {
    const steps: HostStep[] = [
      {
        label: "Turning on the Cloud Run, Cloud Build and Artifact Registry APIs", done: "APIs on",
        run: hostCommand(d, "gcloud", ["services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com"]),
        optional: "The deploy fails if they are off.",
      },
      {
        // `gcloud run deploy --source` builds with the project's default compute
        // service account, which on a new project may not build.
        label: "Letting Cloud Build use the default service account", done: "Build access granted",
        run: hostCommand(d, "sh", ["-c", 'P="$(gcloud config get-value project 2>/dev/null)"; N="$(gcloud projects describe "$P" --format=\'value(projectNumber)\' 2>/dev/null)"; gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:${N}-compute@developer.gserviceaccount.com" --role=roles/cloudbuild.builds.builder --condition=None']),
        optional: "Fine to skip if the project already builds from source.",
      },
      {
        label: "Building and deploying on Cloud Run", done: "Deployed", slow: true,
        run: hostCommand(d, "gcloud", [
          "run", "deploy", d.appName,
          "--source", ".",
          "--region", CLOUD_RUN_REGION,
          "--allow-unauthenticated",
          "--port", "3000",
          "--min-instances", "1",
          // One instance: the WHOOP login lives in that instance's token file,
          // and a second instance would have none (or a competing copy).
          "--max-instances", "1",
          "--env-vars-file", envFile,
          "--quiet",
        ]),
      },
    ];
    for (const step of steps) if ((await runStep(d, step)) === "cancelled") return null;

    const described = await ui.task("Getting the public address", () => gcloud(d, ["run", "services", "describe", d.appName, "--region", CLOUD_RUN_REGION, "--format=value(status.url)"]));
    let url = /^https?:\/\//.test(described.stdout.trim()) ? described.stdout.trim().replace(/\/+$/, "") : "";
    if (url) ui.ok("Public address", url);
    else url = await askUrl(d.io, "Cloud Run didn't report the address. Public URL of the service");
    return await setPublicUrl(d, url, [{
      label: "Telling the server its address", done: "PUBLIC_URL set", retries: 3,
      run: hostCommand(d, "gcloud", ["run", "services", "update", d.appName, "--region", CLOUD_RUN_REGION, "--update-env-vars", `PUBLIC_URL=${url}`, "--quiet"]),
    }]);
  } finally {
    try { rmSync(envFile); } catch { /* best-effort */ }
  }
}

// CUSTOM ──────────────────────────────────────────────────────────────────────

/** Ask for a public URL until it is one. A bare domain gets https://. */
async function askUrl(io: Io, question: string): Promise<string> {
  const { ui } = io;
  for (;;) {
    let url = (await ui.text(question)).trim();
    if (!url) { ui.hint("A URL is needed to go on. Ctrl-C stops.", 2); continue; }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    if (/^https?:\/\/[^/.\s]+\.[^/\s]+/.test(url)) return url.replace(/\/+$/, "");
    ui.hint(`"${url}" isn't a URL like https://totem.example.com.`, 2);
  }
}

// Run the container yourself on any Docker host. The settings (with the real
// secrets) go into an env file rather than onto the screen.
async function deployCustom(d: Deploy): Promise<string | null> {
  const { ui, sys } = d.io;
  const envFile = resolve(d.root, ".env.deploy");
  // Replaced, not written in place: a mode given to writeFileSync only applies
  // to a file it creates, so an .env.deploy that was already there (from an
  // earlier run, or copied in) kept whatever permissions it had while the next
  // line called it "readable only by you".
  writeFileAtomic(envFile, Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\nPUBLIC_URL=https://CHANGE-ME-to-your-public-https-address\n");
  const width = ui.style.width - 7;
  ui.ok("Settings written", `${tildify(envFile, sys.home)}, readable only by you`);
  ui.para("That file holds the server's secrets. totem doesn't run Docker for you; these are the steps:");
  ui.line();
  ui.para("1. In .env.deploy, set PUBLIC_URL to the https address the server will have.");
  ui.para("2. On your Docker host, in this directory (copy it there, with .env.deploy, if it is another machine), build the image:");
  ui.code(["docker build -t totem ."], 5);
  ui.para("3. Start it. The totem-data volume keeps the WHOOP login across restarts:");
  ui.code(shellLines(["docker", "run", "-d", "--restart", "unless-stopped", "-p", "3000:3000", "-v", "totem-data:/data", "--env-file", ".env.deploy", "totem"], width, sys.platform), 5);
  ui.para("4. Put it behind HTTPS at that address (a reverse proxy, a tunnel, or your host's TLS).");
  ui.line();
  return askUrl(d.io, "Public https URL, once the server is up");
}

// ── verification ─────────────────────────────────────────────────────────────

/** Is the server up, does it advertise sign-in, and does /mcp refuse strangers? */
async function verifyDeployment(io: Io, baseUrl: string): Promise<{ healthy: boolean; locked: boolean }> {
  const { ui, sys } = io;
  const root = baseUrl.replace(/\/(mcp)?$/, "");
  // Poll with a short per-request timeout: an address that hasn't propagated
  // yet fails fast and is asked again, instead of hanging on one request.
  const started = sys.now();
  let healthy = false;
  let lastError = "";
  await ui.task(`Waiting for ${root} to answer`, async (set) => {
    while (sys.now() - started < 90_000) {
      const health = await sys.httpGet(`${root}/health`, 3000);
      if (health.status === 200) { healthy = true; return; }
      lastError = health.status ? `HTTP ${health.status}` : health.error ?? "no answer";
      set(lastError);
      await sys.sleep(1500);
    }
  }, { slow: true });
  if (!healthy) {
    ui.fail("The server didn't answer", `${lastError || "no answer"} after ${duration(sys.now() - started)}`);
    return { healthy, locked: false };
  }
  ui.ok("The server is up", `/health answered in ${duration(sys.now() - started) || "under a second"}`);
  const prm = await ui.task("Checking sign-in", () => sys.httpGet(`${root}/.well-known/oauth-protected-resource/mcp`, 5000));
  const prmOk = prm.status === 200 && prm.body.includes("/mcp");
  if (prmOk) ui.ok("Sign-in is advertised", "clients can find where to log in");
  else ui.warn("The server doesn't advertise sign-in yet", prm.status ? `HTTP ${prm.status}` : prm.error ?? "no answer");
  // An unauthenticated /mcp must be refused, not served.
  const gate = await ui.task("Checking the lock on /mcp", () => sys.httpGet(`${root}/mcp`, 5000));
  const gated = gate.status === 401;
  if (gated) ui.ok("/mcp is locked", "401 without a token");
  else ui.fail(gate.status ? "/mcp answered without a token" : "/mcp didn't answer", gate.status ? `HTTP ${gate.status}, expected 401` : gate.error ?? "no answer");
  return { healthy, locked: gated };
}

// ── the flow ─────────────────────────────────────────────────────────────────

/** The host's CLI and a signed-in account. Returns the binary and who is signed in. */
async function hostAccount(io: Io, platform: Platform, already: string[]): Promise<{ cli: string; account: string } | null> {
  const { ui, sys } = io;
  const who = async (cli: string, args: string[]): Promise<string | null> => {
    const r = await ui.task("Checking who is signed in", () => sys.exec(cli, args));
    return r.code === 0 ? r.stdout.trim().replace(/\s+/g, " ").replace(/^Logged in as\s+/i, "").replace(/\s*👋$/u, "") || "your account" : null;
  };
  if (platform === "fly") {
    const cli = await ensureCli(io, ["fly", "flyctl"], "Fly CLI", { brew: "flyctl", script: "curl -fsSL https://fly.io/install.sh | sh", manual: "brew install flyctl", windows: 'pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"' });
    if (!cli) return null;
    let account = await who(cli, ["auth", "whoami"]);
    if (!account) {
      ui.info("Signing in to Fly; it opens your browser.");
      if ((await sys.run(cli, ["auth", "login"])) !== 0) { ui.problem("The Fly sign-in didn't finish.", { fix: [["Sign in", `${cli} auth login`], ["Then", "totem cloud"]] }); return null; }
      account = (await who(cli, ["auth", "whoami"])) ?? "your account";
    }
    ui.ok("Signed in to Fly", account);
    return { cli, account };
  }
  if (platform === "railway") {
    const cli = await ensureCli(io, ["railway"], "Railway CLI", { npm: "@railway/cli", brew: "railway", manual: "npm i -g @railway/cli" });
    if (!cli) return null;
    let account = await who(cli, ["whoami"]);
    if (!account) {
      ui.info("Signing in to Railway; it opens your browser.");
      if ((await sys.run(cli, ["login"])) !== 0) { ui.problem("The Railway sign-in didn't finish.", { fix: [["Sign in", "railway login"], ["Then", "totem cloud"]] }); return null; }
      account = (await who(cli, ["whoami"])) ?? "your account";
    }
    ui.ok("Signed in to Railway", account);
    return { cli, account };
  }
  if (platform === "cloudrun") {
    const cli = await ensureCli(io, ["gcloud"], "Google Cloud CLI", { brew: "--cask google-cloud-sdk", script: "curl https://sdk.cloud.google.com | bash", manual: "brew install --cask google-cloud-sdk", windows: "winget install Google.CloudSDK" });
    if (!cli) return null;
    let account = value(await ui.task("Checking who is signed in", () => gcloud({ io }, ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"])));
    if (!account) {
      ui.info("Signing in to Google; it opens your browser.");
      if ((await sys.run("gcloud", ["auth", "login"])) !== 0) { ui.problem("The Google sign-in didn't finish.", { fix: [["Sign in", "gcloud auth login"], ["Then", "totem cloud"]] }); return null; }
      account = value(await gcloud({ io }, ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"])) || "your account";
    }
    ui.ok("Signed in to Google", account);
    // Which project, and billing on it, are choices the person must own.
    if (!value(await gcloud({ io }, ["config", "get-value", "project"])) && !(await chooseGcloudProject(io, already))) return null;
    if (!(await ensureGcloudBilling(io, already))) return null;
    return { cli, account };
  }
  return { cli: "docker", account: "" };
}

/** Sign in to the host as someone else. Returns the new account, or null if it didn't finish. */
async function switchAccount(io: Io, platform: Platform, cli: string, already: string[]): Promise<string | null> {
  const { ui, sys } = io;
  if (platform === "cloudrun") {
    if (!(await chooseGcloudAccount(io)) || !(await chooseGcloudProject(io, already)) || !(await ensureGcloudBilling(io, already))) return null;
    return value(await gcloud({ io }, ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"])) || "your account";
  }
  const [out, login, whoami] = platform === "fly" ? [["auth", "logout"], ["auth", "login"], ["auth", "whoami"]] : [["logout"], ["login"], ["whoami"]];
  await sys.run(cli, out!);
  if ((await sys.run(cli, login!)) !== 0) { ui.fail("The sign-in didn't finish."); return null; }
  const r = await sys.exec(cli, whoami!);
  return r.stdout.trim().replace(/\s+/g, " ").replace(/^Logged in as\s+/i, "") || "your account";
}

/** What will be created and who pays, shown once before anything happens. */
async function planRows(d: Deploy): Promise<Array<[string, string]>> {
  const host = HOSTS.find((h) => h.id === d.platform)!.name;
  if (d.platform === "fly") {
    return [
      ["Host", `${host}, as ${d.account}`],
      ["App", d.appName],
      ["Address", `https://${d.appName}.fly.dev`],
      ["Region", FLY_REGION],
      ["Volume", `${FLY_VOLUME}, 1 GB: keeps the WHOOP login across restarts`],
      ["Cost", "Fly bills your account for one small machine and the volume"],
    ];
  }
  if (d.platform === "railway") {
    return [
      ["Host", `${host}, as ${d.account}`],
      ["Project", d.appName],
      ["Address", "assigned by Railway, under up.railway.app"],
      ["Volume", "mounted at /data: keeps the WHOOP login across restarts"],
      ["Cost", "Railway bills your account for the service and the volume"],
    ];
  }
  const project = value(await gcloud(d, ["config", "get-value", "project"]));
  return [
    ["Host", `${host}, as ${d.account}`],
    ["Project", project || "(none selected)"],
    ["Service", `${d.appName} in ${CLOUD_RUN_REGION}, public, one instance kept warm`],
    ["Also", "turns on the Run, Build and Artifact Registry APIs, and lets Cloud Build use the default service account"],
    ["Storage", "none: after a restart or a new revision, log in again with totem auth"],
    ["Cost", "Google bills the project for the service and its builds"],
  ];
}

export interface CloudOptions {
  /** Show the host CLI's full output instead of a one-line progress. */
  verbose?: boolean;
}

export async function runCloudSetup(root: string, io: Io = realIo(), opts: CloudOptions = {}): Promise<number> {
  const { ui, sys } = io;
  const TOTAL = 6;
  ui.header("totem cloud", "Deploy your own totem server and connect your AI clients to it.");

  // This flow ends by writing the new server into .totem-deploy.json, over what
  // is there. For a server that is already deployed, that record is the only
  // copy of its MCP_AUTH_TOKEN on this computer (what `totem auth`, `status`
  // and `token` reach it with), and the server itself keeps running and
  // billing: don't replace it without asking.
  const existing = readDeployRecord(root);
  if (existing && existing.platform !== "local" && existing.url) {
    ui.warn(`This install already has a server at ${existing.url}.`);
    ui.hint("Deploying another makes this computer forget that one: its token leaves .totem-deploy.json, and the server keeps running until you remove it on its host. To deploy this install's code to it again: totem deploy");
    if (!(await ui.confirm("Deploy a new server anyway?", false))) {
      ui.hint("Nothing changed. To connect a client to the server: totem connect");
      return 1;
    }
  }

  ui.step(1, TOTAL, "Host");
  const platform = HOSTS[await ui.select("Where should the server run?", HOSTS.map((h) => ({ label: h.name, hint: h.hint })))]!.id;
  if (!(await prerequisites(root, io, false))) return 1;
  // What choosing the host's account has created before the plan is confirmed
  // (on Cloud Run: a new project, a billing link), in words for the person.
  const already: string[] = [];
  const host = await hostAccount(io, platform, already);
  if (!host) return 1;

  ui.step(2, TOTAL, "Secrets");
  const mcpToken = sys.token();
  let password = sys.password();
  let ownPassword = false;
  ui.ok("MCP_AUTH_TOKEN generated", "64 random characters; the server's own key");
  ui.ok("Connector password generated", "you get it at the end, once");
  ui.hint("Both are set on the server. The token is also kept in .totem-deploy.json (readable only by you), so totem auth can reach the server.");

  // No WHOOP tokens in the host's environment: the server starts without a
  // login, and step 5 sends one to its token file over POST /admin/tokens.
  const d: Deploy = {
    root, io, platform, verbose: Boolean(opts.verbose), cli: host.cli, account: host.account,
    env: { MCP_TRANSPORT: "http", MCP_AUTH_TOKEN: mcpToken, AUTH_PASSWORD: password },
    appName: platform === "custom" ? "totem" : `totem-${sys.token().slice(0, 6)}`,
  };

  ui.step(3, TOTAL, "Deploy");
  if (platform !== "custom") {
    for (;;) {
      ui.rows(await planRows(d));
      const pick = await ui.select("Deploy this?", [
        { label: "Deploy" },
        { label: "Change something", hint: "the name, the password, or the account" },
        { label: "Cancel", hint: already.length ? "no server is created" : "nothing has been created" },
      ]);
      if (pick === 0) break;
      if (pick === 2) {
        ui.hint(already.length ? `Cancelled. No server was created. Already done above, and left as it is: ${listOf(already)}.` : "Cancelled. Nothing was created.", 2);
        return 1;
      }
      d.appName = (await ui.text("Name", d.appName)).trim() || d.appName;
      for (;;) {
        const typed = await ui.hidden(`Connector password (Enter keeps ${ownPassword ? "yours" : "the generated one"})`);
        if (typed === "") break;
        const why = weakPassword(typed);
        if (why) { ui.hint(why, 2); continue; }
        // It is typed blind and totem never shows it afterwards: a slip of the
        // finger would set a password on the server that nobody knows.
        if ((await ui.hidden("The same password again")) !== typed) { ui.hint("Those two are not the same. Nothing changed.", 2); continue; }
        password = typed; ownPassword = true; d.env.AUTH_PASSWORD = typed;
        break;
      }
      if (await ui.confirm(`Sign in to ${HOSTS.find((h) => h.id === platform)!.name} as someone else?`, false)) {
        const account = await switchAccount(io, platform, d.cli, already);
        if (account) d.account = account;
      }
    }
  }

  const url = platform === "fly" ? await deployFly(d)
    : platform === "railway" ? await deployRailway(d)
    : platform === "cloudrun" ? await deployCloudRun(d)
    : await deployCustom(d);
  if (!url) {
    ui.problem("The server was not deployed.", { fix: [["Start over", "totem cloud"], ...(d.cleanup ? [d.cleanup] : [])] });
    return 1;
  }

  ui.step(4, TOTAL, "Check");
  const check = await verifyDeployment(io, url);
  // Record the deployment before anything else can stop the flow, so auth,
  // status and logs know where it is. d.appName, not the first suggestion: a
  // name conflict may have changed it.
  const extra: Partial<DeployRecord> = {};
  if (platform === "cloudrun") {
    extra.region = CLOUD_RUN_REGION;
    const project = value(await gcloud(d, ["config", "get-value", "project"]));
    if (project) extra.project = project;
  }
  writeDeployRecord(root, { platform, app: d.appName, url, ...extra, mcp_auth_token: mcpToken });
  const mcpUrl = `${url.replace(/\/+$/, "")}/mcp`;
  // The server has had the connector password since the deploy finished, and
  // this run is the only time totem can show it. A flow that stops before the
  // connect card must still hand it over: otherwise the person owns a server
  // that no client can sign in to.
  const handOverPassword = (): void => {
    if (ownPassword) return;
    const handedOver = sys.copy(password);
    ui.line();
    ui.rows([
      ["URL", ui.kit.c.accent(mcpUrl)],
      ["Password", `${ui.kit.c.bold(password)}${handedOver ? ui.kit.c.dim("  (copied to the clipboard)") : ""}`],
    ]);
    ui.hint("The connector password is already set on the server, and totem shows it this once. Save it in your password manager.", 2);
  };
  if (!check.healthy) {
    ui.problem("The deploy finished, but the server isn't answering.", {
      detail: "It may still be starting. Its logs say what it is doing.",
      fix: [["Read its logs", "totem logs"], ["Check it again", "totem ping"], ["Then log in", "totem auth"]],
    });
    handOverPassword();
    return 1;
  }
  // A totem server refuses /mcp without its token. Whatever answered some other
  // way is not one with its lock on (a mistyped address, a proxy's or a host's
  // own page that says 200 to everything): the WHOOP login, and the server's
  // token that goes with it, are not sent there.
  if (!check.locked) {
    ui.problem("totem didn't send a WHOOP login: this address isn't refusing /mcp without a token.", {
      detail: `A totem server answers 401 there. Check that ${url} is this server and nothing else, then log in.`,
      fix: [["Check the server", "totem status"], ["Then log in", "totem auth"]],
    });
    handOverPassword();
    return 1;
  }

  ui.step(5, TOTAL, "WHOOP login");
  const loggedIn = (await runAuth(root, [], { target: { kind: "remote", url, adminToken: mcpToken, platform }, embedded: true }, io)) === 0;
  if (!loggedIn) ui.warn("The server is up but has no WHOOP login yet.");

  ui.step(6, TOTAL, "Connect a client");
  const copied = !ownPassword && sys.copy(password);
  ui.lines(connectCard(ui.kit, sys, { target: { kind: "remote", mcpUrl }, password: ownPassword ? null : password, copied }));
  sys.openUrl("https://claude.ai/settings/connectors");
  ui.next([
    ...(loggedIn ? [] : ["First, finish the WHOOP login: totem auth", ""]),
    "1. Add the connector in claude.ai (its settings are opening in your browser).",
    `2. Ask it: ${FIRST_QUESTION}`,
    "",
    "See this again: totem connect",
    "Check the server: totem status",
  ]);
  return loggedIn ? 0 : 1;
}
