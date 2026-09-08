// `totem auth` — the one token command. It logs you into Whoop (Cognito),
// saves the tokens to .env, and — if you've deployed somewhere — pushes them to
// that deployment so the running server picks them up. Auto-detects:
//   • new vs re-auth    — whether you already have tokens (messaging only)
//   • local vs deployed — reads .totem-deploy.json and pushes per-platform
//     (Fly / Railway / Cloud Run / custom), or notes "restart your client" for a
//     local install. Legacy: --app / $FLY_APP / fly.toml still target Fly.
// Run it for first-time setup, or whenever the ~30-day refresh token expires.
//
// When invoked as a sub-step of `totem cloud` / `local` (which handle the
// deploy themselves), set WHOOP_AUTH_TOKENS_ONLY=1 to skip the push step.
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { bootstrapCognito, refreshCognitoSession } from "../whoop/cognito.js";
import { readEnvFile, upsertEnvFile, deleteEnvKeys as deleteEnvFileKeys } from "../lib/env_file.js";
import { prompt, promptHidden } from "../cli/ui.js";

const ENV_PATH = resolve(".env");
const RECORD_PATH = resolve(".totem-deploy.json");

// All .env access goes through src/lib/env_file.ts so values containing `#`
// (or quotes, or edge whitespace) survive the round-trip — see issue #27.
function readEnv(key: string): string | undefined {
  return readEnvFile(ENV_PATH)[key];
}

function upsertEnv(updates: Record<string, string>): void {
  upsertEnvFile(ENV_PATH, updates);
}

// Remove keys from .env (used to wipe the one-time password after bootstrap).
function deleteEnvKeys(keys: string[]): void {
  deleteEnvFileKeys(ENV_PATH, keys);
}

interface DeployTarget {
  platform: string;
  app?: string;
  url?: string;
  region?: string;
  project?: string;
}

function getTarget(): DeployTarget {
  // 1. The deploy record written by `totem cloud` / `local`.
  if (existsSync(RECORD_PATH)) {
    try {
      const r = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as DeployTarget;
      if (r && typeof r.platform === "string") return r;
    } catch { /* fall through */ }
  }
  // 2. Legacy Fly detection (deploys made before the record existed).
  const argIdx = process.argv.indexOf("--app");
  if (argIdx >= 0 && process.argv[argIdx + 1]) return { platform: "fly", app: process.argv[argIdx + 1]! };
  if (process.env.FLY_APP) return { platform: "fly", app: process.env.FLY_APP };
  if (existsSync("fly.toml")) {
    const m = readFileSync("fly.toml", "utf8").match(/^app\s*=\s*['"]([^'"]+)['"]/m);
    if (m && m[1]) return { platform: "fly", app: m[1] };
  }
  // 3. No remote → local stdio install.
  return { platform: "local" };
}

// Push the rotated tokens to the deploy target. Token values go to the host CLIs
// as argv (never echoed by us), so they don't leak to the screen. Returns true on
// success (or when there's nothing remote to push — local/custom).
function pushTokens(t: DeployTarget, accessToken: string, refreshToken: string): boolean {
  const inherit = { stdio: "inherit" as const };
  const manual = (): void => {
    console.error("Set these on your host yourself, then restart it:");
    console.error(`  WHOOP_IOS_BEARER_TOKEN=${accessToken}`);
    console.error(`  WHOOP_COGNITO_REFRESH_TOKEN=${refreshToken}`);
  };

  switch (t.platform) {
    case "local":
      console.log("Local install — nothing remote to update.");
      console.log("  → If the server is running (Claude Desktop / Code), restart it to load the new tokens.");
      return true;

    case "custom":
      console.log("Custom host — set these two on your server, then restart it:");
      console.log(`  WHOOP_IOS_BEARER_TOKEN=${accessToken}`);
      console.log(`  WHOOP_COGNITO_REFRESH_TOKEN=${refreshToken}`);
      return true;

    case "fly": {
      if (!t.app) { console.error("No Fly app recorded."); manual(); return false; }
      console.log(`Pushing to Fly app '${t.app}'…`);
      // `secrets import` reads KEY=val from stdin — keeps the token values off
      // the argv (which any local user could read from `ps`/`/proc`).
      const r = spawnSync("fly", ["secrets", "import", "-a", t.app], {
        input: `WHOOP_IOS_BEARER_TOKEN=${accessToken}\nWHOOP_COGNITO_REFRESH_TOKEN=${refreshToken}\n`,
        stdio: ["pipe", "inherit", "inherit"],
      });
      if (r.status === 0) { console.log(`  → done. Test: curl https://${t.app}.fly.dev/health`); return true; }
      console.error("`fly secrets import` failed (is flyctl installed + `fly auth login` done?)."); manual(); return false;
    }

    case "railway": {
      console.log(`Pushing to Railway project '${t.app ?? "(linked)"}'…`);
      if (t.app) spawnSync("railway", ["link", "--project", t.app], inherit);
      const r = spawnSync("railway", ["variables", "--set",
        `WHOOP_IOS_BEARER_TOKEN=${accessToken}`, "--set",
        `WHOOP_COGNITO_REFRESH_TOKEN=${refreshToken}`], inherit);
      if (r.status === 0) { console.log("  → done. Railway is redeploying with the new tokens."); return true; }
      console.error("`railway variables` failed (is the CLI installed, logged in, and the project linked?)."); manual(); return false;
    }

    case "cloudrun": {
      if (!t.app) { console.error("No Cloud Run service recorded."); manual(); return false; }
      const region = t.region ?? "us-west1";
      console.log(`Pushing to Cloud Run service '${t.app}' (${region})…`);
      const r = spawnSync("gcloud", ["run", "services", "update", t.app,
        "--region", region,
        ...(t.project ? ["--project", t.project] : []),
        "--update-env-vars", `WHOOP_IOS_BEARER_TOKEN=${accessToken},WHOOP_COGNITO_REFRESH_TOKEN=${refreshToken}`,
        "--quiet"], inherit);
      if (r.status === 0) { console.log("  → done. Cloud Run deployed a new revision with the new tokens."); return true; }
      console.error("`gcloud run services update` failed (is gcloud installed, authed, on the right project?)."); manual(); return false;
    }

    default:
      console.log(`Unknown deploy platform '${t.platform}'. Tokens are saved in .env; update your host manually:`);
      manual();
      return true;
  }
}

async function main(): Promise<void> {
  // Prompts come from src/cli/ui.ts: `promptHidden` reads in raw mode with the
  // terminal's own echo off, so nothing is drawn and nothing can erase it. The
  // previous local helper wrote the prompt and then let readline's line refresh
  // (cursorTo + clearScreenDown, which bypass `_writeToOutput`) wipe it, leaving
  // the process waiting at an invisible prompt that looked like a hang (#27).
  // Each prompt opens and closes its own readline, so nothing competes for stdin.

  // Email + password — prompt + persist if not already in .env / env.
  // `||` not `??`: an empty string must fall through to the prompt rather than
  // being accepted as a real value.
  let email = process.env.WHOOP_EMAIL || readEnv("WHOOP_EMAIL");
  if (!email) { email = (await prompt("Your Whoop account email")).trim(); if (email) upsertEnv({ WHOOP_EMAIL: email }); }
  let password = process.env.WHOOP_PASSWORD || readEnv("WHOOP_PASSWORD");
  if (!password) { password = await promptHidden("Your Whoop account password (stored in local .env, used once)"); if (password) upsertEnv({ WHOOP_PASSWORD: password }); }
  if (!email || !password) { console.error("Email + password are required."); process.exit(1); }

  const tokensOnly = process.env.WHOOP_AUTH_TOKENS_ONLY === "1";
  const hadTokens = Boolean(readEnv("WHOOP_IOS_BEARER_TOKEN") && readEnv("WHOOP_COGNITO_REFRESH_TOKEN"));
  const target = getTarget();

  console.log("");
  console.log(hadTokens ? "Re-authenticating with Whoop — refreshing your tokens…" : "Authenticating with Whoop — first-time setup…");
  if (!tokensOnly && target.platform !== "local") {
    console.log(`Then updating your ${target.platform} deployment${target.app ? ` '${target.app}'` : ""}.`);
  }
  console.log("(you'll be asked for an SMS code only if your account has MFA)");
  console.log("");

  let tokens;
  try {
    tokens = await bootstrapCognito({
      email,
      password,
      mfaPrompt: async () => {
        console.log("");
        return prompt("Enter the SMS MFA code Whoop just texted you");
      },
    });
  } catch (err) {
    console.error("\nAuth failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log("  → got fresh access + refresh tokens.");

  let access = tokens.accessToken;
  let refresh = tokens.refreshToken;
  upsertEnv({ WHOOP_IOS_BEARER_TOKEN: access, WHOOP_COGNITO_REFRESH_TOKEN: refresh });

  // Verify auto-refresh works (catches "account requires MFA on every login").
  // This rotates the access token, so push the freshest one afterward.
  try {
    const refreshed = await refreshCognitoSession(email, refresh);
    if (refreshed.accessToken && refreshed.accessToken !== access) {
      access = refreshed.accessToken;
      if (refreshed.refreshToken && refreshed.refreshToken !== refresh) refresh = refreshed.refreshToken;
      upsertEnv({ WHOOP_IOS_BEARER_TOKEN: access, WHOOP_COGNITO_REFRESH_TOKEN: refresh });
      console.log("  → auto-refresh works (the server keeps the access token fresh on its own).");
    }
  } catch {
    console.log("  ⚠ auto-refresh check failed — your account may require MFA on every login (expect to re-auth more often).");
  }

  // Save user_id (best-effort — saves a redundant bootstrap call per session).
  try {
    const r = await fetch("https://api.prod.whoop.com/users-service/v2/bootstrap?apiVersion=7", {
      headers: { authorization: `bearer ${access}`, accept: "application/json" },
    });
    if (r.ok) {
      const j = (await r.json()) as { user?: { id?: number } };
      if (j.user?.id) { upsertEnv({ WHOOP_USER_ID: String(j.user.id) }); console.log(`  → user_id ${j.user.id} saved.`); }
    }
  } catch { /* optional */ }

  // The account password is only needed for this one bootstrap — every
  // subsequent refresh uses the refresh token. Don't leave it on disk.
  deleteEnvKeys(["WHOOP_PASSWORD"]);
  console.log("  → removed your password from .env (only the tokens are needed now).");

  console.log("");
  if (tokensOnly) {
    console.log("Tokens saved to .env.");
    return;
  }
  pushTokens(target, access, refresh);
}

await main();
