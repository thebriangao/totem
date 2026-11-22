// `totem auth`: log into WHOOP and put the login where the server runs.
//
//   totem auth            browser login; saved here, or pushed to your deployment
//   totem auth --paste    paste a whoop-auth-refresh-token cookie instead
//   totem auth --local    save on this machine even when a deployment is recorded
//   totem auth --url URL  push to the totem server at URL
//   totem auth --status   show where the login lives and when it last refreshed
//
// Presentation only: every step is a function in auth_flow.ts / browser_login.ts
// that returns a result. This file prints and prompts.

import { resolve } from "node:path";
import { c, promptHidden } from "./ui.js";
import {
  captureBrowserLogin, findBrowser, BrowserLoginError, SUPPORTED_BROWSERS, type FoundBrowser,
} from "./browser_login.js";
import {
  checkPushUrl, cliEnv, fetchRemoteStatus, loginFromCookies, loginWithRefreshToken, markHandedOff, pickInstallationId,
  pushLogin, readLocalStatus, readTokenFile, resolveAuthTarget, retireLegacyEnv, saveLocalLogin, validateLogin,
  type AuthTarget, type PushResult, type RemoteStatus, type WhoopLogin,
} from "./auth_flow.js";
import { readDeployRecord, updateDeployRecord } from "./deploy_record.js";
import { resolveTokenFilePath } from "../whoop/token_store.js";

interface AuthFlags {
  paste: boolean;
  local: boolean;
  status: boolean;
  help: boolean;
  /** Push over plain http to a host other than this machine (a private network). */
  allowHttp: boolean;
  url?: string | undefined;
  browser?: string | undefined;
}

export function parseAuthFlags(argv: string[]): AuthFlags {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    paste: argv.includes("--paste"),
    local: argv.includes("--local"),
    status: argv.includes("--status") || argv[0] === "status",
    help: argv.includes("--help") || argv.includes("-h"),
    allowHttp: argv.includes("--allow-http"),
    url: value("--url"),
    browser: value("--browser"),
  };
}

const say = (s = ""): void => console.log(s);
const ok = (s: string): void => console.log(`  ${c.green("✓")} ${s}`);
const warn = (s: string): void => console.log(`  ${c.yellow("!")} ${s}`);
const fail = (s: string): void => console.error(`  ${c.red("✗")} ${s}`);

function printHelp(): void {
  say("totem auth            log in through a browser; saved here, or pushed to your deployment");
  say("totem auth --paste    paste the whoop-auth-refresh-token cookie instead of opening a browser");
  say("totem auth --local    save the login on this machine even if a deployment is recorded");
  say("totem auth --url URL  push the login to the totem server at URL (https; --allow-http for a private network)");
  say("totem auth --status   show where the login lives and when it last refreshed");
  say("Env: TOTEM_TOKEN_FILE (token file path), TOTEM_BROWSER (browser executable).");
}

// ── getting tokens ────────────────────────────────────────────────────────

async function browserFlow(browser: FoundBrowser): Promise<WhoopLogin> {
  say(`A ${browser.name} window is opening on WHOOP's web app, using a temporary profile.`);
  say("Log in there yourself (email, password, code). totem never sees what you type: it waits for");
  say("WHOOP's session cookies, then closes the window and deletes the profile.");
  say("");
  const tokens = await captureBrowserLogin({
    browser,
    onEvent: (e) => {
      if (e.type === "cookie") console.log(c.gray(`  cookie seen: ${e.name} (${e.domain})`));
      if (e.type === "captured") ok("logged in; closing the browser");
    },
  });
  return loginFromCookies(tokens);
}

async function pasteFlow(): Promise<WhoopLogin | null> {
  say("Paste a refresh token from a browser that's logged into app.whoop.com:");
  say(c.gray("  DevTools → Application → Cookies → https://app.whoop.com → whoop-auth-refresh-token → copy the value"));
  const token = (await promptHidden("whoop-auth-refresh-token (hidden)")).trim();
  if (!token) {
    fail("No token entered.");
    return null;
  }
  const login = await loginWithRefreshToken(token);
  ok("WHOOP accepted the refresh token");
  return login;
}

async function getLogin(flags: AuthFlags): Promise<WhoopLogin | null> {
  if (flags.paste) return pasteFlow();
  const env = flags.browser ? { ...process.env, TOTEM_BROWSER: flags.browser } : process.env;
  const browser = findBrowser({ env });
  if (!browser) {
    warn(flags.browser ? `No browser at ${flags.browser}.` : `No ${SUPPORTED_BROWSERS} found (set TOTEM_BROWSER to its path).`);
    say("Falling back to pasting a refresh token.");
    return pasteFlow();
  }
  return browserFlow(browser);
}

// ── status ────────────────────────────────────────────────────────────────

function printRemoteStatus(s: RemoteStatus): void {
  say(`  state ${s.state ?? "?"} · ${s.role ?? "?"} · source ${s.source ?? "-"}`);
  if (s.access_expires_at) say(c.gray(`  access token expires ${s.access_expires_at}`));
  if (s.refreshed_at) say(c.gray(`  last refresh ${s.refreshed_at}`));
  if (s.next_keepalive_at) say(c.gray(`  next keep-alive ${s.next_keepalive_at}`));
  if (s.durable === false) warn("the server's token file isn't on a volume: a restart loses the login");
  if (s.detail) warn(s.detail);
}

async function showStatus(root: string, flags: AuthFlags): Promise<number> {
  const env = cliEnv(resolve(root, ".env"));
  const local = readLocalStatus(resolveTokenFilePath(env));
  say(c.bold("This machine"));
  say(c.gray(`  ${local.tokenFile}`));
  if (local.state === "tokens") {
    say(`  login from ${local.source}, saved ${local.savedAt}`);
    if (local.refreshedAt) say(c.gray(`  last refresh ${local.refreshedAt}`));
    if (local.accessExpiresAt) say(c.gray(`  access token expires ${local.accessExpiresAt}`));
    say(c.gray(local.owner ? `  owned by pid ${local.owner.pid} on ${local.owner.host} (heartbeat ${local.owner.heartbeat_at})` : "  no running server owns it right now"));
  } else if (local.state === "handed-off") {
    say(`  handed to ${local.handedOffTo} (${local.savedAt}); no local copy`);
  } else {
    say(`  ${local.state === "none" ? "no login" : "unreadable token file"}`);
  }
  const record = readDeployRecord(root);
  const target = resolveAuthTarget(record, { url: flags.url }, env);
  if (target.kind !== "remote") return 0;
  say("");
  say(c.bold(`Deployment ${target.url}`));
  const adminToken = target.adminToken || env.TOTEM_ADMIN_TOKEN || env.MCP_AUTH_TOKEN;
  if (!adminToken) {
    say(c.gray("  (no MCP_AUTH_TOKEN recorded for it; run `totem auth` to push a login and record it)"));
    return 0;
  }
  const r = await fetchRemoteStatus(target.url, adminToken, { allowHttp: flags.allowHttp });
  if (r.ok) printRemoteStatus(r.status);
  else fail(`${r.reason}${r.httpStatus ? ` (${r.httpStatus})` : ""}: ${r.detail}`);
  return r.ok ? 0 : 1;
}

// ── pushing to a deployment ───────────────────────────────────────────────

function explainPushFailure(r: Extract<PushResult, { ok: false }>, url: string): void {
  switch (r.reason) {
    case "not-found":
      fail(`${url} has no /admin/tokens: it runs an older totem. Run \`totem deploy\` to update it, then \`totem auth\` again.`);
      break;
    case "unreachable":
      fail(`Couldn't reach ${url} (${r.detail}). Is it running? Try \`totem status\`.`);
      break;
    case "unauthorized":
      fail(`${url} rejected the MCP_AUTH_TOKEN.`);
      break;
    case "insecure":
      fail(r.detail);
      break;
    case "redirected":
      fail(`${url} answered with a redirect (${r.detail}). totem doesn't follow redirects with the login in hand: use the server's final https:// address.`);
      break;
    default:
      fail(`${url} refused the login (${r.httpStatus ?? "?"}): ${r.detail}`);
  }
}

async function pushToDeployment(
  root: string,
  target: Extract<AuthTarget, { kind: "remote" }>,
  login: WhoopLogin,
  userId: number | null,
  allowHttp: boolean,
): Promise<{ ok: boolean; status?: RemoteStatus }> {
  const env = cliEnv(resolve(root, ".env"));
  let token = target.adminToken || env.TOTEM_ADMIN_TOKEN || env.MCP_AUTH_TOKEN || "";
  let prompted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!token) {
      if (!process.stdin.isTTY) break;
      say(c.gray(`  totem needs ${target.url}'s MCP_AUTH_TOKEN (printed when you ran \`totem cloud\`).`));
      token = (await promptHidden("MCP_AUTH_TOKEN (hidden)")).trim();
      prompted = true;
      if (!token) break;
    }
    const r = await pushLogin(target.url, token, login, { userId }, { allowHttp });
    if (r.ok) {
      const record = readDeployRecord(root);
      if (prompted && record?.url && record.url.replace(/\/+$/, "") === target.url) {
        updateDeployRecord(root, { mcp_auth_token: token });
        say(c.gray("  (saved the MCP_AUTH_TOKEN in .totem-deploy.json, 0600)"));
      }
      return { ok: true, status: r.status };
    }
    explainPushFailure(r, target.url);
    if (r.reason !== "unauthorized") return { ok: false };
    token = "";
  }
  if (!token) fail("No MCP_AUTH_TOKEN for the deployment; set TOTEM_ADMIN_TOKEN or rerun in a terminal.");
  return { ok: false };
}

// ── main ──────────────────────────────────────────────────────────────────

export interface RunAuthOptions {
  /** Where the login goes, overriding flags and the deploy record (used by `totem cloud`). */
  target?: AuthTarget;
}

export async function runAuth(root: string, argv: string[] = [], opts: RunAuthOptions = {}): Promise<number> {
  const flags = parseAuthFlags(argv);
  if (flags.help) { printHelp(); return 0; }
  if (flags.status) return showStatus(root, flags);

  const envPath = resolve(root, ".env");
  const env = cliEnv(envPath);
  const target = opts.target ?? resolveAuthTarget(readDeployRecord(root), flags, env);
  const localFile = resolveTokenFilePath(env);
  if (target.kind === "remote") {
    // Before anyone logs in: the push must have somewhere safe to go.
    const safe = checkPushUrl(target.url, { allowHttp: flags.allowHttp });
    if (!safe.ok) {
      fail(safe.reason);
      return 1;
    }
  }
  say(target.kind === "remote" ? `Logging into WHOOP for ${c.bold(target.url)}` : `Logging into WHOOP for this machine (${c.gray(localFile)})`);
  say("");

  let login: WhoopLogin | null;
  try {
    login = await getLogin(flags);
  } catch (error) {
    fail(error instanceof BrowserLoginError || error instanceof Error ? error.message : String(error));
    if (!flags.paste) say(c.gray("  You can also run `totem auth --paste` and paste the refresh-token cookie."));
    return 1;
  }
  if (!login) return 1;

  const existing = readTokenFile(localFile);
  const installationId = pickInstallationId(existing, env);
  const check = await validateLogin(login.accessToken, { installationId });
  if (check.accepted === false) {
    fail(`WHOOP rejected the new access token (${check.status}). Nothing was saved; try again.`);
    return 1;
  }
  if (check.accepted) ok(`WHOOP accepted the login${check.userId ? ` (user ${check.userId})` : ""}`);
  else warn(`Couldn't confirm the login with WHOOP (${check.status ?? check.detail ?? "no response"}); saving it anyway.`);

  if (target.kind === "local") {
    saveLocalLogin(target.tokenFile, login, { userId: check.userId, installationId });
    ok(`saved to ${target.tokenFile} (0600)`);
    const retired = retireLegacyEnv(envPath);
    if (retired.length) ok(`removed ${retired.join(", ")} from .env`);
    say(c.gray("  A running local totem server picks up the new login on its next request."));
    return 0;
  }

  const pushed = await pushToDeployment(root, target, login, check.userId, flags.allowHttp);
  if (!pushed.ok) {
    say(c.gray("  The new login wasn't saved anywhere. Run `totem auth` again once the server is reachable."));
    return 1;
  }
  ok(`pushed to ${target.url}; the server saved it and switched over`);
  if (pushed.status?.durable === false) {
    warn("this server has no persistent volume for its token file: after a restart or redeploy, run `totem auth` again.");
  }
  const handoff = markHandedOff(localFile, target.url, { userId: check.userId, installationId });
  if (handoff.keptLocalLogin) say(c.gray(`  Your separate local login (${localFile}) is unaffected.`));
  else say(c.gray("  No copy is kept on this machine: the deployment is the login's only owner."));
  const retired = retireLegacyEnv(envPath);
  if (retired.length) ok(`removed ${retired.join(", ")} from .env`);
  return 0;
}
