// The consent page: the one page of totem a person sees in a browser.
//
// A client (Claude, ChatGPT, an editor, a terminal tool) has asked to connect,
// and the server asks its owner for the connector password before it hands out
// access to their health data. The page says who is asking, where access will
// be sent, what the client will be able to do, and offers Authorize and Deny.
//
// It is a password form on a public URL, so it is built to be boring and safe:
// one document, no scripts, nothing loaded from anywhere except its own
// typeface and favicon from this same server. Logos, totem's included, are
// inline SVG. Every value it shows or posts back goes through esc().
import { createHash } from "node:crypto";
import type { Response } from "express";
import { CLIENT_LOGOS, type ClientLogoId } from "./consent_logos.js";
import { FAVICON_LINK, TOTEM_MARK } from "../lib/brand.js";

/** Where the page's typeface is served from (see consentFont in consent_font.ts). */
export const CONSENT_FONT_PATH = "/oauth/consent/manrope.woff2";

// The page's only stylesheet. Kept as one constant because the
// Content-Security-Policy below allows exactly this text (by its hash) and no
// other style, inline or external.
const CONSENT_CSS = `
@font-face { font-family: "Manrope"; src: url("${CONSENT_FONT_PATH}") format("woff2"); font-weight: 400 700; font-style: normal; font-display: swap; }
:root {
  color-scheme: light dark;
  --page: #f6f8fb; --box: #ffffff; --fg: #141414; --dim: #5d6672; --line: #e2e7ee; --soft: #f0f4f9;
  --go: #141414; --on: #ffffff; --error: #b3261e; --shadow: 0 1px 2px rgba(20, 20, 20, .05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #141414; --box: #1b1d20; --fg: #eef2f7; --dim: #9ba4af; --line: #2b2f34; --soft: #17191b;
    --go: #ffffff; --on: #141414; --error: #ff8f85; --shadow: none;
  }
}
* { box-sizing: border-box; margin: 0; }
html { background: var(--page); color: var(--fg); font: 15px/1.5 "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
body { min-height: 100vh; padding: 24px 22px 48px; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 20px; letter-spacing: -.01em; }
.brand svg { width: 27px; height: 24px; }
form { max-width: 1080px; margin: clamp(18px, 6vh, 60px) auto 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 36px; }
section { min-width: 0; }
h1 { font-size: 27px; font-weight: 450; letter-spacing: -.01em; line-height: 1.2; margin-bottom: 20px; overflow-wrap: anywhere; }
h2 { font-size: 17px; font-weight: 550; margin-bottom: 16px; }
.box { background: var(--box); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.who { display: flex; align-items: center; gap: 16px; padding: 18px; }
.tile { flex: none; width: 46px; height: 46px; border: 1px solid var(--line); border-radius: 11px; display: grid; place-items: center; font-weight: 650; font-size: 18px; color: var(--fg); }
.tile svg { width: 26px; height: 26px; }
.who div { min-width: 0; }
.who b { display: block; font-weight: 550; overflow-wrap: anywhere; }
.who span { color: var(--dim); }
.sent { color: var(--dim); margin: 14px 0 22px; }
.sent b { color: var(--fg); font-weight: 550; overflow-wrap: anywhere; }
label { display: block; font-weight: 550; margin-bottom: 6px; }
.pw { overflow: hidden; }
.pw input { display: block; width: 100%; border: 0; background: none; color: var(--fg); font: inherit; font-size: 16px; padding: 15px 14px; outline: 0; }
.pw:focus-within { border-color: var(--fg); }
.pw p { background: var(--soft); border-top: 1px solid var(--line); color: var(--dim); padding: 10px 14px; }
.pw.bad { border-color: var(--error); }
.error { color: var(--error); font-weight: 550; margin-top: 10px; }
ul { list-style: none; padding: 0; }
li { padding: 12px 16px; font-weight: 500; }
li + li { border-top: 1px solid var(--line); }
.note { color: var(--dim); margin: 14px 0 22px; }
.acts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
button { font: inherit; font-weight: 550; padding: 12px; border-radius: 11px; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.go { background: var(--go); color: var(--on); border: 1px solid var(--go); }
.deny { background: var(--box); color: var(--fg); border: 1px solid var(--line); order: -1; }
@media (min-width: 860px) {
  body { padding: 26px 44px 60px; }
  form { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 38px; margin-top: clamp(18px, calc(50vh - 390px), 170px); }
}
@media (forced-colors: active) {
  .box, .tile, button { border: 1px solid CanvasText; }
}
`;

const CONSENT_CSS_HASH = createHash("sha256").update(CONSENT_CSS).digest("base64");

/**
 * The consent page's Content-Security-Policy: nothing may load or run, with
 * these exceptions: the one stylesheet above, by hash, and the page's typeface
 * and favicon from this server only. No scripts, frames or connections; no
 * <base>; no framing.
 *
 * It deliberately has NO `form-action`: that directive also governs where the
 * form's response may redirect, and the whole point of this form is a 302 to
 * the client's own origin (claude.ai, a loopback port, an app's scheme). With
 * `form-action 'self'` the browser refuses that redirect and the password
 * submit silently goes nowhere. `default-src` does not stand in for
 * `form-action`, so leaving it out leaves the redirect alone.
 */
export const CONSENT_CSP = `default-src 'none'; style-src 'sha256-${CONSENT_CSS_HASH}'; font-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'`;

// Security headers for the HTML consent page (a password form) ONLY. A
// document CSP or X-Frame-Options on the JSON metadata and API responses made
// Claude's connector flag a "server configuration issue", so these are never
// set globally.
export function setConsentSecurityHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", CONSENT_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

const isLoopback = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/**
 * Who receives the authorization code, for display on the consent page.
 *
 * Client registration is open to anyone, so a link to this server's own
 * /authorize can carry an attacker's client and redirect URI. The page used to
 * say "connect this server to Claude" whatever the redirect was: the owner saw
 * their own server asking for their password, and typing it sent the code (and
 * with it their health data) to the attacker's site. Name the destination.
 */
export function redirectDestination(redirectUri: string): string {
  if (!URL.canParse(redirectUri)) return "an unrecognised address";
  const { protocol, hostname, host } = new URL(redirectUri);
  if (isLoopback(hostname)) return `an app on this device (${host})`;
  // A non-https destination (http, or an app's custom scheme) shows its scheme.
  return protocol === "https:" ? host : `${protocol}//${host}`;
}

/** Who is asking, as the page shows it. */
export interface ConsentClient {
  /** "Claude", "ChatGPT", "Claude Code", or the address itself when totem doesn't know it. */
  name: string;
  /** A real logo only for a client totem recognises; otherwise the tile shows a globe. */
  logo: ClientLogoId | null;
  /** Where access is sent: always the real destination, whatever the name says. */
  destination: string;
}

// Web clients, named by the address the authorization code is actually sent to.
// Exact hosts only: a lookalike host gets no name and no logo.
const SITES: Record<string, { name: string; logo: ClientLogoId }> = {
  "claude.ai": { name: "Claude", logo: "claude" },
  "claude.com": { name: "Claude", logo: "claude" },
  "chatgpt.com": { name: "ChatGPT", logo: "openai" },
  "chat.openai.com": { name: "ChatGPT", logo: "openai" },
  "vscode.dev": { name: "VS Code", logo: "vscode" },
  "insiders.vscode.dev": { name: "VS Code", logo: "vscode" },
  // Cursor's web agents and Antigravity sign in through their own sites.
  "www.cursor.com": { name: "Cursor", logo: "cursor" },
  "cursor.com": { name: "Cursor", logo: "cursor" },
  "antigravity.google": { name: "Antigravity", logo: "antigravity" },
};

// Apps that take the redirect through their own URL scheme.
const SCHEMES: Record<string, { name: string; logo: ClientLogoId }> = {
  "cursor:": { name: "Cursor", logo: "cursor" },
  "vscode:": { name: "VS Code", logo: "vscode" },
  "vscode-insiders:": { name: "VS Code", logo: "vscode" },
};

// Apps on the owner's own device, recognised by the name they register with.
// First match wins, so "Claude Code" is tested before a bare "Claude".
const DEVICE_APPS: Array<{ match: RegExp; name: string; logo: ClientLogoId }> = [
  { match: /claude[\s_-]*code/i, name: "Claude Code", logo: "claude" },
  { match: /\bclaude\b/i, name: "Claude", logo: "claude" },
  { match: /codex/i, name: "Codex", logo: "openai" },
  { match: /chatgpt|openai/i, name: "ChatGPT", logo: "openai" },
  { match: /opencode/i, name: "OpenCode", logo: "opencode" },
  { match: /cursor/i, name: "Cursor", logo: "cursor" },
  { match: /visual studio code|vs[\s_-]?code|github copilot/i, name: "VS Code", logo: "vscode" },
  { match: /antigravity/i, name: "Antigravity", logo: "antigravity" },
];

const GENERIC_DEVICE_APP = "An app on this device";

/** A registered client name made safe to keep and show: one line, printable, short. */
export function cleanClientName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 60) : undefined;
}

/**
 * Who is asking. The rule that keeps this honest:
 *
 *  - A destination on the internet is named by its address and nothing else. A
 *    client may register under any name it likes ("Claude"), so that name is
 *    ignored: only the known addresses get a name and a logo, and anything else
 *    shows as the address it is.
 *  - A destination on this device (a loopback port) cannot be reached by anyone
 *    else, so the name the app registered with is shown. Terminal and desktop
 *    clients (Claude Code, Codex, OpenCode, editors) all connect this way.
 *
 * Either way "Access will be sent to …" states the real destination.
 */
export function consentClient(redirectUri: string, registeredName?: string): ConsentClient {
  const destination = redirectDestination(redirectUri);
  if (!URL.canParse(redirectUri)) return { name: destination, logo: null, destination };
  const { protocol, hostname } = new URL(redirectUri);
  if (isLoopback(hostname)) {
    const declared = cleanClientName(registeredName);
    const known = declared ? DEVICE_APPS.find((app) => app.match.test(declared)) : undefined;
    if (known) return { name: known.name, logo: known.logo, destination };
    return { name: declared ?? GENERIC_DEVICE_APP, logo: null, destination };
  }
  const known = protocol === "https:" ? SITES[hostname] : SCHEMES[protocol];
  return known ? { ...known, destination } : { name: destination, logo: null, destination };
}

/** What a connected client can do, in plain words. The 41 tools, grouped. */
export const CONSENT_PERMISSIONS = [
  "Read recovery, sleep and strain",
  "Read stress, trends and heart rate",
  "Read Healthspan, lab results and AFib history",
  "Read workouts and lifts",
  "Write activities and lifts",
  "Read and write journal, weight and cycle",
  "WHOOP Coach and its memory",
  "Write profile, alarms and settings",
] as const;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The tile for a client totem doesn't recognise: a plain globe. (It used to be
 * the first letter of the name, which read as a logo the client didn't have.)
 */
export const UNKNOWN_CLIENT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/><path d="M2.8 12h18.4"/><path d="M12 2.8c2.6 2.5 3.9 5.6 3.9 9.2s-1.3 6.7-3.9 9.2c-2.6-2.5-3.9-5.6-3.9-9.2s1.3-6.7 3.9-9.2z"/><path d="M4.4 7.4h15.2M4.4 16.6h15.2"/></svg>`;

/** The tile: a recognised client's logo, or the globe. */
function tile(client: ConsentClient): string {
  return client.logo ? CLIENT_LOGOS[client.logo] : UNKNOWN_CLIENT_ICON;
}

/**
 * The page: who is asking and where access goes, the password, what the client
 * will be able to do, then Deny and Authorize.
 *
 * Reading order is the security order: the name and the real destination come
 * before the password field. On a wrong password the same page comes back with
 * the error next to the field and every hidden field intact, so trying again
 * is one keystroke away; the error is announced (role="alert") and tied to the
 * field (aria-invalid, aria-describedby).
 *
 * Authorize comes first in the markup so that pressing Enter in the password
 * field authorizes (a form's first submit button is its default); CSS puts
 * Deny on the left. Deny skips the password (formnovalidate).
 */
export function renderConsentForm(d: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: string;
  resource: string;
  error: boolean;
  /** The name the client registered with. Only ever shown for a client on this device. */
  clientName?: string | undefined;
}): string {
  const client = consentClient(d.redirectUri, d.clientName);
  const name = esc(client.name);
  // Mid-sentence, the generic device app reads as "an app on this device".
  const inSentence = client.name === GENERIC_DEVICE_APP ? "an app on this device" : name;
  const from = client.name === GENERIC_DEVICE_APP || client.name === client.destination ? "there" : name;
  const error = d.error ? `\n        <p class="error" id="pw-error" role="alert">Incorrect password. Try again.</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
${FAVICON_LINK}
<title>${d.error ? "Incorrect password" : `Authorize ${name}`} · totem</title>
<style>${CONSENT_CSS}</style>
</head>
<body>
  <p class="brand">${TOTEM_MARK}totem</p>
  <main>
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="client_id" value="${esc(d.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(d.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${esc(d.codeChallenge)}">
      <input type="hidden" name="state" value="${esc(d.state)}">
      <input type="hidden" name="scope" value="${esc(d.scopes)}">
      <input type="hidden" name="resource" value="${esc(d.resource)}">
      <input type="text" name="username" value="totem connector" autocomplete="username" readonly hidden>
      <section>
        <h1>Allow ${inSentence} to access WHOOP</h1>
        <div class="box who"><span class="tile">${tile(client)}</span><div><b>${name}</b><span>Connecting through your totem server</span></div></div>
        <p class="sent">Access will be sent to <b>${esc(client.destination)}</b>.</p>
        <label for="pw">Connector password</label>
        <div class="box pw${d.error ? " bad" : ""}"><input type="password" id="pw" name="password" required autofocus autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-describedby="${d.error ? "pw-error pw-help" : "pw-help"}"${d.error ? ' aria-invalid="true"' : ""}><p id="pw-help">The one totem cloud gave you</p></div>${error}
      </section>
      <section>
        <h2>Requested permissions</h2>
        <ul class="box">
${CONSENT_PERMISSIONS.map((p) => `          <li>${esc(p)}</li>`).join("\n")}
        </ul>
        <p class="note">By authorizing, you allow ${inSentence} to use your WHOOP account through this server with the permissions listed above. Only continue if you started this from ${from}.</p>
        <div class="acts"><button type="submit" name="decision" value="allow" class="go">Authorize</button><button type="submit" name="decision" value="deny" class="deny" formnovalidate>Deny</button></div>
      </section>
    </form>
  </main>
</body>
</html>`;
}

/** Shown when Deny (or anything else) can't be sent back to the client: nowhere safe to redirect. */
export function renderConsentClosed(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
${FAVICON_LINK}
<title>totem</title>
<style>${CONSENT_CSS}</style>
</head>
<body>
  <p class="brand">${TOTEM_MARK}totem</p>
  <main><form><section><h1>${esc(message)}</h1><p class="sent">You can close this page.</p></section></form></main>
</body>
</html>`;
}
