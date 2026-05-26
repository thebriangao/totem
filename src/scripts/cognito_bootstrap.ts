// One-time Cognito SRP login. Reads WHOOP_EMAIL + WHOOP_PASSWORD from .env,
// authenticates against AWS Cognito, prompts for SMS MFA code if required,
// writes access_token + refresh_token to .env.
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { bootstrapCognito, refreshCognitoSession } from "../whoop/cognito.js";

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

async function main() {
  const email = process.env.WHOOP_EMAIL ?? readEnv("WHOOP_EMAIL");
  const password = process.env.WHOOP_PASSWORD ?? readEnv("WHOOP_PASSWORD");

  if (!email || !password) {
    console.error("Missing WHOOP_EMAIL or WHOOP_PASSWORD in .env");
    console.error("Add them, then re-run: npm run cognito-bootstrap");
    process.exit(1);
  }

  console.log("Authenticating with AWS Cognito (us-west-2_rYv1jhSC3)...");

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

  upsertEnv({
    WHOOP_IOS_BEARER_TOKEN: tokens.accessToken,
    WHOOP_COGNITO_REFRESH_TOKEN: tokens.refreshToken,
  });

  const lifetimeHours = Math.round((tokens.expiresAt - Date.now()) / 3600000);
  console.log("");
  console.log(`Initial auth OK. Access token expires in ~${lifetimeHours}h. Refresh token saved.`);
  console.log("");
  console.log("Verifying that auto-refresh works (no MFA expected)...");

  try {
    const refreshed = await refreshCognitoSession(email, tokens.refreshToken);
    if (!refreshed.accessToken || refreshed.accessToken === tokens.accessToken) {
      console.error("  WARN: refresh returned no new access token. Auto-refresh may not work.");
    } else {
      const newHours = Math.round((refreshed.expiresAt - Date.now()) / 3600000);
      console.log(`  Auto-refresh works. New access token expires in ~${newHours}h.`);
      // Persist the refreshed access token (and refresh token if Cognito rotated it)
      upsertEnv({
        WHOOP_IOS_BEARER_TOKEN: refreshed.accessToken,
        ...(refreshed.refreshToken && refreshed.refreshToken !== tokens.refreshToken
          ? { WHOOP_COGNITO_REFRESH_TOKEN: refreshed.refreshToken }
          : {}),
      });
    }
  } catch (err) {
    console.error("");
    console.error("Auto-refresh FAILED:", err instanceof Error ? err.message : err);
    console.error("");
    console.error("This means Whoop's Cognito requires MFA on every auth.");
    console.error("You'll need to re-run `npm run cognito-bootstrap` whenever access token expires (~24h).");
    process.exit(2);
  }

  // Fetch user_id + display name so the user doesn't need a separate "whoami" step.
  // Uses the access token we just persisted.
  try {
    const finalToken = readEnv("WHOOP_IOS_BEARER_TOKEN");
    if (finalToken) {
      const r = await fetch("https://api.prod.whoop.com/users-service/v2/bootstrap?apiVersion=7", {
        headers: { authorization: `bearer ${finalToken}`, accept: "application/json" },
      });
      if (r.ok) {
        const j = (await r.json()) as { user?: { id?: number; first_name?: string; last_name?: string } };
        const uid = j.user?.id;
        if (uid) {
          upsertEnv({ WHOOP_USER_ID: String(uid) });
          console.log("");
          console.log(`  user_id: ${uid} (${j.user?.first_name ?? ""} ${j.user?.last_name ?? ""})`.trimEnd());
          console.log(`  Saved WHOOP_USER_ID to .env`);
        }
      }
    }
  } catch {
    /* user_id fetch is optional — the MCP can derive it at runtime */
  }

  console.log("");
  console.log("Setup complete. The MCP will auto-refresh access tokens going forward.");
  console.log("Re-bootstrap only when the refresh token expires (~30 days).");
}

await main();
