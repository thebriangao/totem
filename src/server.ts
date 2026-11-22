// Entry point. Boots an MCP server over either:
//   - stdio (default, for local Claude Desktop / Claude Code)
//   - HTTP/Streamable (for remote hosting; set MCP_TRANSPORT=http)
//
// Switch with MCP_TRANSPORT. See README → "Remote hosting" for the HTTP path.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WhoopClient } from "./whoop/client.js";
import { TokenManager, keepAliveMsFromEnv } from "./whoop/token_manager.js";
import { TokenLock } from "./whoop/token_lock.js";
import {
  FileTokenStore, MemoryTokenStore, LEGACY_TOKEN_KEYS, inContainer, migrateFromEnv, onMountedVolume,
  resolveTokenFilePath, type TokenStore,
} from "./whoop/token_store.js";
import { deleteEnvKeys } from "./lib/env_file.js";
import { registerTools } from "./tools/register.js";
import { startTimezoneAutoDetect } from "./whoop/init_timezone.js";
import { resolveInstallationId } from "./whoop/installation.js";
import { getInstallationId, versionStaleWarning } from "./whoop/device.js";
import { BUILD_ID } from "./build_info.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../.env");
loadEnv({ path: ENV_PATH, quiet: true });

const log = (message: string): void => console.error(`[totem] ${message}`);

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key} in environment.`);
  return v;
}

/**
 * The token store (G6). A file by default; `WHOOP_TOKEN_STORE=memory` only for
 * local throwaway runs, because WHOOP rotates the refresh token on every refresh
 * and a restart would strand a memory-only login.
 */
function chooseStore(transport: string): TokenStore {
  const mode = (process.env.WHOOP_TOKEN_STORE ?? "file").toLowerCase();
  if (mode === "memory") {
    if (inContainer() || transport === "http") {
      // Not an error: v1's `totem cloud` set this as a host secret, so every
      // deployment upgraded from v1 still carries it. Refusing to boot would take
      // those servers down on upgrade. A memory-only login can't survive in a
      // deployment (WHOOP rotates the refresh token on every refresh, so a restart
      // would lose it), so the setting is ignored here and the token file is used.
      log(
        "WHOOP_TOKEN_STORE=memory is ignored in a container or remote deployment (a restart would lose the login). " +
          "Using the token file instead. Remove the old WHOOP_TOKEN_STORE secret, and mount a volume for " +
          "TOTEM_TOKEN_FILE (the image uses /data/tokens.json) so the login survives restarts.",
      );
      const store = new FileTokenStore(resolveTokenFilePath(process.env));
      store.assertWritable();
      return store;
    }
    log("WHOOP_TOKEN_STORE=memory: the login lives only in this process; a restart needs `totem auth` again.");
    return new MemoryTokenStore(migrateFromEnv(process.env));
  }
  const store = new FileTokenStore(resolveTokenFilePath(process.env));
  store.assertWritable();
  return store;
}

/** First run after v1: move WHOOP_IOS_BEARER_TOKEN / WHOOP_COGNITO_REFRESH_TOKEN into the token file. */
function migrateLegacyTokens(store: TokenStore): void {
  if (!store.path) return;
  let existing;
  try {
    existing = store.load();
  } catch (error) {
    log((error as Error).message);
    return;
  }
  const legacy = migrateFromEnv(process.env);
  if (existing) {
    if (legacy) log(`ignoring ${LEGACY_TOKEN_KEYS.join("/")} from the environment: ${store.path} holds the login.`);
    return;
  }
  if (!legacy) return;
  store.save(legacy);
  log(`moved the WHOOP login from ${LEGACY_TOKEN_KEYS.join("/")} into ${store.path}.`);
  if (existsSync(ENV_PATH)) {
    try {
      deleteEnvKeys(ENV_PATH, [...LEGACY_TOKEN_KEYS, "WHOOP_PASSWORD"]);
    } catch {
      // read-only .env: the token file wins anyway
    }
  }
}

async function main(): Promise<void> {
  log(`build=${BUILD_ID}`);
  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  const store = chooseStore(transport);
  migrateLegacyTokens(store);
  if (store.path && inContainer() && onMountedVolume(store.path) === false) {
    log(`${store.path} is not on a mounted volume: a restart or redeploy will lose the WHOOP login (run \`totem auth\` again after one).`);
  }

  // The device identity lives with the login so it survives container restarts.
  let saved = null;
  try {
    saved = store.load();
  } catch {
    // reported by the token manager below; the server still starts
  }
  if (!process.env.WHOOP_INSTALLATION_ID && saved?.installation_id) process.env.WHOOP_INSTALLATION_ID = saved.installation_id;
  // Generate + persist a stable per-install identifier before any request goes
  // out, so every data request carries the same `x-whoop-installation-identifier`.
  resolveInstallationId(ENV_PATH);

  // Warn (once, at boot) if the bundled iOS app version has gone stale enough to
  // become a fingerprintable cohort. No-op until ~6 months past the capture date.
  const stale = versionStaleWarning();
  if (stale) console.error(stale);

  let client: WhoopClient | undefined;
  const tokenManager = new TokenManager({
    store,
    lock: store.path ? new TokenLock({ path: `${store.path}.lock` }) : null,
    keepAliveMs: keepAliveMsFromEnv(process.env.TOTEM_KEEPALIVE_HOURS),
    onFatal: () => {
      // Logged by the manager. Exit so the host restarts us and the problem is loud.
      setTimeout(() => process.exit(1), 100).unref();
    },
    onLoginChange: (record) => {
      if (record?.user_id) process.env.WHOOP_USER_ID = String(record.user_id);
      if (client) {
        client.invalidateAll(); // never serve one account's cached data to another
        if (record) startTimezoneAutoDetect(client);
      }
    },
  });
  tokenManager.start();
  process.once("exit", () => tokenManager.stop()); // releases the lock

  const current = tokenManager.current();
  if (current && !current.installation_id) tokenManager.annotate({ installation_id: getInstallationId() });
  const status = tokenManager.status();
  if (status.state === "no-login") log("no WHOOP login yet. Run `totem auth` (on a deployment it pushes the login to this server).");
  else if (status.state === "handed-off") log(`this login was handed to ${status.handed_off_to}; run \`totem auth --local\` for a separate local login.`);
  else log(`WHOOP login: ${status.source}, ${status.role}, token file ${status.store}`);

  const whoop = new WhoopClient({
    getToken: () => tokenManager.getToken(),
    onUnauthorized: (token) => tokenManager.invalidate(token),
  });
  client = whoop;

  // Tier 2 of the timezone resolution chain: auto-detect from Whoop's profile
  // so responses come back in the user's local TZ without manual config.
  // No-op if WHOOP_TIMEZONE is set (env var wins). Fires async — does not
  // block server startup.
  if (current) startTimezoneAutoDetect(whoop);

  if (transport === "http") {
    const { startHttpServer } = await import("./server-http.js");
    await startHttpServer(whoop, {
      authToken: requireEnv("MCP_AUTH_TOKEN"),
      tokens: tokenManager,
      installationId: () => getInstallationId(),
    });
    return;
  }

  // stdio (default — local Claude Desktop / Claude Code). The default SIGTERM
  // handler skips 'exit' handlers, so route signals through process.exit to
  // release the token lock.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => process.exit(0));
  const server = new McpServer({ name: "totem", version: "1.5.1" });
  registerTools(server, whoop);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // A startup failure is something the user has to act on: print the message,
  // not a stack trace (set TOTEM_DEBUG=1 for the stack).
  console.error(`[totem] fatal: ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.TOTEM_DEBUG && err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
