// `totem auth`: log in to WHOOP and put the login where the server runs.
//
//   totem auth            browser login; saved here, or sent to your deployment
//   totem auth --paste    paste a whoop-auth-refresh-token cookie instead
//   totem auth --local    save on this computer even when a deployment is recorded
//   totem auth --url URL  send the login to the totem server at URL
//   totem auth --status   show where the login lives and when it last refreshed
//
// Presentation only: every step is a function in auth_flow.ts / browser_login.ts
// that returns a result. This file shows what is happening and asks. The steps
// are reached through `AuthDeps`, so a test can render every screen (success,
// each failure) without a browser or WHOOP.

import { resolve } from "node:path";
import {
  captureBrowserLogin, findBrowser, BrowserLoginError, SUPPORTED_BROWSERS, type FoundBrowser,
} from "./browser_login.js";
import {
  checkPushUrl, cliEnv, fetchRemoteStatus, loginFromCookies, loginWithRefreshToken, markHandedOff, pickInstallationId,
  pushLogin, readLocalStatus, readTokenFile, resolveAuthTarget, retireLegacyEnv, saveLocalLogin, validateLogin,
  type AuthTarget, type LocalStatus, type PushResult, type RemoteStatus, type WhoopLogin,
} from "./auth_flow.js";
import { readDeployRecord, updateDeployRecord } from "./deploy_record.js";
import { resolveTokenFilePath } from "../whoop/token_store.js";
import { tildify } from "./clients.js";
import { realIo, type Io } from "./sys.js";
import { when, type Fix } from "./ui.js";

/** The login steps (auth_flow.ts, browser_login.ts). Swappable in tests. */
export interface AuthDeps {
  cliEnv: typeof cliEnv;
  findBrowser: typeof findBrowser;
  captureBrowserLogin: typeof captureBrowserLogin;
  loginWithRefreshToken: typeof loginWithRefreshToken;
  validateLogin: typeof validateLogin;
  saveLocalLogin: typeof saveLocalLogin;
  pushLogin: typeof pushLogin;
  fetchRemoteStatus: typeof fetchRemoteStatus;
  readLocalStatus: typeof readLocalStatus;
  readTokenFile: typeof readTokenFile;
  pickInstallationId: typeof pickInstallationId;
  markHandedOff: typeof markHandedOff;
  retireLegacyEnv: typeof retireLegacyEnv;
}
export const realAuthDeps: AuthDeps = {
  cliEnv, findBrowser, captureBrowserLogin, loginWithRefreshToken, validateLogin, saveLocalLogin, pushLogin,
  fetchRemoteStatus, readLocalStatus, readTokenFile, pickInstallationId, markHandedOff, retireLegacyEnv,
};

interface AuthFlags {
  paste: boolean;
  local: boolean;
  status: boolean;
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
    allowHttp: argv.includes("--allow-http"),
    url: value("--url"),
    browser: value("--browser"),
  };
}

const AGAIN: Fix = ["Try again", "totem auth"];
const PASTE: Fix = ["No browser on this machine", "totem auth --paste"];

// ── getting tokens ────────────────────────────────────────────────────────

async function browserFlow(io: Io, deps: AuthDeps, browser: FoundBrowser): Promise<WhoopLogin> {
  const { ui } = io;
  ui.para(
    `A ${browser.name} window opens on WHOOP's site with a temporary profile. Log in there. totem never sees what you type: ` +
    "it waits for WHOOP's session cookies, then closes the window and deletes the profile.",
  );
  const tokens = await ui.task("Waiting for you to log in in the browser", () => deps.captureBrowserLogin({ browser }), { slow: true });
  return loginFromCookies(tokens);
}

async function pasteFlow(io: Io, deps: AuthDeps): Promise<WhoopLogin | null> {
  const { ui } = io;
  const { g } = ui.kit;
  ui.para("Paste the whoop-auth-refresh-token cookie from a browser that is logged in to app.whoop.com. To find it there:");
  ui.hint(`DevTools ${g.arrow} Application ${g.arrow} Cookies ${g.arrow} app.whoop.com ${g.arrow} whoop-auth-refresh-token`);
  const token = (await ui.hidden("Cookie value")).trim();
  if (!token) {
    ui.problem("No cookie value was entered.", { fix: [["Try again", "totem auth --paste"]] });
    return null;
  }
  const login = await ui.task("Checking the token with WHOOP", () => deps.loginWithRefreshToken(token));
  ui.ok("WHOOP accepted the token");
  return login;
}

async function getLogin(io: Io, deps: AuthDeps, flags: AuthFlags): Promise<WhoopLogin | null> {
  const { ui, sys } = io;
  if (flags.paste) return pasteFlow(io, deps);
  const env = flags.browser ? { ...sys.env, TOTEM_BROWSER: flags.browser } : sys.env;
  const browser = deps.findBrowser({ env });
  if (!browser) {
    ui.warn(flags.browser ? `No browser at ${flags.browser}.` : `No ${SUPPORTED_BROWSERS} found on this machine.`);
    ui.hint("Using a pasted cookie instead. To use a browser, set TOTEM_BROWSER to its path and run totem auth again.");
    return pasteFlow(io, deps);
  }
  return browserFlow(io, deps, browser);
}

function loginFailed(io: Io, error: unknown, flags: AuthFlags): void {
  const { ui } = io;
  if (error instanceof BrowserLoginError) {
    const what = error.reason === "closed" ? "The browser window was closed before the login finished."
      : error.reason === "timeout" ? `${error.message.replace(/\.$/, "")}.`
      : `The browser didn't start: ${error.message.replace(/\.$/, "")}.`;
    const fix: Fix[] = error.reason === "launch"
      ? [["Use another browser", "TOTEM_BROWSER=/path/to/browser totem auth"], PASTE]
      : [AGAIN, PASTE];
    ui.problem(what, { fix });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  ui.problem(flags.paste ? "WHOOP didn't accept that token." : "The login didn't complete.", {
    detail: message,
    fix: flags.paste ? [["Copy the cookie again, then", "totem auth --paste"]] : [AGAIN, PASTE],
  });
}

// ── status ────────────────────────────────────────────────────────────────

function localRows(local: LocalStatus, home: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [["Token file", tildify(local.tokenFile, home)]];
  if (local.state === "tokens") {
    rows.push(["Login", `saved ${when(local.savedAt)} (${local.source ?? "unknown source"})`]);
    if (local.refreshedAt) rows.push(["Last refresh", when(local.refreshedAt)]);
    if (local.accessExpiresAt) rows.push(["Access token", `expires ${when(local.accessExpiresAt)}`]);
    rows.push(["Kept fresh by", local.owner ? `totem server, pid ${local.owner.pid} on ${local.owner.host}` : "no running server right now"]);
  } else if (local.state === "handed-off") {
    rows.push(["Login", `none here: handed to the server on ${when(local.savedAt)}`]);
  } else {
    rows.push(["Login", local.state === "none" ? "none" : "the token file can't be read"]);
  }
  return rows;
}

function remoteRows(s: RemoteStatus): Array<[string, string]> {
  const rows: Array<[string, string]> = [["State", `${s.state ?? "unknown"}${s.role ? ` (${s.role})` : ""}`]];
  if (s.source) rows.push(["Logged in via", s.source]);
  if (s.access_expires_at) rows.push(["Access token", `expires ${when(s.access_expires_at)}`]);
  if (s.refreshed_at) rows.push(["Last refresh", when(s.refreshed_at)]);
  if (s.next_keepalive_at) rows.push(["Next refresh", when(s.next_keepalive_at)]);
  if (s.durable !== undefined && s.durable !== null) rows.push(["Storage", s.durable ? "a volume: survives restarts" : "not a volume: lost on restart"]);
  return rows;
}

function pushFailure(r: Extract<PushResult, { ok: false }>, url: string): { what: string; detail?: string | undefined; fix?: Fix[] | undefined } {
  switch (r.reason) {
    case "not-found":
      return { what: `${url} runs an older totem that can't receive a login.`, fix: [["Update the server", "totem deploy"], ["Then", "totem auth"]] };
    case "unreachable":
      return { what: `Couldn't reach ${url}.`, detail: r.detail, fix: [["Check the server", "totem status"]] };
    case "unauthorized":
      return { what: `${url} rejected the MCP_AUTH_TOKEN.` };
    case "insecure":
      return { what: r.detail };
    case "redirected":
      return { what: `${url} answered with a redirect (${r.detail}).`, detail: "totem doesn't follow a redirect with the login in hand. Use the server's final https:// address.", fix: [["With that address", "totem auth --url <https address>"]] };
    default:
      return { what: `${url} refused the login${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}.`, detail: r.detail || undefined };
  }
}

async function showStatus(root: string, flags: AuthFlags, io: Io, deps: AuthDeps): Promise<number> {
  const { ui, sys } = io;
  const env = deps.cliEnv(resolve(root, ".env"));
  const local = deps.readLocalStatus(resolveTokenFilePath(env));
  ui.header("totem auth --status", "Where the WHOOP login lives and when it was last refreshed.");
  ui.line(ui.kit.c.bold("This computer"));
  ui.rows(localRows(local, sys.home));
  const target = resolveAuthTarget(readDeployRecord(root), { url: flags.url }, env);
  if (target.kind !== "remote") {
    if (local.state === "none" || local.state === "unreadable") ui.error("No WHOOP login yet.", { fix: [["Log in", "totem auth"]] });
    return local.state === "none" || local.state === "unreadable" ? 1 : 0;
  }
  ui.section(`Deployment  ${target.url}`);
  const adminToken = target.adminToken || env.TOTEM_ADMIN_TOKEN || env.MCP_AUTH_TOKEN;
  if (!adminToken) {
    ui.warn("totem has no MCP_AUTH_TOKEN recorded for this server, so it can't ask it.");
    ui.hint("Log in again to record it: totem auth");
    return 0;
  }
  const r = await ui.task("Asking the server", () => deps.fetchRemoteStatus(target.url, adminToken, { allowHttp: flags.allowHttp }));
  if (r.ok) {
    ui.rows(remoteRows(r.status));
    if (r.status.detail) ui.warn(r.status.detail);
    if (r.status.durable === false) ui.warn("After a restart or redeploy this server needs a new login: totem auth");
    return 0;
  }
  const f = pushFailure(r, target.url);
  ui.problem(f.what, { detail: f.detail, fix: f.fix ?? [["Check the server", "totem status"]] });
  return 1;
}

// ── sending to a deployment ───────────────────────────────────────────────

async function pushToDeployment(
  root: string,
  target: Extract<AuthTarget, { kind: "remote" }>,
  login: WhoopLogin,
  userId: number | null,
  allowHttp: boolean,
  io: Io,
  deps: AuthDeps,
): Promise<{ ok: boolean; status?: RemoteStatus }> {
  const { ui } = io;
  const env = deps.cliEnv(resolve(root, ".env"));
  let token = target.adminToken || env.TOTEM_ADMIN_TOKEN || env.MCP_AUTH_TOKEN || "";
  let prompted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!token) {
      if (!ui.canAsk) break;
      ui.para(`totem needs this server's MCP_AUTH_TOKEN (set when it was deployed) to hand it the login.`);
      token = (await ui.hidden("MCP_AUTH_TOKEN")).trim();
      prompted = true;
      if (!token) break;
    }
    const sending = token;
    const r = await ui.task(`Sending the login to ${target.url}`, () => deps.pushLogin(target.url, sending, login, { userId }, { allowHttp }));
    if (r.ok) {
      const record = readDeployRecord(root);
      if (prompted && record?.url && record.url.replace(/\/+$/, "") === target.url) {
        updateDeployRecord(root, { mcp_auth_token: token });
        ui.hint("Saved the MCP_AUTH_TOKEN in .totem-deploy.json (readable only by you).");
      }
      return { ok: true, status: r.status };
    }
    const f = pushFailure(r, target.url);
    if (r.reason !== "unauthorized") {
      ui.problem(f.what, {
        detail: `${f.detail ? `${f.detail.replace(/\.$/, "")}. ` : ""}The new login was not saved anywhere.`,
        fix: [...(f.fix ?? []), ["Then log in again", "totem auth"]],
      });
      return { ok: false };
    }
    ui.fail(f.what);
    token = "";
  }
  if (!token) {
    ui.problem("totem has no working MCP_AUTH_TOKEN for this server.", {
      detail: "It is the MCP_AUTH_TOKEN secret set on the host when the server was deployed. The new login was not saved anywhere.",
      fix: [["Log in again with it", "TOTEM_ADMIN_TOKEN=<token> totem auth"]],
    });
  }
  return { ok: false };
}

// ── main ──────────────────────────────────────────────────────────────────

export interface RunAuthOptions {
  /** Where the login goes, overriding flags and the deploy record (used by `totem cloud`). */
  target?: AuthTarget;
  /** Part of a guided flow: no header of its own. */
  embedded?: boolean;
}

export async function runAuth(
  root: string,
  argv: string[] = [],
  opts: RunAuthOptions = {},
  io: Io = realIo(),
  deps: AuthDeps = io.auth ?? realAuthDeps,
): Promise<number> {
  const { ui, sys } = io;
  const flags = parseAuthFlags(argv);
  if (flags.status) return showStatus(root, flags, io, deps);

  const envPath = resolve(root, ".env");
  const env = deps.cliEnv(envPath);
  const target = opts.target ?? resolveAuthTarget(readDeployRecord(root), flags, env);
  const localFile = resolveTokenFilePath(env);
  if (!opts.embedded) {
    ui.header("totem auth", target.kind === "remote"
      ? `Log in to WHOOP. The login goes to ${target.url}.`
      : "Log in to WHOOP. The login is saved on this computer.");
  }
  if (target.kind === "remote") {
    // Before anyone logs in: the login must have somewhere safe to go.
    const safe = checkPushUrl(target.url, { allowHttp: flags.allowHttp });
    if (!safe.ok) {
      ui.problem(safe.reason, { fix: [["With its https address", "totem auth --url <https address>"]] });
      return 1;
    }
  }

  let login: WhoopLogin | null;
  try {
    login = await getLogin(io, deps, flags);
  } catch (error) {
    loginFailed(io, error, flags);
    return 1;
  }
  if (!login) return 1;

  const existing = deps.readTokenFile(localFile);
  const installationId = deps.pickInstallationId(existing, env);
  const accessToken = login.accessToken;
  const check = await ui.task("Confirming the login with WHOOP", () => deps.validateLogin(accessToken, { installationId }));
  if (check.accepted === false) {
    ui.problem(`WHOOP rejected the new login (HTTP ${check.status}). Nothing was saved.`, { fix: [AGAIN] });
    return 1;
  }
  if (check.accepted) ui.ok("Logged in to WHOOP", check.userId ? `user ${check.userId}` : undefined);
  else ui.warn(`Couldn't confirm the login with WHOOP (${check.status ? `HTTP ${check.status}` : check.detail ?? "no answer"}). Keeping it anyway.`);

  if (target.kind === "local") {
    deps.saveLocalLogin(target.tokenFile, login, { userId: check.userId, installationId });
    ui.ok("Login saved", tildify(target.tokenFile, sys.home));
    const retired = deps.retireLegacyEnv(envPath);
    if (retired.length) ui.ok(`Removed ${retired.join(", ")} from .env`, "no longer used");
    if (!opts.embedded) ui.hint("A running totem server picks it up on its next request.");
    return 0;
  }

  const pushed = await pushToDeployment(root, target, login, check.userId, flags.allowHttp, io, deps);
  if (!pushed.ok) return 1;
  ui.ok("Login sent to the server", target.url);
  if (pushed.status?.durable === false) {
    ui.warn("This server has no volume for its token file. After a restart or redeploy it needs a new login: totem auth");
  }
  const handoff = deps.markHandedOff(localFile, target.url, { userId: check.userId, installationId });
  ui.hint(handoff.keptLocalLogin
    ? `The server keeps it fresh from now on. Your separate login on this computer (${tildify(localFile, sys.home)}) is unchanged.`
    : "The server keeps it fresh from now on. No copy stays on this computer.");
  const retired = deps.retireLegacyEnv(envPath);
  if (retired.length) ui.ok(`Removed ${retired.join(", ")} from .env`, "no longer used");
  return 0;
}
