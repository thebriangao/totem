// Re-bootstrap Whoop Cognito tokens when the refresh token expires (~every 30
// days), then push the fresh tokens to a remote deployment via `fly secrets set`.
//
// Usage:
//   FLY_APP=whoop-mcp-bg whoop-mcp refresh
//   # or:
//   npx tsx src/scripts/rebootstrap.ts --app whoop-mcp-bg
//
// What it does:
//   1. Runs the interactive Cognito bootstrap (prompts for SMS code at your
//      terminal — same flow as `whoop-mcp auth`).
//   2. Writes the new access + refresh tokens to local .env.
//   3. Pushes WHOOP_IOS_BEARER_TOKEN and WHOOP_COGNITO_REFRESH_TOKEN to your
//      Fly app's secrets so the deployed server picks them up automatically.
//
// Requires: `flyctl` on PATH and `fly auth login` already done.
// If you're not deploying to Fly, just run `whoop-mcp auth`
// instead — this script is purely a convenience wrapper for the
// "local bootstrap → remote sync" workflow.
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { bootstrapCognito } from "../whoop/cognito.js";

const ENV_PATH = resolve(".env");

function readEnv(key: string): string | undefined {
  if (!existsSync(ENV_PATH)) return undefined;
  const m = readFileSync(ENV_PATH, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1] : undefined;
}

function upsertEnv(updates: Record<string, string>): void {
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = current.split("\n");
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const entry = `${key}=${value}`;
    if (idx >= 0) lines[idx] = entry;
    else lines.push(entry);
  }
  writeFileSync(ENV_PATH, lines.join("\n"));
}

function getFlyApp(): string | null {
  // Priority: --app CLI flag, then $FLY_APP, then the `app` line in fly.toml
  const argIdx = process.argv.indexOf("--app");
  if (argIdx >= 0 && process.argv[argIdx + 1]) return process.argv[argIdx + 1]!;
  if (process.env.FLY_APP) return process.env.FLY_APP;
  if (existsSync("fly.toml")) {
    const m = readFileSync("fly.toml", "utf8").match(/^app\s*=\s*['"]([^'"]+)['"]/m);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function main(): Promise<void> {
  const email = process.env.WHOOP_EMAIL ?? readEnv("WHOOP_EMAIL");
  const password = process.env.WHOOP_PASSWORD ?? readEnv("WHOOP_PASSWORD");
  if (!email || !password) {
    console.error("Missing WHOOP_EMAIL or WHOOP_PASSWORD in .env.");
    console.error("Add them, then re-run: whoop-mcp refresh");
    process.exit(1);
  }

  const flyApp = getFlyApp();
  if (!flyApp) {
    console.error("No Fly app detected. Either:");
    console.error("  - run from a directory with fly.toml, or");
    console.error("  - set FLY_APP env var, or");
    console.error("  - pass --app <name>");
    console.error("");
    console.error("If you only want a local re-bootstrap (no remote sync),");
    console.error("use `whoop-mcp auth` instead.");
    process.exit(1);
  }

  console.log(`Re-bootstrap target: Fly app '${flyApp}'`);
  console.log(`Whoop account: ${email}`);
  console.log("");
  console.log("Step 1/3 — authenticating with Cognito (you'll get an SMS code)...");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let tokens;
  try {
    tokens = await bootstrapCognito({
      email,
      password,
      mfaPrompt: async () => {
        console.log("");
        const code = await rl.question("Enter the SMS MFA code Whoop just texted you: ");
        return code;
      },
    });
  } catch (err) {
    rl.close();
    console.error("\nBootstrap failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  rl.close();
  console.log("  → got access + refresh tokens.");

  console.log("");
  console.log("Step 2/3 — saving to local .env...");
  upsertEnv({
    WHOOP_IOS_BEARER_TOKEN: tokens.accessToken,
    WHOOP_COGNITO_REFRESH_TOKEN: tokens.refreshToken,
  });
  console.log("  → .env updated.");

  console.log("");
  console.log(`Step 3/3 — pushing secrets to Fly app '${flyApp}'...`);
  const result = spawnSync(
    "fly",
    [
      "secrets", "set",
      `WHOOP_IOS_BEARER_TOKEN=${tokens.accessToken}`,
      `WHOOP_COGNITO_REFRESH_TOKEN=${tokens.refreshToken}`,
      "-a", flyApp,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("");
    console.error("`fly secrets set` failed. Is the fly CLI installed and authenticated?");
    console.error("Tokens ARE saved locally — you can manually push them with:");
    console.error(`  fly secrets set WHOOP_IOS_BEARER_TOKEN=... WHOOP_COGNITO_REFRESH_TOKEN=... -a ${flyApp}`);
    process.exit(result.status ?? 1);
  }

  console.log("");
  console.log("Done. Fly is restarting your deployment with the new tokens.");
  console.log("Wait ~10s, then test:");
  console.log(`  curl https://${flyApp}.fly.dev/health`);
}

await main();
