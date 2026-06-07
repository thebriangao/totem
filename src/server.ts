// Entry point. Boots an MCP server over either:
//   - stdio (default, for local Claude Desktop / Claude Code)
//   - HTTP/Streamable (for remote hosting; set MCP_TRANSPORT=http)
//
// Switch with MCP_TRANSPORT. See README → "Remote hosting" for the HTTP path.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WhoopClient } from "./whoop/client.js";
import { TokenManager } from "./whoop/token_manager.js";
import { EnvFileTokenStore, MemoryTokenStore, type TokenStore } from "./whoop/token_store.js";
import { registerTools } from "./tools/register.js";
import { startTimezoneAutoDetect } from "./whoop/init_timezone.js";
import { resolveInstallationId } from "./whoop/installation.js";
import { versionStaleWarning } from "./whoop/device.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../.env");
loadEnv({ path: ENV_PATH, quiet: true });

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key} in environment. Run \`totem auth\` to set up auto-refresh.`);
  return v;
}

function chooseStore(): TokenStore {
  const mode = (process.env.WHOOP_TOKEN_STORE ?? "envfile").toLowerCase();
  if (mode === "memory") {
    console.error(
      "[totem] WHOOP_TOKEN_STORE=memory: rotated tokens are NOT persisted. If Cognito rotates your refresh token, a restart will need a fresh `totem auth`.",
    );
    return new MemoryTokenStore();
  }
  return new EnvFileTokenStore(ENV_PATH);
}

async function main(): Promise<void> {
  // Generate + persist a stable per-install identifier before any request goes
  // out, so every data request carries the same `x-whoop-installation-identifier`
  // the iOS app sends. Persisted to the env file like the tokens.
  resolveInstallationId(ENV_PATH);

  // Warn (once, at boot) if the bundled iOS app version has gone stale enough to
  // become a fingerprintable cohort. No-op until ~6 months past the capture date.
  const stale = versionStaleWarning();
  if (stale) console.error(stale);

  const tokenManager = new TokenManager({
    email: requireEnv("WHOOP_EMAIL"),
    accessToken: requireEnv("WHOOP_IOS_BEARER_TOKEN"),
    refreshToken: requireEnv("WHOOP_COGNITO_REFRESH_TOKEN"),
    store: chooseStore(),
  });

  const client = new WhoopClient({ getToken: () => tokenManager.getToken() });

  // Tier 2 of the timezone resolution chain: auto-detect from Whoop's profile
  // so responses come back in the user's local TZ without manual config.
  // No-op if WHOOP_TIMEZONE is set (env var wins). Fires async — does not
  // block server startup.
  startTimezoneAutoDetect(client);

  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  if (transport === "http") {
    const { startHttpServer } = await import("./server-http.js");
    await startHttpServer(client, {
      authToken: requireEnv("MCP_AUTH_TOKEN"),
    });
    return;
  }

  // stdio (default — local Claude Desktop / Claude Code)
  const server = new McpServer({ name: "totem", version: "1.4.1" });
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("[totem] fatal:", err);
  process.exit(1);
});
