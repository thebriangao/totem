// Guided setup flows: `whoop-mcp cloud` (server-hosted, OAuth, recommended) and
// `whoop-mcp local` (stdio on this machine). These are the headline commands.
//
// Reality of multi-platform automation: only Fly is live-tested by the author.
// Railway / Cloud Run run their documented CLI commands but, because
// their deploy-URL output formats vary and I can't verify them, the flow asks
// you to paste the resulting URL rather than scraping it. Custom is a printed
// guide for any other platform or your own server. Either way it's one command
// that walks you to a working, Claude-connected deployment.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  c, run, capture, commandExists, genToken, genPassword, copyToClipboard, httpGet,
  prompt, promptYesNo, promptChoice, step, closePrompts,
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
  writeFileSync(p, lines.join("\n"));
}

// Record of where we deployed, so `refresh` can push to the right place later.
interface DeployRecord {
  platform: string;
  app: string;
  url: string;
}
function writeDeployRecord(root: string, rec: DeployRecord): void {
  writeFileSync(resolve(root, ".whoop-mcp-deploy.json"), JSON.stringify(rec, null, 2));
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
  // Need email + password in .env for the bootstrap script.
  if (!env.WHOOP_EMAIL) {
    const email = await prompt("Your Whoop account email");
    if (!email) { console.log(c.red("Email required.")); return false; }
    upsertEnv(root, { WHOOP_EMAIL: email });
  }
  if (!readEnv(root).WHOOP_PASSWORD) {
    const pw = await prompt("Your Whoop account password (stored only in local .env, used once)");
    if (!pw) { console.log(c.red("Password required.")); return false; }
    upsertEnv(root, { WHOOP_PASSWORD: pw });
  }
  console.log(c.gray("Authenticating with Whoop (you'll get an SMS code if your account has MFA)…"));
  // closePrompts so the bootstrap script owns stdin for its own SMS prompt.
  closePrompts();
  // runScript prefers the compiled dist/ (works in a published install with no
  // tsx), falling back to tsx on source for a dev checkout.
  const code = await runScript(root, "scripts/cognito_bootstrap");
  if (code !== 0) { console.log(c.red("Auth failed.")); return false; }
  return true;
}

// ── LOCAL flow ───────────────────────────────────────────────────────────────
export async function runLocalSetup(root: string): Promise<number> {
  console.log(c.bold("\nwhoop-mcp · local setup") + c.gray(" — run the MCP on this machine over stdio\n"));
  const TOTAL = 4;
  const serverJs = resolve(root, "dist", "server.js");

  step(1, TOTAL, "Prerequisites");
  console.log(`  node ${process.version} ${c.green("✓")}`);
  if (!(await ensureDeps(root))) return 1;

  step(2, TOTAL, "Whoop authentication");
  if (!(await ensureAuth(root))) return 1;
  console.log(c.green("  ✓ tokens in .env"));

  step(3, TOTAL, "Build");
  if (existsSync(serverJs)) {
    console.log(c.green("  ✓ already built (dist/)"));
  } else {
    const tsc = resolve(root, "node_modules", ".bin", "tsc");
    if (!existsSync(tsc)) {
      console.log(c.red("  No dist/ and no TypeScript compiler.") + c.gray(" Run `npm install && whoop-mcp build`."));
      return 1;
    }
    const buildCode = await run(process.execPath, [tsc], { cwd: root });
    if (buildCode !== 0) { console.log(c.red("  Build failed.")); return 1; }
    console.log(c.green("  ✓ dist/ built"));
  }

  step(4, TOTAL, "Wire into your AI client");
  const client = await promptChoice("Which client?", [
    "Claude Desktop (write config automatically)",
    "Claude Code (print the one-line command)",
    "Just show me the config — I'll paste it",
  ]);

  let wired = false;
  if (client === 1) {
    console.log("");
    const manual = `claude mcp add whoop ${process.execPath} ${serverJs}`;
    if (commandExists("claude")) {
      if (await promptYesNo("Run `claude mcp add whoop …` for you now?", true)) {
        if (await run("claude", ["mcp", "add", "whoop", process.execPath, serverJs]) === 0) {
          console.log(c.green("  ✓ added to Claude Code"));
          wired = true;
        } else {
          console.log(c.yellow("  That didn't work — run it yourself:"));
          console.log(`  ${manual}`);
        }
      } else {
        console.log(c.gray("  Run it when ready:"));
        console.log(`  ${manual}`);
      }
    } else {
      console.log(c.gray("  The `claude` CLI isn't on PATH. Install Claude Code, then run:"));
      console.log(`  ${manual}`);
    }
  } else if (client === 0) {
    const home = process.env.HOME ?? "~";
    const cfgPath = resolve(home, "Library/Application Support/Claude/claude_desktop_config.json");
    const entry = { command: process.execPath, args: [serverJs] };
    let merged: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(cfgPath)) {
      try { merged = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { merged = {}; }
    }
    merged.mcpServers = { ...(merged.mcpServers ?? {}), whoop: entry };
    if (await promptYesNo(`Write the 'whoop' server into ${cfgPath}?`, true)) {
      writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
      console.log(c.green("  ✓ Claude Desktop config updated"));
      console.log(c.yellow("  → Quit and reopen Claude Desktop to load it."));
      wired = true;
    }
  } else {
    const home = process.env.HOME ?? "~";
    const cfgPath = resolve(home, "Library/Application Support/Claude/claude_desktop_config.json");
    console.log("");
    console.log(c.bold("  To finish, add this to Claude Desktop:"));
    console.log(c.gray("  1. Open (create if missing):"));
    console.log(`     ${cfgPath}`);
    console.log(c.gray('  2. Merge the "whoop" block into your existing "mcpServers" — don\'t overwrite the file:'));
    console.log("");
    console.log(JSON.stringify({ mcpServers: { whoop: { command: process.execPath, args: [serverJs] } } }, null, 2));
    console.log("");
    console.log(c.gray("  3. Quit and reopen Claude Desktop."));
    console.log(c.gray("  Using Claude Code instead? Run: ") + c.bold(`claude mcp add whoop ${process.execPath} ${serverJs}`));
  }

  if (wired) {
    console.log(c.green("\n✓ Local setup complete.") + c.gray(" Quit/reopen the client, then ask: \"how am I doing today on whoop?\"\n"));
  } else {
    console.log(c.yellow("\n→ Almost done.") + c.gray(" Finish the step above (paste the config or run the command) + restart your client, then ask: \"how am I doing today on whoop?\"\n"));
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
  console.log(c.bold("\nwhoop-mcp · cloud setup") + c.gray(" — deploy a server + connect it to Claude (web, desktop, mobile)\n"));
  const TOTAL = 6;
  if (!(await ensureDeps(root))) return 1;

  step(1, TOTAL, "Whoop authentication");
  if (!(await ensureAuth(root))) return 1;
  const env = readEnv(root);
  console.log(c.green("  ✓ tokens ready"));

  step(2, TOTAL, "Choose a host");
  const platformIdx = await promptChoice("Where should the server run?", [
    `Fly.io          ${c.gray("— fully automated + tested. ~$2/mo (no free tier).")}`,
    `Railway         ${c.gray("— $5/mo credit, always-on. CLI-driven.")}`,
    `Google Cloud Run ${c.gray("— generous free tier, scales to zero. Needs gcloud SDK.")}`,
    `Custom / own server ${c.gray("— step-by-step Docker instructions, no automation.")}`,
  ]);
  const platforms = ["fly", "railway", "cloudrun", "custom"] as const;
  const platform = platforms[platformIdx]!;

  step(3, TOTAL, "Generate secrets");
  const mcpToken = genToken();
  console.log(`  MCP_AUTH_TOKEN: ${c.gray(mcpToken.slice(0, 12) + "… (generated)")}`);
  console.log(c.gray("  Connector password — you'll paste this into Claude once when adding the server."));
  console.log(c.gray("  Press Enter to auto-generate a secure 18-char one, or type your own (min 12)."));
  const useGenerated = (pw: string): string => {
    const copied = copyToClipboard(pw);
    console.log(`  ${c.green("✓")} generated: ${c.bold(pw)}${copied ? c.green("   ✓ copied to clipboard") : c.gray("   (copy it now)")}`);
    return pw;
  };
  let password = await prompt("Password (Enter = auto-generate)");
  if (password === "") {
    password = useGenerated(genPassword(18));
  } else {
    while (password.length < 12) {
      console.log(c.red("  Use at least 12 characters (or press Enter to auto-generate)."));
      password = await prompt("Password (Enter = auto-generate)");
      if (password === "") { password = useGenerated(genPassword(18)); break; }
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
  const defaultName = `whoop-mcp-${genToken().slice(0, 6)}`;
  let appName = "whoop-mcp";
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
    console.log(c.yellow("\nDeploy didn't complete automatically. Follow the steps above, then re-run `whoop-mcp cloud` or set PUBLIC_URL + redeploy manually."));
    closePrompts();
    return 1;
  }

  step(5, TOTAL, "Verify the server + OAuth are live");
  const ok = await verifyDeployment(url);
  if (!ok) {
    console.log(c.yellow("  Couldn't confirm the OAuth endpoints yet (the host may still be starting). Give it a minute, then run `whoop-mcp ping`."));
  }
  writeDeployRecord(root, { platform, app: appName, url });

  step(6, TOTAL, "Connect to Claude");
  printConnectInstructions(url, password);
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
  const deadline = Date.now() + 90_000;
  let healthy = false;
  let announced = false;
  while (Date.now() < deadline) {
    const health = await httpGet(`${root}/health`, 3000);
    if (health.status === 200) { healthy = true; break; }
    if (!announced) { console.log(c.gray(`  waiting for ${root} (DNS + first boot)…`)); announced = true; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`  /health: ${healthy ? c.green("200 ✓") : c.red("timeout")}`);
  const prm = await httpGet(`${root}/.well-known/oauth-protected-resource/mcp`, 5000);
  const prmOk = prm.status === 200 && prm.body.includes("/mcp");
  console.log(`  OAuth metadata: ${prmOk ? c.green("✓") : c.red("not found")}`);
  return healthy && prmOk;
}

function printConnectInstructions(url: string, password: string): void {
  const mcpUrl = url.replace(/\/$/, "") + "/mcp";
  console.log("");
  console.log(c.bold("  Add it to Claude (syncs across web, desktop, and mobile):"));
  console.log(`  1. Open ${c.cyan("claude.ai")} → Settings → Connectors → ${c.bold("Add custom connector")}`);
  console.log(`  2. URL:      ${c.brand(mcpUrl)}`);
  console.log(`  3. Password: ${c.brand(password)}`);
  console.log(`  4. Approve. Done — every device on your account now has Whoop.`);
  console.log("");
  // Best-effort: open the connectors page in the browser (cross-platform).
  openUrl("https://claude.ai/settings/connectors");
  console.log(c.gray("  (tried to open the connectors page in your browser)"));
  console.log(c.green("\n✓ Cloud setup complete.\n"));
}

// ── platform adapters ────────────────────────────────────────────────────────

function setSummary(env: Record<string, string>): void {
  console.log(c.gray("  env to set: " + Object.keys(env).join(", ")));
}

// FLY — fully automated + tested.
async function deployFly(ctx: DeployCtx): Promise<string | null> {
  if (!commandExists("fly") && !commandExists("flyctl")) {
    const installed = await ensureCli("flyctl", {
      brewPkg: "flyctl",
      scriptUrl: "https://fly.io/install.sh",
      manualHint: "brew install flyctl  (or: curl -L https://fly.io/install.sh | sh)",
    });
    if (!installed) return null;
  }
  const fly = commandExists("fly") ? "fly" : "flyctl";
  if (capture(fly, ["auth", "whoami"]).code !== 0) {
    console.log(c.gray("  Logging into Fly…"));
    if (await run(fly, ["auth", "login"]) !== 0) return null;
  }
  const url = `https://${ctx.appName}.fly.dev`;
  const env = { ...ctx.env, PUBLIC_URL: url };

  // Create the app (idempotent-ish: ignore "already exists").
  const create = capture(fly, ["apps", "create", ctx.appName, "--json"]);
  if (create.code !== 0 && !/already|taken/i.test(create.stderr + create.stdout)) {
    console.log(c.red(`  Couldn't create app '${ctx.appName}': ${create.stderr.trim() || create.stdout.trim()}`));
    return null;
  }
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
    `  auto_stop_machines = "stop"`,
    `  auto_start_machines = true`,
    `  min_machines_running = 0`,
    ``,
  ].join("\n"));
  // Set secrets (staged; applied on deploy).
  const secretArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  console.log(c.gray("  setting secrets…"));
  if (await run(fly, ["secrets", "set", ...secretArgs, "--app", ctx.appName, "--stage"]) !== 0) {
    console.log(c.yellow("  (secrets --stage failed; retrying without --stage)"));
    await run(fly, ["secrets", "set", ...secretArgs, "--app", ctx.appName]);
  }
  console.log(c.gray("  deploying (builds the Dockerfile, ~1-2 min)…"));
  if (await run(fly, ["deploy", "--app", ctx.appName, "--ha=false"], { cwd: ctx.root }) !== 0) return null;
  return url;
}

// Shared "assisted" deploy for platforms I can't live-test: run the documented
// commands, then ask the user to paste the resulting URL (robust vs. parsing).
async function assistedDeploy(opts: {
  cliName: string;
  install: { brewPkg?: string; npmPkg?: string; scriptUrl?: string; manualHint: string };
  loginCheck: () => boolean;
  loginCmd: () => Promise<number>;
  steps: Array<{ desc: string; cmd: [string, string[]] }>;
  setPublicUrlHint: (url: string) => string;
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
    console.log(c.gray(`  → ${s.desc}`));
    console.log(c.gray(`    $ ${s.cmd[0]} ${s.cmd[1].join(" ")}`));
    if (await run(s.cmd[0], s.cmd[1], { cwd: opts.ctx.root }) !== 0) {
      console.log(c.yellow(`  That step failed. You can run it manually and continue.`));
      if (!(await promptYesNo("Continue anyway?", false))) return null;
    }
  }
  const url = await prompt("Paste your deployment's public URL (e.g. https://your-app.up.railway.app)");
  if (!url.startsWith("http")) { console.log(c.red("  Need a valid https URL.")); return null; }
  console.log(c.gray(`  Now set PUBLIC_URL so OAuth works: ${opts.setPublicUrlHint(url.replace(/\/$/, ""))}`));
  await promptYesNo("Done setting PUBLIC_URL + redeploying?", true);
  return url.replace(/\/$/, "");
}

// RAILWAY — CLI-automatable; best-effort (untested).
async function deployRailway(ctx: DeployCtx): Promise<string | null> {
  const env = { ...ctx.env, PUBLIC_URL: "" };
  const varArgs: string[] = ["variables"];
  for (const [k, v] of Object.entries(env)) varArgs.push("--set", `${k}=${v}`);
  return assistedDeploy({
    cliName: "railway",
    install: { npmPkg: "@railway/cli", brewPkg: "railway", manualHint: "npm i -g @railway/cli  (or: brew install railway)" },
    loginCheck: () => capture("railway", ["whoami"]).code === 0,
    loginCmd: () => run("railway", ["login"]),
    steps: [
      { desc: "create/link a project", cmd: ["railway", ["init", "--name", ctx.appName]] },
      { desc: "set environment variables", cmd: ["railway", varArgs] },
      { desc: "deploy (uploads + builds the Dockerfile)", cmd: ["railway", ["up", "--detach"]] },
      { desc: "generate a public domain", cmd: ["railway", ["domain"]] },
    ],
    setPublicUrlHint: (url) => `railway variables --set "PUBLIC_URL=${url}" && railway up --detach`,
    ctx,
  });
}

// GOOGLE CLOUD RUN — gcloud, builds from source. Best-effort.
async function deployCloudRun(ctx: DeployCtx): Promise<string | null> {
  // Cloud Run env vars with commas need a custom delimiter; use ^@^.
  const envStr = "^@^" + Object.entries({ ...ctx.env, PUBLIC_URL: "" }).map(([k, v]) => `${k}=${v}`).join("@");
  return assistedDeploy({
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
        desc: "deploy from source (Cloud Build builds the Dockerfile)",
        cmd: ["gcloud", [
          "run", "deploy", ctx.appName,
          "--source", ".",
          "--region", "us-west1",
          "--allow-unauthenticated",
          "--port", "3000",
          `--set-env-vars`, envStr,
        ]],
      },
    ],
    setPublicUrlHint: (url) => `gcloud run services update ${ctx.appName} --region us-west1 --update-env-vars PUBLIC_URL=${url}`,
    ctx,
  });
}

// CUSTOM — printed guide for any other platform or your own server.
async function deployCustom(ctx: DeployCtx): Promise<string | null> {
  console.log("");
  console.log(c.bold("  Custom / self-hosted deploy"));
  console.log(c.gray("  1. Build the image (the repo ships a Dockerfile):"));
  console.log(`     docker build -t whoop-mcp .`);
  console.log(c.gray("  2. Run it with these env vars (HTTPS + a public hostname required):"));
  for (const [k, v] of Object.entries(ctx.env)) {
    const shown = ["MCP_AUTH_TOKEN", "AUTH_PASSWORD", "WHOOP_IOS_BEARER_TOKEN", "WHOOP_COGNITO_REFRESH_TOKEN"].includes(k)
      ? v.slice(0, 8) + "…"
      : v;
    console.log(`       ${c.brand(k)}=${shown}`);
  }
  console.log(c.gray("  3. Set PUBLIC_URL to your server's public origin (e.g. https://whoop.example.com)."));
  console.log(c.gray("  4. Make sure port 3000 is reachable over HTTPS."));
  console.log("");
  const url = await prompt("Once it's live, paste the public URL");
  if (!url.startsWith("http")) { console.log(c.red("  Need a valid https URL.")); return null; }
  return url.replace(/\/$/, "");
}
