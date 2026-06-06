// Guided setup flows: `totem cloud` (server-hosted, OAuth, recommended) and
// `totem local` (stdio on this machine). These are the headline commands.
//
// Fly, Railway, and Cloud Run are all fully CLI-automated and tested end-to-end:
// the flow installs the host CLI if missing, logs you in, deploys, auto-detects
// the resulting URL, sets PUBLIC_URL, and verifies /health + OAuth are live — no
// copy-paste. Custom is a printed Docker guide for any other host or your own
// server. Either way it's one command to a working, Claude-connected deployment.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import {
  c, run, capture, captureAsync, commandExists, genToken, genPassword, copyToClipboard, httpGet,
  prompt, promptHidden, promptYesNo, select, confirmStep, step, closePrompts,
  withSpinner, spin, pause, maskArgs,
  runScript, ensureCli, openUrl,
} from "./ui.js";

// ── .env helpers ────────────────────────────────────────────────────────────
function envPath(root: string): string {
  return resolve(root, ".env");
}
function readEnv(root: string): Record<string, string> {
  const p = envPath(root);
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}
function upsertEnv(root: string, updates: Record<string, string>): void {
  const p = envPath(root);
  const lines = existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  // 0600 — this file holds the refresh token (and, transiently, the password).
  writeFileSync(p, lines.join("\n"), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best-effort */ }
}

// A user-chosen connector password gates public web/mobile access to the
// account. Require length + ≥2 character classes and reject obvious choices.
// (Pressing Enter for the auto-generated 18-char option is always strong.)
function weakPassword(pw: string): string | null {
  if (pw.length < 16) return "Use at least 16 characters (or press Enter to auto-generate).";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 2) return "Mix at least two of: lower, upper, digits, symbols (or press Enter to auto-generate).";
  if (/^(.)\1+$/.test(pw)) return "That's a single repeated character — pick something stronger.";
  if (/^(password|whoop|123456|qwerty|letmein)/i.test(pw)) return "That's too guessable — pick something stronger.";
  return null;
}

// Record of where we deployed, so `auth` can push rotated tokens to the right
// place later (or know it's a local install with nothing remote to update).
interface DeployRecord {
  platform: string;          // fly | railway | cloudrun | custom | local
  app?: string;              // app/project/service name (none for local)
  url?: string;
  region?: string;           // Cloud Run needs this to target the service
  project?: string;          // Cloud Run GCP project (for logs/status/refresh)
}
function writeDeployRecord(root: string, rec: DeployRecord): void {
  writeFileSync(resolve(root, ".totem-deploy.json"), JSON.stringify(rec, null, 2));
}

// ── shared: ensure dependencies are installed (offer to run npm install) ─────
// A published `npm install -g` already has node_modules; a fresh git checkout
// that never ran `npm install` does not — without it the build + auth steps
// would just error out. This keeps the flow zero-setup.
async function ensureDeps(root: string): Promise<boolean> {
  if (existsSync(resolve(root, "node_modules"))) return true;
  console.log(c.yellow("  Dependencies aren't installed yet."));
  if (!(await promptYesNo("Run `npm install` now?", true))) {
    console.log(c.red("  Can't continue without dependencies."));
    return false;
  }
  return (await run("npm", ["install"], { cwd: root })) === 0;
}

// ── shared: ensure we have Whoop tokens (run auth if not) ────────────────────
async function ensureAuth(root: string): Promise<boolean> {
  const env = readEnv(root);
  if (env.WHOOP_IOS_BEARER_TOKEN && env.WHOOP_COGNITO_REFRESH_TOKEN) {
    const reuse = await promptYesNo("Found existing Whoop tokens in .env. Reuse them?", true);
    if (reuse) return true;
  }
  // Need email + password in .env for the auth (cognito_bootstrap) script.
  if (!env.WHOOP_EMAIL) {
    const email = await promptRequired("Your Whoop account email", {
      validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "That doesn't look like an email address — try again."),
    });
    upsertEnv(root, { WHOOP_EMAIL: email });
  }
  if (!readEnv(root).WHOOP_PASSWORD) {
    const pw = await promptRequired("Your Whoop account password (stored only in local .env, used once)", { hidden: true });
    upsertEnv(root, { WHOOP_PASSWORD: pw });
  }
  console.log(c.gray("Authenticating with Whoop (you'll get an SMS code if your account has MFA)…"));
  // closePrompts so the auth script owns stdin for its own SMS prompt.
  closePrompts();
  // runScript prefers the compiled dist/ (works in a published install with no
  // tsx), falling back to tsx on source for a dev checkout. TOKENS_ONLY: the
  // guided flow handles the deploy itself, so the auth script must NOT push.
  const code = await runScript(root, "scripts/cognito_bootstrap", [], {
    env: { ...process.env, WHOOP_AUTH_TOKENS_ONLY: "1" },
  });
  if (code !== 0) { console.log(c.red("Auth failed.")); return false; }
  return true;
}

// ── prerequisites (guided preflight, consistent across every path) ────────────
// Each prerequisite is shown: already-satisfied ones are ✓'d and skipped; the
// rest are guided to completion. The whole list always runs, so you see exactly
// what was already set up vs. what we just did, then it returns to the flow.
interface Prereq {
  label: string;
  check: () => boolean | Promise<boolean>;
  ensure: () => Promise<boolean>;
}

async function preflight(prereqs: Prereq[]): Promise<boolean> {
  for (const p of prereqs) {
    if (await p.check()) { console.log(c.green(`  ✓ ${p.label}`)); continue; }
    console.log(c.yellow(`  • ${p.label} — setting it up`));
    if (!(await p.ensure())) { console.log(c.red(`  ✗ ${p.label} — couldn't complete; fix the above + re-run.`)); return false; }
    console.log(c.green(`  ✓ ${p.label}`));
  }
  return true;
}

// shared prerequisites ────────────────────────────────────────────────────────
const nodePrereq: Prereq = {
  label: `Node.js ≥ 24 (have ${process.version})`,
  check: () => Number(process.versions.node.split(".")[0] || "0") >= 24,
  ensure: async () => {
    console.log(c.gray("  Needs Node 24+. Upgrade (https://nodejs.org or `brew upgrade node`) and re-run."));
    return false;
  },
};
function depsPrereq(root: string): Prereq {
  return { label: "npm dependencies", check: () => existsSync(resolve(root, "node_modules")), ensure: () => ensureDeps(root) };
}
function buildPrereq(root: string): Prereq {
  return {
    label: "server built (dist/)",
    check: () => existsSync(resolve(root, "dist", "server.js")),
    ensure: async () => {
      const tsc = resolve(root, "node_modules", ".bin", "tsc");
      if (!existsSync(tsc)) { console.log(c.gray("  No TypeScript compiler — run `npm install`, then re-run.")); return false; }
      return (await run(process.execPath, [tsc], { cwd: root })) === 0;
    },
  };
}

// host-CLI prerequisite (install on demand via ensureCli) ──────────────────────
function cliPrereq(label: string, name: string, install: { brewPkg?: string; npmPkg?: string; scriptUrl?: string; manualHint: string }): Prereq {
  return { label, check: () => commandExists(name), ensure: () => ensureCli(name, install) };
}

const flyPrereqs: Prereq[] = [
  {
    label: "Fly CLI (flyctl)",
    check: () => commandExists("fly") || commandExists("flyctl"),
    ensure: () => ensureCli("flyctl", { brewPkg: "flyctl", scriptUrl: "https://fly.io/install.sh", manualHint: "brew install flyctl (or: curl -L https://fly.io/install.sh | sh)" }),
  },
  {
    label: "logged into Fly",
    check: () => capture(commandExists("fly") ? "fly" : "flyctl", ["auth", "whoami"]).code === 0,
    ensure: async () => (await run(commandExists("fly") ? "fly" : "flyctl", ["auth", "login"])) === 0,
  },
];

const railwayPrereqs: Prereq[] = [
  cliPrereq("Railway CLI", "railway", { npmPkg: "@railway/cli", brewPkg: "railway", manualHint: "npm i -g @railway/cli (or: brew install railway)" }),
  {
    label: "logged into Railway",
    check: () => capture("railway", ["whoami"]).code === 0,
    ensure: async () => (await run("railway", ["login"])) === 0,
  },
];

// gcloud needs more than a CLI: install → auth → account → project → billing.
// The CLI install + "at least one account" are pure prerequisites (below). The
// *which account / which project* decisions are choices the user must own, so
// they live in chooseGcloudTarget() and are offered on every run — never silently
// inheriting whatever happens to be active.
const gcloudPrereqs: Prereq[] = [
  {
    label: "gcloud SDK installed",
    check: () => commandExists("gcloud"),
    ensure: async () => {
      if (commandExists("brew") && await confirmStep("Install the gcloud SDK via Homebrew?", { cmd: "brew install --cask google-cloud-sdk", detail: "downloads + installs Google's CLI (~hundreds of MB)", defaultYes: true })) {
        await run("brew", ["install", "--cask", "google-cloud-sdk"]);
      }
      if (!commandExists("gcloud")) {
        if (await confirmStep("Install gcloud with Google's official script instead?", { cmd: "curl https://sdk.cloud.google.com | bash", detail: "runs a remote install script (follow its prompts)", defaultYes: true })) {
          await run("sh", ["-c", "curl https://sdk.cloud.google.com | bash"]);
        }
      }
      if (!commandExists("gcloud")) {
        console.log(c.yellow("  gcloud still isn't on PATH — open a new terminal and re-run `totem cloud`."));
        return false;
      }
      return true;
    },
  },
  {
    label: "authenticated with Google",
    check: () => capture("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]).stdout.trim().length > 0,
    ensure: async () => {
      if (!(await confirmStep("Sign into Google in your browser?", { cmd: "gcloud auth login", defaultYes: true }))) return false;
      return (await run("gcloud", ["auth", "login"])) === 0;
    },
  },
];

// Pick the Google account to deploy under (every run). gcloud can hold several
// authenticated accounts at once, so switching between EXISTING ones needs no
// logout — just `gcloud config set account`. Adding a new one runs `gcloud auth
// login` (the browser opens right here in the flow). Loops so a decline returns
// to the menu; verifies the active account before returning.
async function chooseGcloudAccount(): Promise<boolean> {
  for (;;) {
    const all = (await withSpinner("listing Google accounts", () => captureAsync("gcloud", ["auth", "list", "--format=value(account)"]))).stdout.trim().split("\n").filter(Boolean);
    const active = (await captureAsync("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"])).stdout.trim();
    const choices = all.map((a) => ({ label: a, hint: a === active ? "active" : undefined }));
    choices.push({ label: "Sign into a different Google account…", hint: undefined });
    const idx = await select("Which Google account should own this deployment?", choices, { defaultIndex: Math.max(0, all.indexOf(active)) });
    if (idx === all.length) {
      // Add an account — the browser sign-in happens right here, in-process.
      if (!(await confirmStep("Open a browser to sign into another Google account?", { cmd: "gcloud auth login", detail: "the browser sign-in happens right here in this flow", defaultYes: true }))) continue;
      if ((await run("gcloud", ["auth", "login"])) !== 0) {
        console.log(c.red("  ✗ Google sign-in didn't complete."));
        if (!(await promptYesNo("  Try again?", true))) return false;
      }
      continue; // re-list — the new account is now active; confirm it on the next pass
    }
    const picked = all[idx]!;
    if (picked !== active) {
      const set = await withSpinner(`switching to ${picked}`, () => captureAsync("gcloud", ["config", "set", "account", picked]));
      if (set.code !== 0) { console.log(c.red(`  ✗ couldn't switch to ${picked}: ${lastLine(set)}`)); continue; }
    }
    console.log(c.green(`  ✓ deploying as ${picked}`));
    return true;
  }
}

// Pick (or create) the GCP project. Marks the current one; creating a brand-new
// project is gated behind an explicit confirm (it's a real, billable resource).
async function chooseGcloudProject(): Promise<boolean> {
  const current = (await captureAsync("gcloud", ["config", "get-value", "project"])).stdout.trim().replace(/^\(unset\)$/, "");
  const projects = (await withSpinner("listing GCP projects", () => captureAsync("gcloud", ["projects", "list", "--format=value(projectId)"]))).stdout.trim().split("\n").filter(Boolean);
  const choices = projects.map((p) => ({ label: p, hint: p === current ? "current" : undefined }));
  choices.push({ label: "Create a new project…", hint: undefined });
  const idx = await select("Which GCP project should host the deployment?", choices, { defaultIndex: Math.max(0, projects.indexOf(current)) });
  let project: string;
  if (idx === projects.length) {
    let fresh = `totem-${genToken().slice(0, 6)}`;
    project = (await prompt("New project ID (lowercase, 6-30 chars, globally unique)", fresh)).trim() || fresh;
    // Retry with a new ID if creation fails (taken/invalid ID), surfacing the error.
    for (;;) {
      if (!(await confirmStep(`Create a new Google Cloud project '${project}'?`, { cmd: `gcloud projects create ${project}`, detail: "creates a real GCP project on your account", defaultYes: true }))) return false;
      if ((await run("gcloud", ["projects", "create", project])) === 0) break;
      console.log(c.red("  ✗ project creation failed — the error is shown above (usually the ID is taken or malformed)."));
      if (!(await promptYesNo("  Try a different project ID?", true))) return false;
      fresh = `totem-${genToken().slice(0, 6)}`;
      project = (await prompt("New project ID (lowercase, 6-30 chars, globally unique)", fresh)).trim() || fresh;
    }
  } else {
    project = projects[idx]!;
  }
  return (await withSpinner(`selecting ${project}`, () => captureAsync("gcloud", ["config", "set", "project", project]))).code === 0;
}

// Cloud Run requires billing on the chosen project. If you already have a billing
// account, we LINK it from the CLI right here, in-process. Only *creating* a
// billing account (adding a payment method) needs the web console — gcloud has no
// CLI for that anywhere — so that single step is handed off, with the page auto-opened.
async function ensureGcloudBilling(): Promise<boolean> {
  const p = (await captureAsync("gcloud", ["config", "get-value", "project"])).stdout.trim();
  const b = await withSpinner("checking billing", () => captureAsync("gcloud", ["billing", "projects", "describe", p, "--format=value(billingEnabled)"]));
  if (b.code === 0 && /true/i.test(b.stdout)) { console.log(c.green("  ✓ billing enabled")); return true; }

  // Link an existing OPEN billing account directly via the CLI (in-process).
  const accts = (await withSpinner("listing your billing accounts", () => captureAsync("gcloud", ["billing", "accounts", "list", "--filter=open=true", "--format=value(name)"]))).stdout.trim().split("\n").filter(Boolean);
  if (accts.length > 0) {
    const choices = accts.map((a) => ({ label: a }));
    choices.push({ label: "None of these — set one up in the console" });
    const idx = await select("Link which billing account to this project?", choices);
    if (idx < accts.length) {
      const acct = accts[idx]!;
      if (await confirmStep(`Link billing account ${acct} to ${p}?`, { cmd: `gcloud billing projects link ${p} --billing-account=${acct}`, detail: "enables billing on the project — done right here, no console", defaultYes: true })) {
        const link = await withSpinner("linking billing", () => captureAsync("gcloud", ["billing", "projects", "link", p, "--billing-account", acct]));
        if (link.code === 0) { console.log(c.green("  ✓ billing linked")); return true; }
        console.log(c.red(`  ✗ couldn't link billing: ${lastLine(link)}`));
      }
    }
  }

  // No usable billing account → the console is the only place to add a payment method.
  const url = `https://console.cloud.google.com/billing/linkedaccount?project=${p}`;
  console.log(c.yellow("  Add a payment method in the console (creating a billing account has no CLI)."));
  console.log(c.gray(`  Opening: ${url}`));
  openUrl(url);
  await promptYesNo("  Press Enter once billing is enabled", true);
  return true;
}

// The full Cloud Run target picker: account → project → billing. Always offered.
async function chooseGcloudTarget(): Promise<boolean> {
  console.log(c.gray("  Choose the account + project to deploy into:"));
  if (!(await chooseGcloudAccount())) return false;
  if (!(await chooseGcloudProject())) return false;
  return ensureGcloudBilling();
}

// Fly target picker: confirm the logged-in account or switch to another. The
// switch (logout + login) runs entirely in-process — `fly auth login` opens the
// browser right here. Loops on decline; verifies + shows the account afterward.
async function chooseFlyAccount(): Promise<boolean> {
  const fly = commandExists("fly") ? "fly" : "flyctl";
  for (;;) {
    const who = (await withSpinner("checking Fly account", () => captureAsync(fly, ["auth", "whoami"]))).stdout.trim();
    const idx = await select("Deploy under which Fly account?", [
      { label: who || "(current account)", hint: "current" },
      { label: "Switch to a different account…" },
    ]);
    if (idx === 0) { console.log(c.green(`  ✓ deploying as ${who || "(current account)"}`)); return true; }
    if (!(await confirmStep("Log out of Fly and sign in as a different account?", { cmd: `${fly} auth logout && ${fly} auth login`, detail: "the browser login happens right here in this flow", defaultYes: true }))) continue;
    await run(fly, ["auth", "logout"]);
    if ((await run(fly, ["auth", "login"])) !== 0) {
      console.log(c.red("  ✗ Fly login didn't complete."));
      if (!(await promptYesNo("  Try again?", true))) return false;
      continue;
    }
    const now = (await withSpinner("confirming Fly account", () => captureAsync(fly, ["auth", "whoami"]))).stdout.trim();
    console.log(c.green(`  ✓ now signed in to Fly as ${now || "(unknown)"}`));
    return true;
  }
}

// Railway target picker: confirm the logged-in account or switch to another.
// `railway login` runs in-process (browser / pairing happens right here). Loops
// on decline; verifies + shows the account afterward.
async function chooseRailwayAccount(): Promise<boolean> {
  for (;;) {
    const who = (await withSpinner("checking Railway account", () => captureAsync("railway", ["whoami"]))).stdout.trim().replace(/\s+/g, " ");
    const idx = await select("Deploy under which Railway account?", [
      { label: who || "(current account)", hint: "current" },
      { label: "Switch to a different account…" },
    ]);
    if (idx === 0) { console.log(c.green(`  ✓ deploying as ${who || "(current account)"}`)); return true; }
    if (!(await confirmStep("Log out of Railway and log in as a different account?", { cmd: "railway logout && railway login", detail: "the login happens right here in this flow", defaultYes: true }))) continue;
    await run("railway", ["logout"]);
    if ((await run("railway", ["login"])) !== 0) {
      console.log(c.red("  ✗ Railway login didn't complete."));
      if (!(await promptYesNo("  Try again?", true))) return false;
      continue;
    }
    const now = (await withSpinner("confirming Railway account", () => captureAsync("railway", ["whoami"]))).stdout.trim().replace(/\s+/g, " ");
    console.log(c.green(`  ✓ now signed in to Railway as ${now || "(unknown)"}`));
    return true;
  }
}

// ── LOCAL flow ───────────────────────────────────────────────────────────────
// ── local AI-client wiring (registry-driven) ────────────────────────────────
// Every stdio client takes the SAME launch entry — `{ command: <node>, args:
// [dist/server.js] }` — because the server self-loads the repo's .env. So adding
// a client is just a config path + a JSON key (or its own CLI); the entry never
// changes, only WHERE it's written.
interface LocalClient {
  label: string;
  hint: string;
  /** Wire this client; true if we wrote/ran it, false if the user must finish it. */
  wire: (node: string, serverJs: string) => Promise<boolean>;
}

// Merge { [key]: { [name]: entry } } into a JSON config without clobbering the
// user's other servers/settings. Idempotent.
function mergeJsonConfig(cfgPath: string, key: string, name: string, entry: Record<string, unknown>): void {
  let merged: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try { merged = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>; } catch { merged = {}; }
  }
  const bucket = (merged[key] as Record<string, unknown> | undefined) ?? {};
  merged[key] = { ...bucket, [name]: entry };
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
}

// A client wired by merging a JSON config file (most of them). `key` is the
// top-level object: "mcpServers" for Claude Desktop/Cursor/Gemini/Windsurf,
// "servers" (with a "type":"stdio" field) for VS Code.
function jsonClient(label: string, hint: string, relPath: string, key: "mcpServers" | "servers", restart: string): LocalClient {
  return {
    label, hint,
    wire: async (node, serverJs) => {
      const home = process.env.HOME ?? "~";
      const cfgPath = resolve(home, relPath);
      const entry: Record<string, unknown> = key === "servers"
        ? { type: "stdio", command: node, args: [serverJs] }
        : { command: node, args: [serverJs] };
      if (!(await promptYesNo(`Write the 'whoop' server into ${cfgPath}?`, true))) {
        console.log(c.gray("  Skipped — paste this into that file yourself:"));
        console.log(JSON.stringify({ [key]: { whoop: entry } }, null, 2));
        return false;
      }
      mergeJsonConfig(cfgPath, key, "whoop", entry);
      console.log(c.green(`  ✓ ${label} updated`) + c.gray(`  ${cfgPath}`));
      console.log(c.yellow(`  → ${restart}`));
      return true;
    },
  };
}

// Claude Code: wired by its own CLI.
const claudeCodeClient: LocalClient = {
  label: "Claude Code", hint: "run the one-line `claude mcp add`",
  wire: async (node, serverJs) => {
    const manual = `claude mcp add whoop ${node} ${serverJs}`;
    if (commandExists("claude")) {
      if (await promptYesNo("Run `claude mcp add whoop …` now?", true)) {
        if ((await run("claude", ["mcp", "add", "whoop", node, serverJs])) === 0) {
          console.log(c.green("  ✓ added to Claude Code"));
          return true;
        }
        console.log(c.yellow("  That didn't work — run it yourself:"));
        console.log(`  ${manual}`);
        return false;
      }
      console.log(c.gray("  Run it when ready:"));
      console.log(`  ${manual}`);
      return false;
    }
    console.log(c.gray("  The `claude` CLI isn't on PATH. Install Claude Code, then run:"));
    console.log(`  ${manual}`);
    return false;
  },
};

// Codex uses TOML — print the exact block (no fragile TOML merge/parse).
const codexClient: LocalClient = {
  label: "Codex CLI", hint: "show the config.toml block to add",
  wire: async (node, serverJs) => {
    const home = process.env.HOME ?? "~";
    console.log("");
    console.log(c.gray(`  Add this to ${resolve(home, ".codex/config.toml")} and restart Codex:`));
    console.log("");
    console.log(`  [mcp_servers.whoop]`);
    console.log(`  command = ${JSON.stringify(node)}`);
    console.log(`  args = ${JSON.stringify([serverJs])}`);
    console.log("");
    return false;
  },
};

// Catch-all: print the universal stdio block for any other MCP client.
const showConfigClient: LocalClient = {
  label: "Other / show the config", hint: "any MCP client — print the block",
  wire: async (node, serverJs) => {
    console.log("");
    console.log(c.gray('  Most MCP clients accept this (key is usually "mcpServers"; VS Code uses "servers" + "type":"stdio"):'));
    console.log(JSON.stringify({ mcpServers: { whoop: { command: node, args: [serverJs] } } }, null, 2));
    return false;
  },
};

const LOCAL_CLIENTS: LocalClient[] = [
  jsonClient("Claude Desktop", "write the config automatically", "Library/Application Support/Claude/claude_desktop_config.json", "mcpServers", "Quit and reopen Claude Desktop."),
  claudeCodeClient,
  jsonClient("Cursor", "write ~/.cursor/mcp.json", ".cursor/mcp.json", "mcpServers", "Reload Cursor (Settings → Tools & MCP)."),
  jsonClient("VS Code (Copilot)", "write the user mcp.json", "Library/Application Support/Code/User/mcp.json", "servers", "Reload VS Code; start the server in the MCP view."),
  jsonClient("Gemini CLI", "write ~/.gemini/settings.json", ".gemini/settings.json", "mcpServers", "Restart the gemini CLI."),
  codexClient,
  jsonClient("Windsurf", "write ~/.codeium/windsurf/mcp_config.json", ".codeium/windsurf/mcp_config.json", "mcpServers", "Reload Windsurf (Cascade → refresh MCP)."),
  showConfigClient,
];

export async function runLocalSetup(root: string): Promise<number> {
  console.log(c.bold("\ntotem · local setup") + c.gray(" — run the MCP on this machine over stdio\n"));
  const TOTAL = 3;
  const serverJs = resolve(root, "dist", "server.js");

  step(1, TOTAL, "Prerequisites");
  if (!(await preflight([nodePrereq, depsPrereq(root), buildPrereq(root)]))) return 1;

  step(2, TOTAL, "Whoop authentication");
  if (!(await ensureAuth(root))) return 1;
  console.log(c.green("  ✓ tokens in .env"));
  // Record this as a local install (overriding any stale cloud record) so
  // `auth` knows the tokens just go to .env — no remote to push to.
  writeDeployRecord(root, { platform: "local" });

  step(3, TOTAL, "Wire into your AI client");
  const idx = await select("Which client?", LOCAL_CLIENTS.map((cl) => ({ label: cl.label, hint: cl.hint })));
  const wired = await LOCAL_CLIENTS[idx]!.wire(process.execPath, serverJs);

  if (wired) {
    console.log(c.green("\n✓ Local setup complete.") + c.gray(" Restart the client, then ask: \"how am I doing today on whoop?\"\n"));
  } else {
    console.log(c.yellow("\n→ Almost done.") + c.gray(" Finish the step above + restart your client, then ask: \"how am I doing today on whoop?\"\n"));
  }
  closePrompts();
  return 0;
}

// ── CLOUD flow ─────────────────────────────────────────────────────────────
interface DeployCtx {
  root: string;
  env: Record<string, string>; // everything except PUBLIC_URL
  appName: string;
  password: string;
}

export async function runCloudSetup(root: string): Promise<number> {
  console.log(c.bold("\ntotem · cloud setup") + c.gray(" — deploy a server + connect it to Claude (web, desktop, mobile)\n"));
  const TOTAL = 6;
  if (!(await preflight([nodePrereq, depsPrereq(root)]))) return 1;

  step(1, TOTAL, "Whoop authentication");
  if (!(await ensureAuth(root))) return 1;
  const env = readEnv(root);
  console.log(c.green("  ✓ tokens ready"));

  step(2, TOTAL, "Choose a host");
  const platformIdx = await select("Where should the server run?", [
    { label: "Fly.io", hint: "fast-booting micro-VMs on a global edge network" },
    { label: "Railway", hint: "polished PaaS, instant deploys + a clean dashboard" },
    { label: "Google Cloud Run", hint: "Google Cloud's serverless containers, one instance kept warm" },
    { label: "Custom / own server", hint: "bring your own Docker host — a VPS, Render, a home server" },
  ]);
  const platforms = ["fly", "railway", "cloudrun", "custom"] as const;
  const platform = platforms[platformIdx]!;

  // Per-host prerequisites (install the CLI, log in) — guided, auto-skipping
  // whatever you already have, BEFORE we generate secrets or deploy.
  const hostPrereqs = platform === "fly" ? flyPrereqs
    : platform === "railway" ? railwayPrereqs
    : platform === "cloudrun" ? gcloudPrereqs
    : [];
  if (hostPrereqs.length && !(await preflight(hostPrereqs))) return 1;

  // Account / project selection — always offered, never silently inheriting
  // whatever account or GCP project happens to be active. (Custom self-host has
  // no account concept.)
  const targetOk = platform === "fly" ? await chooseFlyAccount()
    : platform === "railway" ? await chooseRailwayAccount()
    : platform === "cloudrun" ? await chooseGcloudTarget()
    : true;
  if (!targetOk) { console.log(c.red("  Couldn't set the deploy target.")); closePrompts(); return 1; }

  step(3, TOTAL, "Generate secrets");
  const mcpToken = genToken();
  console.log(`  MCP_AUTH_TOKEN: ${c.gray(mcpToken.slice(0, 12) + "… (generated)")}`);
  console.log(c.gray("  Connector password — you'll paste this into Claude once when adding the server."));
  console.log(c.gray("  Press Enter to auto-generate a secure 18-char one, or type your own (min 16)."));
  const useGenerated = (pw: string): string => {
    const copied = copyToClipboard(pw);
    console.log(`  ${c.green("✓")} generated: ${c.bold(pw)}${copied ? c.green("   ✓ copied to clipboard") : c.gray("   (copy it now)")}`);
    if (copied) console.log(c.gray("    (clear your clipboard after pasting — clipboard-history apps retain it)"));
    return pw;
  };
  let password = await prompt("Password (Enter = auto-generate)");
  if (password === "") {
    password = useGenerated(genPassword(18));
  } else {
    let why = weakPassword(password);
    while (why) {
      console.log(c.red(`  ${why}`));
      password = await prompt("Password (Enter = auto-generate)");
      if (password === "") { password = useGenerated(genPassword(18)); break; }
      why = weakPassword(password);
    }
  }

  const baseEnv: Record<string, string> = {
    WHOOP_EMAIL: env.WHOOP_EMAIL ?? "",
    WHOOP_IOS_BEARER_TOKEN: env.WHOOP_IOS_BEARER_TOKEN ?? "",
    WHOOP_COGNITO_REFRESH_TOKEN: env.WHOOP_COGNITO_REFRESH_TOKEN ?? "",
    MCP_TRANSPORT: "http",
    MCP_AUTH_TOKEN: mcpToken,
    AUTH_PASSWORD: password,
    WHOOP_TOKEN_STORE: "memory",
  };
  if (env.WHOOP_USER_ID) baseEnv.WHOOP_USER_ID = env.WHOOP_USER_ID;

  step(4, TOTAL, `Deploy to ${platform}`);
  const defaultName = `totem-${genToken().slice(0, 6)}`;
  let appName = "totem";
  if (platform !== "custom") {
    console.log(c.gray("  App name is optional — press Enter to use the suggested one in [brackets],"));
    console.log(c.gray("  or type your own (must be globally unique on the host)."));
    appName = await prompt("App name (Enter = use suggested)", defaultName);
  }
  const ctx: DeployCtx = { root, env: baseEnv, appName, password };

  let url: string | null = null;
  if (platform === "fly") url = await deployFly(ctx);
  else if (platform === "railway") url = await deployRailway(ctx);
  else if (platform === "cloudrun") url = await deployCloudRun(ctx);
  else url = await deployCustom(ctx);

  if (!url) {
    console.log(c.yellow("\nDeploy didn't complete automatically. Follow the steps above, then re-run `totem cloud` or set PUBLIC_URL + redeploy manually."));
    closePrompts();
    return 1;
  }

  step(5, TOTAL, "Verify the server + OAuth are live");
  const ok = await verifyDeployment(url);
  if (!ok) {
    console.log(c.yellow("  Couldn't confirm the OAuth endpoints yet (the host may still be starting). Give it a minute, then run `totem ping`."));
  }
  // Use ctx.appName, not the local appName: a Fly name conflict may have changed
  // it during deploy, and `auth` must push to the app that was actually used.
  const extra: Partial<DeployRecord> = {};
  if (platform === "cloudrun") {
    extra.region = "us-west1";
    const proj = capture("gcloud", ["config", "get-value", "project"]).stdout.trim();
    if (proj) extra.project = proj;
  }
  writeDeployRecord(root, { platform, app: ctx.appName, url, ...extra });

  step(6, TOTAL, "Connect your AI");
  printConnectInstructions(url, password, mcpToken);
  closePrompts();
  return 0;
}

// ── verification ─────────────────────────────────────────────────────────────
async function verifyDeployment(baseUrl: string): Promise<boolean> {
  const root = baseUrl.replace(/\/(mcp)?$/, "");
  // Poll fast: a short per-attempt timeout means a not-yet-propagated DNS / cold
  // start fails in ~3s instead of hanging the full 12s default, and a tight 1.5s
  // interval detects readiness within ~1.5s of the host coming up. (Previously a
  // 12s timeout × 3s sleep × 10 made this feel like ~3 minutes.)
  const start = Date.now();
  const deadline = start + 90_000;
  let healthy = false;
  // Live elapsed counter so a slow DNS-propagation / cold-start wait visibly ticks.
  const s = spin(() => `waiting for ${root} (DNS + first boot) — ${Math.floor((Date.now() - start) / 1000)}s`);
  while (Date.now() < deadline) {
    const health = await httpGet(`${root}/health`, 3000);
    if (health.status === 200) { healthy = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  s.stop();
  console.log(`  /health: ${healthy ? c.green("200 ✓") : c.red("timeout")}`);
  const prm = await withSpinner("checking OAuth metadata", () => httpGet(`${root}/.well-known/oauth-protected-resource/mcp`, 5000));
  const prmOk = prm.status === 200 && prm.body.includes("/mcp");
  console.log(`  OAuth metadata: ${prmOk ? c.green("✓") : c.red("not found")}`);
  // Prove the auth gate is live: an unauthenticated /mcp must be REJECTED (401),
  // not served. Catches a regression that left the endpoint open to the public.
  const gate = await withSpinner("checking /mcp is auth-gated", () => httpGet(`${root}/mcp`, 5000));
  const gated = gate.status === 401;
  console.log(`  /mcp auth gate: ${gated ? c.green("401 ✓ (rejects unauthenticated)") : c.red(`${gate.status || "no response"} — expected 401`)}`);
  return healthy && prmOk && gated;
}

function printConnectInstructions(url: string, password: string, mcpToken: string): void {
  const mcpUrl = url.replace(/\/$/, "") + "/mcp";
  // Header-auth clients (CLIs / editors) hit the server directly with the static
  // bearer token; OAuth clients (claude.ai, ChatGPT) use the password gate.
  const headerBlock = JSON.stringify(
    { mcpServers: { whoop: { url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } },
    null, 2,
  ).split("\n").map((l) => "    " + l).join("\n");
  console.log("");
  console.log(c.bold("  ── Connect your AI ──────────────────────────────────────────"));
  console.log("");
  console.log(c.bold("  claude.ai") + c.gray("  (web · desktop · mobile — syncs across your devices)"));
  console.log(`    Settings → Connectors → ${c.bold("Add custom connector")}`);
  console.log(`    URL: ${c.brand(mcpUrl)}    Password: ${c.brand(password)}`);
  console.log("");
  console.log(c.bold("  ChatGPT") + c.gray("  (desktop)"));
  console.log(`    Settings → Connectors → ${c.bold("Add")}  ·  URL: ${c.brand(mcpUrl)}    Password: ${c.brand(password)}`);
  console.log("");
  console.log(c.bold("  Claude Code") + c.gray("  (remote)"));
  console.log(`    ${c.gray("$")} claude mcp add --transport http whoop ${mcpUrl} --header "Authorization: Bearer ${mcpToken}"`);
  console.log("");
  console.log(c.bold("  Cursor · Windsurf · any HTTP MCP client") + c.gray("  — config block:"));
  console.log(headerBlock);
  console.log("");
  // Best-effort: open the connectors page in the browser (cross-platform).
  openUrl("https://claude.ai/settings/connectors");
  console.log(c.gray("  (opened the claude.ai connectors page in your browser)"));
  console.log(c.green("\n✓ Cloud setup complete.\n"));
}

// ── platform adapters ────────────────────────────────────────────────────────

function setSummary(env: Record<string, string>): void {
  console.log(c.gray("  env to set: " + Object.keys(env).join(", ")));
}

// ── shared failure handling ──────────────────────────────────────────────────
// The last meaningful line of a captured (spinner-wrapped) command's output —
// so when a step that DIDN'T stream live fails, we can still show WHY.
function lastLine(r: { stdout: string; stderr: string }): string {
  const lines = (r.stderr + "\n" + r.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : "unknown error";
}

// Run an inherited-stdio action (its error is already printed on screen by the
// tool) and, on failure, let the user retry it or give up. Loops until success
// or the user declines. Returns true once it succeeds.
async function runWithRetry(desc: string, action: () => Promise<number>): Promise<boolean> {
  for (;;) {
    console.log(c.gray(`  ${desc}…`));
    if ((await action()) === 0) return true;
    console.log(c.red("  ✗ that failed — the error is shown above."));
    if (!(await promptYesNo("  Retry it?", true))) return false;
  }
}

// Ask for a public URL, re-asking (with a clear reason) on empty or malformed
// input instead of bailing the whole flow. Accepts a bare domain (prepends
// https://) and strips trailing slashes. Ctrl-C is the only way out.
async function promptUrl(message: string): Promise<string> {
  const tty = Boolean(process.stdin.isTTY);
  for (;;) {
    let url = (await prompt(message)).trim();
    if (url) {
      if (!/^https?:\/\//i.test(url)) url = "https://" + url; // accept a bare domain
      if (/^https?:\/\/[^/.\s]+\.[^/\s]+/.test(url)) return url.replace(/\/+$/, "");
      console.log(c.red(`  '${url}' isn't a valid URL (e.g. https://whoop.example.com) — try again.`));
    } else {
      console.log(c.red("  A URL is required — paste it, or press Ctrl-C to cancel."));
    }
    // No interactive terminal (piped/EOF) → "" forever; don't spin, just stop.
    if (!tty) { console.log(c.red("  (no terminal to re-ask on — stopping.)")); process.exit(1); }
  }
}

// Ask for a required free-text value, re-asking (with a reason) on empty or
// invalid input instead of bailing the flow. Optional validator returns an error
// string to show + re-ask, or null when the value is good. Ctrl-C is the way out.
async function promptRequired(message: string, opts: { validate?: (v: string) => string | null; hidden?: boolean } = {}): Promise<string> {
  const tty = Boolean(process.stdin.isTTY);
  for (;;) {
    const v = (await (opts.hidden ? promptHidden(message) : prompt(message))).trim();
    if (v) {
      const err = opts.validate ? opts.validate(v) : null;
      if (!err) return v;
      console.log(c.red(`  ${err}`));
    } else {
      console.log(c.red("  Required — enter a value, or press Ctrl-C to cancel."));
    }
    if (!tty) { console.log(c.red("  (no terminal to re-ask on — stopping.)")); process.exit(1); }
  }
}

// FLY — deploys as fast-booting micro-VMs via flyctl.

// Create the Fly app, retrying with a new name when the chosen one is taken by
// ANOTHER account (Fly app names are globally unique). If you already own an app
// by that name, reuse it. Mutates ctx.appName to whatever name actually worked.
async function createFlyApp(fly: string, ctx: DeployCtx): Promise<boolean> {
  if (!(await confirmStep(`Create Fly app '${ctx.appName}'?`, { cmd: `fly apps create ${ctx.appName}`, detail: "reserves the name + URL on your Fly account", defaultYes: true }))) return false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const create = await withSpinner(`creating ${ctx.appName}`, () => captureAsync(fly, ["apps", "create", ctx.appName, "--json"]));
    if (create.code === 0) { console.log(c.green(`  ✓ created ${ctx.appName}`)); return true; }
    // Already on YOUR account? (re-running cloud, or a half-finished prior attempt) → reuse it.
    const mine = await withSpinner("checking your Fly apps", () => captureAsync(fly, ["apps", "list"]));
    if (new RegExp(`(^|\\s)${ctx.appName}(\\s|$)`, "m").test(mine.stdout)) {
      console.log(c.gray(`  '${ctx.appName}' already exists on your account — reusing it.`));
      return true;
    }
    // Taken by someone else (or another error): SHOW it, then retry with a new name.
    console.log(c.red(`  ✗ couldn't create '${ctx.appName}': ${lastLine(create)}`));
    console.log(c.yellow("  Fly app names are globally unique, so that one's unavailable — pick another."));
    const fresh = `totem-${genToken().slice(0, 6)}`;
    ctx.appName = (await prompt("New app name (Enter = unique suggestion)", fresh)).trim() || fresh;
  }
  console.log(c.red("  Too many name attempts — aborting the Fly deploy."));
  return false;
}

async function deployFly(ctx: DeployCtx): Promise<string | null> {
  const fly = commandExists("fly") ? "fly" : "flyctl";

  if (!(await createFlyApp(fly, ctx))) return null;
  const url = `https://${ctx.appName}.fly.dev`;
  const env = { ...ctx.env, PUBLIC_URL: url };

  // Minimal fly.toml so `fly deploy` is non-interactive (builds the Dockerfile).
  writeFileSync(resolve(ctx.root, "fly.toml"), [
    `app = "${ctx.appName}"`,
    `primary_region = "sjc"`,
    ``,
    `[build]`,
    ``,
    `[http_service]`,
    `  internal_port = 3000`,
    `  force_https = true`,
    `  # Keep one machine warm so the connector never cold-starts — the first`,
    `  # request after an auto-stop would otherwise fail while the VM boots (~10s).`,
    `  auto_stop_machines = "suspend"`,
    `  auto_start_machines = true`,
    `  min_machines_running = 1`,
    ``,
  ].join("\n"));
  // Set secrets (staged; applied on deploy) — surface the error if it fails.
  // `secrets import` reads KEY=val from stdin, keeping the token + password
  // values off the argv (which any local user could read via `ps`/`/proc`).
  const secretLines = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const stage = await withSpinner("staging secrets", () => captureAsync(fly, ["secrets", "import", "--stage", "--app", ctx.appName], { cwd: ctx.root, input: secretLines }));
  if (stage.code !== 0) {
    console.log(c.yellow(`  staging secrets failed (${lastLine(stage)}) — applying directly`));
    const direct = await withSpinner("setting secrets", () => captureAsync(fly, ["secrets", "import", "--app", ctx.appName], { cwd: ctx.root, input: secretLines }));
    if (direct.code !== 0) console.log(c.red(`  ✗ couldn't set secrets: ${lastLine(direct)}`));
  }
  // Build + deploy — error visible (inherited stdio) + retry-on-failure.
  if (!(await confirmStep("Build + deploy to Fly now?", { cmd: `fly deploy --app ${ctx.appName}`, detail: "builds the Dockerfile and starts a billable machine (~1-2 min)", defaultYes: true }))) return null;
  if (!(await runWithRetry(`deploying ${ctx.appName} (builds the Dockerfile, ~1-2 min)`, () => run(fly, ["deploy", "--app", ctx.appName, "--ha=false"], { cwd: ctx.root })))) return null;
  return url;
}

// Shared "assisted" deploy used by Railway + Cloud Run: install/login the host
// CLI, run its deploy commands (each retryable), auto-detect the deployed URL
// (falling back to a paste only if detection fails), then set PUBLIC_URL for OAuth.
async function assistedDeploy(opts: {
  cliName: string;
  install: { brewPkg?: string; npmPkg?: string; scriptUrl?: string; manualHint: string };
  loginCheck: () => boolean;
  loginCmd: () => Promise<number>;
  steps: Array<{
    desc: string;
    cmd?: [string, string[]];
    run?: () => Promise<boolean>;
    retries?: number;
    // Sensitive steps (IAM, API enablement, billable deploys) gate behind a
    // confirm. `skippable` steps continue when declined (e.g. an IAM grant that
    // may already be in place); non-skippable ones abort the whole deploy.
    confirm?: { summary: string; detail?: string; cmd?: string; defaultYes?: boolean; skippable?: boolean };
  }>;
  getUrl?: () => Promise<string | null>;
  setPublicUrlCmds: (url: string) => Array<[string, string[]]>;
  ctx: DeployCtx;
}): Promise<string | null> {
  if (!commandExists(opts.cliName)) {
    if (!(await ensureCli(opts.cliName, opts.install))) return null;
  }
  if (!opts.loginCheck()) {
    console.log(c.gray(`  Logging into ${opts.cliName}…`));
    if (await opts.loginCmd() !== 0) return null;
  }
  setSummary(opts.ctx.env);
  for (const s of opts.steps) {
    if (s.confirm) {
      const proceed = await confirmStep(s.confirm.summary, s.confirm);
      if (!proceed) {
        if (s.confirm.skippable) { console.log(c.gray(`  ↷ skipped: ${s.desc}`)); continue; }
        console.log(c.yellow("  Cancelled — this step is required, stopping here.")); return null;
      }
    }
    console.log(c.gray(`  → ${s.desc}`));
    const tries = (s.retries ?? 0) + 1;
    let ok = false;
    for (let i = 0; i < tries && !ok; i++) {
      if (i > 0) { console.log(c.yellow(`    API hiccup — retry ${i}/${s.retries}`)); await pause(2500, "backing off before retry"); }
      if (s.run) ok = await s.run();
      else { console.log(c.gray(`    $ ${s.cmd![0]} ${maskArgs(s.cmd![1])}`)); ok = (await run(s.cmd![0], s.cmd![1], { cwd: opts.ctx.root })) === 0; }
    }
    // Auto-retries (above) exhausted and still failing: surface it + let the user
    // retry as many times as they like, skip it, or abort. The error is already
    // on screen (inherited stdio).
    while (!ok) {
      console.log(c.red(`  ✗ step failed: ${s.desc} — the error is shown above.`));
      const choice = await select("How do you want to handle it?", [
        { label: "Retry this step" },
        { label: "Skip it and continue", hint: "you'll fix it manually" },
        { label: "Abort the deploy" },
      ]);
      if (choice === 0) {
        if (s.run) ok = await s.run();
        else { console.log(c.gray(`    $ ${s.cmd![0]} ${maskArgs(s.cmd![1])}`)); ok = (await run(s.cmd![0], s.cmd![1], { cwd: opts.ctx.root })) === 0; }
      } else if (choice === 1) { console.log(c.gray(`  ↷ skipped: ${s.desc}`)); break; }
      else { return null; }
    }
  }
  // Auto-detect the deployed URL (the deploy just printed it); only fall back to
  // asking the user to paste if detection failed.
  const detected = opts.getUrl ? await opts.getUrl() : null;
  let url: string;
  if (detected) {
    url = detected.replace(/\/+$/, "");
    console.log(c.green(`  ✓ detected URL: ${url}`));
  } else {
    url = await promptUrl("Paste your deployment's public URL (e.g. https://your-app.up.railway.app)");
  }
  // OAuth's issuer must equal the real URL, which we only know now — so set
  // PUBLIC_URL and redeploy automatically (run() inherits stdio → the user sees
  // progress) rather than asking them to run a command in a second terminal.
  if (!(await confirmStep("Set PUBLIC_URL and redeploy so OAuth works?", { detail: `points the server's OAuth issuer at ${url} (required for web/mobile connectors)`, defaultYes: true }))) {
    console.log(c.yellow(`  Skipped. OAuth won't work until you set PUBLIC_URL=${url} and redeploy yourself.`));
    return url;
  }
  console.log(c.gray("  Setting PUBLIC_URL + redeploying so OAuth works…"));
  for (const [cmd, args] of opts.setPublicUrlCmds(url)) {
    console.log(c.gray(`    $ ${cmd} ${args.join(" ")}`));
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      if (i > 0) { console.log(c.yellow(`    API hiccup — retry ${i}/3`)); await pause(2500, "backing off before retry"); }
      ok = (await run(cmd, args, { cwd: opts.ctx.root })) === 0;
    }
    while (!ok) {
      console.log(c.red("  ✗ that command failed — the error is shown above."));
      const choice = await select("How do you want to handle it?", [
        { label: "Retry it" },
        { label: "Skip and continue", hint: "OAuth won't work until you set PUBLIC_URL yourself" },
        { label: "Abort" },
      ]);
      if (choice === 0) ok = (await run(cmd, args, { cwd: opts.ctx.root })) === 0;
      else if (choice === 1) break;
      else return null;
    }
  }
  return url;
}

// Railway's GraphQL API (backboard.railway.com) intermittently times out, and a
// timed-out `init` can still create the project server-side. So: try init, and if
// it fails, check whether the project got created and LINK to it instead of
// re-running init (which would pile up duplicate projects). Retries the flaky API.
async function railwayHasProject(appName: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const r = await withSpinner("checking Railway for the project", () => captureAsync("railway", ["list"]));
    if (r.code === 0) return r.stdout.includes(appName);
  }
  return false;
}

async function railwayInitOrLink(appName: string, root: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) { console.log(c.yellow(`    Railway API hiccup — retry ${attempt - 1}/3`)); await pause(2500, "backing off (Railway's API is flaky)"); }
    console.log(c.gray(`    $ railway init --name ${appName}`));
    if ((await run("railway", ["init", "--name", appName], { cwd: root })) === 0) return true;
    // init's response may have timed out AFTER creating the project — link to it.
    if (await railwayHasProject(appName)) {
      console.log(c.gray("  (init's response timed out, but the project exists — linking to it)"));
      console.log(c.gray(`    $ railway link --project ${appName}`));
      if ((await run("railway", ["link", "--project", appName], { cwd: root })) === 0) return true;
    }
  }
  console.log(c.red("  Railway's API (backboard.railway.com) kept timing out. Give it a minute and re-run."));
  return false;
}

// RAILWAY — CLI-automatable; resilient to Railway's flaky GraphQL API.
async function deployRailway(ctx: DeployCtx): Promise<string | null> {
  // Railway rejects `--set KEY=` (empty value), and PUBLIC_URL isn't known until
  // `domain` runs — so set the non-empty vars now, PUBLIC_URL in the 2nd pass.
  const varArgs: string[] = ["variables"];
  for (const [k, v] of Object.entries(ctx.env)) {
    if (v === "") continue;
    varArgs.push("--set", `${k}=${v}`);
  }
  return assistedDeploy({
    cliName: "railway",
    install: { npmPkg: "@railway/cli", brewPkg: "railway", manualHint: "npm i -g @railway/cli  (or: brew install railway)" },
    loginCheck: () => capture("railway", ["whoami"]).code === 0,
    loginCmd: () => run("railway", ["login"]),
    steps: [
      // init creates a PROJECT (not a service); `up` creates the service, so it
      // runs first (deploys env-less + crashes once, then variables redeploys it
      // healthy). init is special — a timeout may have still created it, so we
      // link rather than re-init; the rest retry the flaky API.
      {
        desc: "create the project",
        run: () => railwayInitOrLink(ctx.appName, ctx.root),
        confirm: { summary: `Create a new Railway project '${ctx.appName}'?`, detail: "a new project on your Railway account", defaultYes: true },
      },
      {
        desc: "deploy (creates the service + builds the Dockerfile)",
        cmd: ["railway", ["up", "--detach"]],
        retries: 3,
        confirm: { summary: "Deploy to Railway now?", detail: "creates a service + starts a build on your Railway account", defaultYes: true },
      },
      { desc: "set environment variables (redeploys with them)", cmd: ["railway", varArgs], retries: 3 },
    ],
    getUrl: async () => {
      // `railway domain` prints "🚀 https://…up.railway.app" — capture + parse it
      // instead of asking the user to paste what we just printed.
      for (let i = 0; i < 4; i++) {
        if (i > 0) { console.log(c.yellow(`    API hiccup — retry ${i}/3`)); await pause(2500, "backing off before retry"); }
        const r = await withSpinner("fetching the public domain (railway domain)", () => captureAsync("railway", ["domain"], { cwd: ctx.root }));
        const m = `${r.stdout}\n${r.stderr}`.match(/https?:\/\/[a-z0-9.-]+\.up\.railway\.app/i);
        if (m) return m[0];
      }
      return null;
    },
    setPublicUrlCmds: (url) => [
      ["railway", ["variables", "--set", `PUBLIC_URL=${url}`]],
      ["railway", ["up", "--detach"]],
    ],
    ctx,
  });
}

// GOOGLE CLOUD RUN — gcloud, builds from source. Best-effort.
async function deployCloudRun(ctx: DeployCtx): Promise<string | null> {
  // Env vars go in a temp YAML file (--env-vars-file), NOT --set-env-vars: values
  // include an email (with `@`) and a random password, so any inline delimiter can
  // collide (the `^@^` form broke on the email's `@`). The file lives in the OS
  // temp dir — never the `--source` upload dir — and is deleted after. PUBLIC_URL
  // is set in the 2nd pass once the deployed URL is known.
  const envYaml = Object.entries(ctx.env)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n") + "\n";
  const envFile = resolve(tmpdir(), `totem-env-${randomUUID()}.yaml`);
  writeFileSync(envFile, envYaml, { mode: 0o600 });
  try {
    return await assistedDeploy({
      cliName: "gcloud",
      install: { manualHint: "install the gcloud SDK: https://cloud.google.com/sdk/docs/install" },
      loginCheck: () => capture("gcloud", ["config", "get-value", "project"]).stdout.trim().length > 0,
      loginCmd: async () => {
        const a = await run("gcloud", ["auth", "login"]);
        if (a !== 0) return a;
        console.log(c.gray("  Set your project: gcloud config set project <PROJECT_ID>"));
        await promptYesNo("Project set?", true);
        return 0;
      },
      steps: [
        {
          desc: "enable required APIs (run, cloudbuild, artifactregistry)",
          cmd: ["gcloud", ["services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com"]],
          confirm: { summary: "Enable the Cloud Run / Cloud Build / Artifact Registry APIs?", detail: "turns these APIs on for the selected project (one-time, idempotent)", cmd: "gcloud services enable run / cloudbuild / artifactregistry", defaultYes: true, skippable: true },
        },
        {
          // gcloud run deploy --source builds via the project's COMPUTE default
          // service account, which on new projects lacks build permissions
          // (PERMISSION_DENIED resolving the source). Grant the builder role.
          desc: "grant Cloud Build access to the default service account",
          cmd: ["sh", ["-c", 'P="$(gcloud config get-value project 2>/dev/null)"; N="$(gcloud projects describe "$P" --format=\'value(projectNumber)\' 2>/dev/null)"; gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:${N}-compute@developer.gserviceaccount.com" --role=roles/cloudbuild.builds.builder --condition=None']],
          confirm: { summary: "Grant the Cloud Build builder role to the compute service account?", detail: "modifies project IAM — needed for `--source` builds. Skip if you've already granted it.", cmd: "gcloud projects add-iam-policy-binding … --role=roles/cloudbuild.builds.builder", defaultYes: true, skippable: true },
        },
        {
          desc: "deploy from source (Cloud Build builds the Dockerfile)",
          cmd: ["gcloud", [
            "run", "deploy", ctx.appName,
            "--source", ".",
            "--region", "us-west1",
            "--allow-unauthenticated",
            "--port", "3000",
            "--min-instances", "1",
            "--env-vars-file", envFile,
            "--quiet",
          ]],
          confirm: { summary: `Build + deploy '${ctx.appName}' to Cloud Run (us-west1)?`, detail: "uploads source, runs Cloud Build, and creates a public service (may incur charges)", cmd: `gcloud run deploy ${ctx.appName} --source . --region us-west1`, defaultYes: true },
        },
      ],
      getUrl: async () => {
        // gcloud knows the service URL — fetch it instead of asking the user.
        const r = await withSpinner("fetching the Cloud Run service URL", () => captureAsync("gcloud", ["run", "services", "describe", ctx.appName, "--region", "us-west1", "--format=value(status.url)"]));
        const url = r.stdout.trim();
        return /^https?:\/\//.test(url) ? url : null;
      },
      setPublicUrlCmds: (url) => [
        ["gcloud", ["run", "services", "update", ctx.appName, "--region", "us-west1", "--update-env-vars", `PUBLIC_URL=${url}`, "--quiet"]],
      ],
      ctx,
    });
  } finally {
    try { rmSync(envFile); } catch { /* best-effort */ }
  }
}

// CUSTOM — run the container yourself on any Docker host. Writes a complete,
// ready-to-run env file (so the real secret values are usable, not truncated on
// screen) + prints the exact docker commands.
async function deployCustom(ctx: DeployCtx): Promise<string | null> {
  // All settings — including the full tokens + generated password — go into an
  // env file (chmod 600) instead of being printed (truncated + leaked) on screen.
  const envFile = resolve(ctx.root, ".env.deploy");
  const body =
    Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`).join("\n") +
    "\nPUBLIC_URL=https://CHANGE-ME-to-your-public-https-address\n";
  writeFileSync(envFile, body, { mode: 0o600 });

  console.log("");
  console.log(`  ${c.bold(c.white("Self-host it on any Docker host"))} ${c.gray("— a VPS, Render, your own box, whatever.")}`);
  console.log("");
  console.log(`  ${c.violet("1")}  ${c.white("Build the image")} ${c.gray("— the repo already has a Dockerfile:")}`);
  console.log(`        ${c.cyan("docker build -t totem .")}`);
  console.log("");
  console.log(`  ${c.violet("2")}  ${c.white("Your full config")} ${c.gray("(tokens + the generated password) was written to:")}`);
  console.log(`        ${c.brand(envFile)}  ${c.gray("(chmod 600 — keep it private)")}`);
  console.log(`        ${c.gray("Open it and set")} ${c.bold(c.white("PUBLIC_URL"))} ${c.gray("to the")} ${c.white("https:// address your server will live at")}`);
  console.log(`        ${c.gray("— you need a public domain/hostname with HTTPS. That same URL is what you paste below.")}`);
  console.log("");
  console.log(`  ${c.violet("3")}  ${c.white("Run it")} ${c.gray("(serves on port 3000):")}`);
  console.log(`        ${c.cyan(`docker run -d --restart unless-stopped -p 3000:3000 --env-file ${envFile} totem`)}`);
  console.log(`        ${c.gray("then put it behind HTTPS at that domain (a reverse proxy, Cloudflare Tunnel, your host's TLS, …).")}`);
  console.log("");
  return promptUrl("Once it's reachable, paste that public URL (the PUBLIC_URL you set)");
}
