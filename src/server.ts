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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../.env");
loadEnv({ path: ENV_PATH, quiet: true });

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key} in environment. Run \`whoop-mcp auth\` to set up auto-refresh.`);
  return v;
}

function chooseStore(): TokenStore {
  const mode = (process.env.WHOOP_TOKEN_STORE ?? "envfile").toLowerCase();
  if (mode === "memory") return new MemoryTokenStore();
  return new EnvFileTokenStore(ENV_PATH);
}

async function main(): Promise<void> {
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
  const server = new McpServer({ name: "whoop", version: "1.1.0" });
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("[whoop-mcp] fatal:", err);
  process.exit(1);
});
