// Every screen of the CLI as a named scenario: a command line, the state of
// the fake world it runs in, and what the person answers. `render` turns one
// into the text a terminal would show. screens.test.ts snapshots the key ones
// and checks rules across all of them; the same list produces the review
// renders (text + terminal screenshots) when TOTEM_UX_OUT is set.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, type AppCtx } from "../../src/cli/app.js";
import { writeDeployRecord } from "../../src/cli/deploy_record.js";
import type { ExecResult } from "../../src/cli/sys.js";
import type { Style } from "../../src/cli/ui.js";
import { fakeWorld, linkDependencies, TOKEN, type FakeWorld, type WorldOptions } from "./helpers.js";

export interface Screen {
  name: string;
  /** The command line, as typed. */
  command: string;
  /** What this render shows. */
  about: string;
  world?: WorldOptions;
  /** Arrange the fake install before the command runs. */
  setup?: (world: FakeWorld) => void;
  /** The version the fake install reports. */
  version?: string;
}

export interface Rendered { text: string; code: number; commands: string[] }

export async function render(screen: Screen, style?: Style): Promise<Rendered> {
  const world = fakeWorld({ ...screen.world, ...(style ? { style } : {}) });
  try {
    screen.setup?.(world);
    const app: AppCtx = { root: world.root, version: screen.version ?? "1.5.1", pkgName: "@thebriangao/totem", pkgPath: join(world.root, "package.json"), cliEntry: join(world.root, "dist", "cli", "index.js") };
    const argv = screen.command.split(" ").slice(1);
    const code = await runCli(argv, app, world.io);
    return { text: world.transcript(), code, commands: world.commands.map((c) => c.split(world.home).join("/Users/you").replace(/\S+[\\/]node_modules[\\/]/g, "node_modules/")) };
  } finally {
    world.cleanup();
  }
}

// ── fake hosts ──────────────────────────────────────────────────────────────

const out = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const err = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr });

type Handler = NonNullable<WorldOptions["exec"]>;

const fly = (over: (args: string, world: FakeWorld) => ExecResult | undefined = () => undefined): Handler =>
  (cmd, args, _input, world) => {
    const a = args.join(" ");
    const special = over(a, world);
    if (special) return special;
    if (a === "auth whoami") return out("you@example.com\n");
    if (a.startsWith("volumes list")) return out("[]");
    if (a.startsWith("volumes create")) { world.clock.t += 4_000; return out("ID: vol_x\nName: totem_data\n"); }
    if (a.startsWith("deploy")) { world.clock.t += 102_000; return out("==> Building image\n--> Pushing image done\n✔ Machine 3d8d9c2f is now in a good state\n"); }
    return undefined;
  };

const railway: Handler = (cmd, args, _input, world) => {
  const a = args.join(" ");
  if (a === "whoami") return out("Logged in as you@example.com 👋\n");
  if (a.startsWith("up")) { world.clock.t += 9_000; return out("Build Logs: https://railway.com/project/x\n"); }
  if (a === "domain") return out("🚀 https://totem-c0ffee2-production.up.railway.app\n");
  return undefined;
};

const gcloud: Handler = (cmd, args, _input, world) => {
  const a = args.join(" ");
  if (a.startsWith("auth list")) return out("you@example.com\n");
  if (a === "config get-value project") return out("my-project\n");
  if (a.startsWith("projects list")) return out("my-project\nother-project\n");
  if (a.startsWith("billing projects describe")) return out("True\n");
  if (a.startsWith("run deploy")) { world.clock.t += 187_000; return out("Building using Dockerfile\nDeploying container to Cloud Run service\nDone.\n"); }
  if (a.startsWith("run services describe")) return out("https://totem-c0ffee2-abcdefghij-uw.a.run.app\n");
  return undefined;
};

const versions: Handler = (cmd, args, _input, world) => {
  const a = args.join(" ");
  if (cmd === "git" && a.startsWith("tag")) return out("v1.6.0\nv1.5.1\nv1.5.0\nv1.4.2\n");
  if (cmd === "git" && a.startsWith("for-each-ref")) return out("v1.6.0 2026-11-18 2026-11-18\nv1.5.1 2026-10-02 2026-10-02\nv1.5.0 2026-09-20 2026-09-20\nv1.4.2 2026-06-07 2026-06-07\n");
  if (cmd === "git" && a.startsWith("symbolic-ref")) return err("", 1);
  if (cmd === "git" && a.startsWith("rev-parse --abbrev-ref")) return out("HEAD\n");
  if (cmd === "git" && a.startsWith("rev-parse")) return out("3f2a9c1\n");
  if (cmd === "npm" && a === "install") { world.clock.t += 12_000; return out("added 3 packages in 12s\n"); }
  if (cmd === "/usr/local/bin/node") { world.clock.t += 6_000; return out(""); }
  if (cmd === "fly" && a.startsWith("deploy")) { world.clock.t += 98_000; return out("✔ Machine 3d8d9c2f is now in a good state\n"); }
  return undefined;
};
const releases = JSON.stringify([
  { tag_name: "v1.6.0", name: "v1.6.0", body: "Browser login, 40 tools", published_at: "2026-11-18T10:00:00Z" },
  { tag_name: "v1.5.1", name: "v1.5.1", body: "Fix .env quoting", published_at: "2026-10-02T10:00:00Z" },
  { tag_name: "v1.5.0", name: "v1.5.0", body: "Journal fixes", published_at: "2026-09-20T10:00:00Z" },
]);
const github: NonNullable<WorldOptions["http"]> = (url) => (url.includes("api.github.com") ? { status: 200, body: releases } : undefined);
/** A git checkout: the updater treats the install as one when .git exists. */
const gitCheckout = (world: FakeWorld): void => { mkdirSync(join(world.root, ".git")); };

const onFly = (world: FakeWorld): void => writeDeployRecord(world.root, { platform: "fly", app: "totem-a1b2c3", url: "https://totem-a1b2c3.fly.dev", mcp_auth_token: TOKEN });
const onLocal = (world: FakeWorld): void => writeDeployRecord(world.root, { platform: "local" });
const onCustom = (world: FakeWorld): void => writeDeployRecord(world.root, { platform: "custom", app: "totem", url: "https://whoop.example.com", mcp_auth_token: TOKEN });
const loggedIn = { state: "tokens" as const, source: "browser", savedAt: "2026-11-02T08:00:00.000Z", refreshedAt: "2026-11-21T20:00:00.000Z", accessExpiresAt: "2026-11-21T21:00:00.000Z", owner: null };
const down: NonNullable<WorldOptions["http"]> = (url) => (url.includes("api.github.com") ? undefined : { status: 0, body: "", ms: 3000, error: "ECONNREFUSED" });

export const SCREENS: Screen[] = [
  // ── help and errors ────────────────────────────────────────────────────
  { name: "help", command: "totem", about: "Bare `totem` and `totem help`." },
  { name: "help-auth", command: "totem auth --help", about: "Help for one command." },
  { name: "help-cloud", command: "totem help cloud", about: "Help for one command, the other way to ask." },
  { name: "help-update", command: "totem update --help", about: "Help for one command with options." },
  { name: "error-unknown-command", command: "totem staus", about: "A mistyped command: says so, suggests the nearest, exit 2." },
  { name: "error-not-set-up", command: "totem logs", about: "A server command before anything is set up." },
  { name: "tools", command: "totem tools", about: "The 40 tools, read from the real registry." },

  // ── local ──────────────────────────────────────────────────────────────
  { name: "local", command: "totem local", about: "Local setup, happy path: first run, Claude Desktop found.", setup: (w) => mkdirSync(join(w.home, "Library", "Application Support", "Claude"), { recursive: true }) },
  {
    name: "local-existing-login-claude-code", command: "totem local", about: "A second run to add Claude Code: the saved login is reused without asking.",
    world: { auth: { local: loggedIn }, answers: [["Which client?", 1]] },
  },
  { name: "local-other-client", command: "totem local", about: "A client totem doesn't know: prints what to paste.", world: { auth: { local: loggedIn }, answers: [["Which client?", 8]] } },
  { name: "local-login-failed", command: "totem local", about: "The browser window is closed before the login finishes.", world: { auth: { browser: "closed" } } },
  {
    name: "local-config-not-json", command: "totem local", about: "The client's config has comments: totem refuses to rewrite it and says what to add (bug hunt R3).",
    world: { auth: { local: loggedIn }, answers: [["Which client?", 2]] },
    setup: (w) => { mkdirSync(join(w.home, ".cursor")); writeFileSync(join(w.home, ".cursor", "mcp.json"), '{\n  // my servers\n  "mcpServers": { "github": { "command": "gh-mcp" } }\n}\n'); },
  },
  {
    name: "local-needs-build", command: "totem local", about: "A fresh checkout: dependencies and the build run with progress.",
    world: {
      unbuilt: true, auth: { local: loggedIn },
      exec: (cmd, _args, _i, w) => {
        if (cmd === "npm") { w.clock.t += 14_000; linkDependencies(w.root); return out("added 212 packages in 14s\n"); }
        if (cmd === "/usr/local/bin/node") { w.clock.t += 6_000; mkdirSync(join(w.root, "dist")); writeFileSync(join(w.root, "dist", "server.js"), ""); return out(""); }
        return undefined;
      },
    },
  },

  // ── cloud ──────────────────────────────────────────────────────────────
  { name: "cloud-fly", command: "totem cloud", about: "Cloud setup on Fly.io, happy path with a stubbed host.", world: { exec: fly() } },
  {
    name: "cloud-fly-deploy-failed", command: "totem cloud", about: "A failed step: the build fails on Fly; the person stops.",
    world: {
      exec: fly((a, w) => { if (a.startsWith("deploy")) { w.clock.t += 41_000; return { code: 1, stdout: "==> Building image\n#8 [builder 4/6] RUN npm ci\n#8 ERROR: process \"/bin/sh -c npm ci\" did not complete successfully: exit code 1\n", stderr: "Error: failed to fetch an image or build from source: error building: exit code 1\n" }; } return undefined; }),
      answers: [["What now?", 1]],
    },
  },
  { name: "cloud-cancelled", command: "totem cloud", about: "The plan is declined: nothing is created.", world: { exec: fly(), answers: [["Deploy this?", 2]] } },
  {
    name: "cloud-server-not-answering", command: "totem cloud", about: "The deploy works but the server never answers /health.",
    world: { exec: fly(), http: () => ({ status: 0, body: "", ms: 3000, error: "ENOTFOUND" }) },
  },
  { name: "cloud-railway", command: "totem cloud", about: "Cloud setup on Railway.", world: { exec: railway, answers: [["Where should the server run?", 1]] } },
  { name: "cloud-cloudrun", command: "totem cloud", about: "Cloud setup on Google Cloud Run.", world: { exec: gcloud, answers: [["Where should the server run?", 2]] } },
  {
    name: "cloud-custom", command: "totem cloud", about: "Cloud setup on your own Docker host.",
    world: { answers: [["Where should the server run?", 3], ["Public https URL", "totem.example.com"]] },
  },
  {
    name: "cloud-fly-cli-missing", command: "totem cloud", about: "The host's CLI isn't installed and the person declines to install it.",
    world: { missing: ["fly", "flyctl"], answers: [["Install it with Homebrew?", false], ["Install it with its install script?", false]] },
  },

  // ── connect ────────────────────────────────────────────────────────────
  { name: "connect-server", command: "totem connect", about: "What to paste where for every client, for a deployed server.", setup: onFly },
  { name: "connect-local", command: "totem connect --print", about: "The same card for a local install.", setup: onLocal },
  { name: "connect-cursor-local", command: "totem connect cursor", about: "Connect one more client to a local install.", setup: onLocal },
  { name: "connect-codex-server", command: "totem connect codex", about: "One client's steps for a deployed server.", setup: onFly },
  { name: "error-connect-unknown-client", command: "totem connect emacs", about: "A client totem doesn't know.", setup: onLocal },

  // ── auth ───────────────────────────────────────────────────────────────
  { name: "auth-local", command: "totem auth --local", about: "Browser login saved on this computer." },
  { name: "auth-server", command: "totem auth", about: "Auth success: browser login sent to the deployed server.", setup: onFly },
  { name: "auth-paste", command: "totem auth --paste --local", about: "Pasting the refresh-token cookie instead of using a browser.", world: { answers: [["Cookie value", "eyJ-refresh-token"]] } },
  { name: "auth-fail-browser-closed", command: "totem auth", about: "Auth failure: the browser window was closed.", world: { auth: { browser: "closed" } }, setup: onFly },
  { name: "auth-fail-timeout", command: "totem auth --local", about: "Nobody logged in for 15 minutes.", world: { auth: { browser: "timeout" } } },
  { name: "auth-fail-no-browser", command: "totem auth --local", about: "No supported browser, and nothing pasted.", world: { auth: { browser: "none" } } },
  { name: "auth-fail-rejected", command: "totem auth --local", about: "WHOOP refuses the new login.", world: { auth: { validate: { accepted: false, userId: null, status: 401 } } } },
  {
    name: "auth-fail-server-unreachable", command: "totem auth", about: "The login works but the server can't be reached.",
    world: { auth: { push: { ok: false, reason: "unreachable", httpStatus: null, detail: "fetch failed (ECONNREFUSED)" } } }, setup: onFly,
  },
  {
    name: "auth-fail-server-token", command: "totem auth", about: "The server rejects the recorded MCP_AUTH_TOKEN, and none is entered.",
    world: { auth: { push: { ok: false, reason: "unauthorized", httpStatus: 401, detail: "" } } }, setup: onFly,
  },
  { name: "auth-fail-insecure-url", command: "totem auth --url http://totem.example.com", about: "A plain-http server address is refused before anyone logs in." },
  { name: "auth-status-server", command: "totem auth --status", about: "Where the login lives, for a deployed server.", world: { auth: { local: { state: "handed-off", handedOffTo: "https://totem-a1b2c3.fly.dev", savedAt: "2026-11-20T09:00:00.000Z" } } }, setup: onFly },
  { name: "auth-status-local", command: "totem auth --status", about: "Where the login lives, for a local install.", world: { auth: { local: loggedIn } }, setup: onLocal },

  // ── status / ping / token ──────────────────────────────────────────────
  { name: "status-server", command: "totem status", about: "A healthy deployed server.", setup: onFly },
  { name: "status-server-down", command: "totem status", about: "The server isn't answering.", world: { http: down }, setup: onFly },
  { name: "status-local", command: "totem status", about: "A local install with a login.", world: { auth: { local: loggedIn } }, setup: onLocal },
  { name: "status-local-no-login", command: "totem status", about: "A local install with no WHOOP login.", setup: onLocal },
  { name: "status-not-set-up", command: "totem status", about: "Before anything is set up." },
  { name: "ping", command: "totem ping", about: "The server answers.", setup: onFly },
  { name: "ping-down", command: "totem ping", about: "The server doesn't answer.", world: { http: down }, setup: onFly },
  { name: "error-token-on-terminal", command: "totem token", about: "The token isn't printed to a terminal unless asked.", world: { tty: true }, setup: onFly },
  { name: "deploy-self-hosted", command: "totem deploy", about: "Deploying to a self-hosted server isn't something totem can do.", setup: onCustom },
  { name: "deploy-server", command: "totem deploy", about: "Deploying the install's code again (the host's own output streams between the lines).", setup: onFly },
  { name: "deploy-failed", command: "totem deploy", about: "The host's deploy command fails.", world: { run: () => 1 }, setup: onFly },
  { name: "error-logs-cli-missing", command: "totem logs", about: "The server was deployed from another machine: the host's CLI isn't here.", world: { missing: ["fly", "flyctl"] }, setup: onFly },
  { name: "status-server-host", command: "totem status --host", about: "Status with the host's own view (its output streams after the $ line).", setup: onFly },
  { name: "status-server-no-login", command: "totem status", about: "The server is up but its WHOOP login is gone.", world: { auth: { remoteStatus: { ok: true, status: { state: "expired", role: "owner", durable: true, detail: "WHOOP refused the refresh token" } } } }, setup: onFly },

  // ── update ─────────────────────────────────────────────────────────────
  { name: "update-check-available", command: "totem update --check", about: "Update available.", world: { exec: versions, http: github }, setup: gitCheckout },
  { name: "update-check-current", command: "totem update --check", about: "Already on the latest.", version: "1.6.0", world: { exec: versions, http: github }, setup: gitCheckout },
  { name: "update-local", command: "totem update", about: "Updating a local install.", world: { exec: versions, http: github }, setup: (w) => { gitCheckout(w); onLocal(w); } },
  { name: "update-server", command: "totem update", about: "Updating an install with a server on Fly: install, deploy, check.", world: { exec: versions, http: github }, setup: (w) => { gitCheckout(w); onFly(w); } },
  {
    name: "update-failed-step", command: "totem update", about: "A failed step: npm install fails, and totem goes back to the version it had (bug hunt R4).",
    world: {
      http: github,
      exec: (cmd, args, input, w) => (cmd === "npm" && args[0] === "install" && (w.counts.installs = (w.counts.installs ?? 0) + 1) === 1
        ? { code: 1, stdout: "", stderr: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/zod failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n" }
        : versions(cmd, args, input, w)),
    },
    setup: (w) => { gitCheckout(w); onLocal(w); },
  },
  { name: "update-older-version", command: "totem update", about: "Picking an older version, then declining.", world: { exec: versions, http: github, answers: [["Which version?", 2]] }, setup: gitCheckout },
  { name: "update-self-hosted", command: "totem update", about: "A self-hosted server: totem updates the install and prints the steps for the host.", world: { exec: versions, http: github }, setup: (w) => { gitCheckout(w); onCustom(w); } },
  { name: "update-offline", command: "totem update", about: "No releases can be listed.", world: { exec: () => ({ code: 1, stdout: "", stderr: "fatal: unable to access" }), http: () => ({ status: 0, body: "" }) }, setup: gitCheckout },
  { name: "update-auto-on", command: "totem update --auto on", about: "Turning auto-update on.", version: "1.6.0", world: { exec: versions, http: github }, setup: gitCheckout },
  { name: "update-auto-off", command: "totem update --auto off", about: "Turning auto-update off." },
  { name: "error-update-auto-usage", command: "totem update --auto maybe", about: "A bad value for --auto." },
  { name: "update-auto-run-log", command: "totem update --auto-run", about: "What the scheduled job writes to its log when a release is out.", world: { exec: versions, http: github }, setup: (w) => { gitCheckout(w); onLocal(w); } },
  {
    name: "update-auto-run-off-main", command: "totem update --auto-run", about: "The scheduled job on a feature branch: skipped (bug hunt R11).",
    world: { http: github, exec: (cmd, args, input, w) => (cmd === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD" ? out("v2-ux\n") : versions(cmd, args, input, w)) }, setup: gitCheckout,
  },
];

/** The screens the brief names: snapshot-tested one by one. */
export const KEY_SCREENS = ["help", "local", "cloud-fly", "auth-server", "auth-fail-browser-closed", "update-check-available", "cloud-fly-deploy-failed", "update-failed-step"];
