// The Connect page (GET /connect, and / sends people there): on a cloud
// server, one page with a button or a copy-ready step for every app totem
// works with, already filled in with this server's address.
//
// The links come from src/lib/install_links.ts. Nothing secret is on the page:
// only the server's public address, which anyone visiting already has. The
// connector password is asked for later, on the consent page, by each app's
// own sign-in.
//
// Like the consent page it loads nothing but its own typeface and favicon. It has one
// small script, allowed by hash, for the Copy buttons; without it the text is
// still there to select.
import { createHash } from "node:crypto";
import type { Response } from "express";
import { CLIENT_LOGOS } from "./consent_logos.js";
import { CONSENT_FONT_PATH } from "./consent_page.js";
import { FAVICON_LINK, TOTEM_MARK } from "../lib/brand.js";
import {
  antigravityEntry, claudeConnectorLink, cursorInstallLink, remoteCommands, vscodeInstallLink,
} from "../lib/install_links.js";

const CSS = `
@font-face { font-family: "Manrope"; src: url("${CONSENT_FONT_PATH}") format("woff2"); font-weight: 400 700; font-style: normal; font-display: swap; }
:root {
  color-scheme: light dark;
  --page: #f6f8fb; --box: #ffffff; --fg: #141414; --dim: #5d6672; --line: #e2e7ee; --soft: #f0f4f9;
  --go: #141414; --on: #b7d3f2; --shadow: 0 1px 2px rgba(20, 20, 20, .05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #141414; --box: #1b1d20; --fg: #eef2f7; --dim: #9ba4af; --line: #2b2f34; --soft: #17191b;
    --go: #b7d3f2; --on: #141414; --shadow: none;
  }
}
* { box-sizing: border-box; margin: 0; }
html { background: var(--page); color: var(--fg); font: 15px/1.5 "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
body { min-height: 100vh; padding: 24px 18px 48px; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 20px; letter-spacing: -.01em; }
.brand svg { width: 24px; height: 24px; border-radius: 6px; }
main { max-width: 1080px; margin: clamp(18px, 5vh, 56px) auto 0; }
h1 { font-size: 27px; font-weight: 450; letter-spacing: -.01em; line-height: 1.2; }
.lead { color: var(--dim); margin: 10px 0 26px; max-width: 60ch; }
.label { font-weight: 550; margin-bottom: 6px; }
.box { background: var(--box); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.copyrow { display: flex; align-items: stretch; gap: 0; overflow: hidden; }
.copyrow code { flex: 1; min-width: 0; padding: 13px 14px; font: 14px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace; overflow-wrap: anywhere; white-space: pre-wrap; user-select: all; }
.copyrow button { flex: none; border: 0; border-left: 1px solid var(--line); background: var(--soft); color: var(--fg); font: inherit; font-weight: 550; padding: 0 16px; cursor: pointer; min-width: 78px; }
.copyrow button:focus-visible, .add:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.apps { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; margin-top: 30px; }
.app { padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.head { display: flex; align-items: center; gap: 14px; }
.tile { flex: none; width: 42px; height: 42px; border: 1px solid var(--line); border-radius: 11px; display: grid; place-items: center; }
.tile svg { width: 24px; height: 24px; }
.head b { display: block; font-weight: 600; }
.head span { color: var(--dim); font-size: 14px; }
.add { align-self: flex-start; display: inline-block; background: var(--go); color: var(--on); border-radius: 11px; padding: 10px 16px; font-weight: 550; text-decoration: none; }
.step { color: var(--dim); font-size: 14px; }
.step b { color: var(--fg); font-weight: 550; }
.foot { color: var(--dim); font-size: 13px; margin-top: 34px; }
@media (min-width: 860px) {
  body { padding: 26px 44px 60px; }
  .apps { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
}
@media (forced-colors: active) { .box, .tile, .add, .copyrow button { border: 1px solid CanvasText; } }
`;

// Copy: the clipboard API, else select the text and copy it the older way,
// else leave it selected and say so.
const SCRIPT = `function said(b,t){b.textContent=t;setTimeout(function(){b.textContent="Copy"},1800)}document.addEventListener("click",function(e){var b=e.target.closest("button[data-copy]");if(!b)return;var text=b.getAttribute("data-copy"),code=b.previousElementSibling;function select(){var r=document.createRange();r.selectNodeContents(code);var s=getSelection();s.removeAllRanges();s.addRange(r);var ok=false;try{ok=document.execCommand("copy")}catch(x){}said(b,ok?"Copied":"Selected")}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){said(b,"Copied")},select)}else{select()}});`;

const hash = (s: string): string => createHash("sha256").update(s).digest("base64");

/** Nothing loads or runs except this page's stylesheet and Copy script (by hash), its typeface and its favicon. */
export const CONNECT_CSP = `default-src 'none'; style-src 'sha256-${hash(CSS)}'; script-src 'sha256-${hash(SCRIPT)}'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function setConnectSecurityHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", CONNECT_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const copyRow = (text: string, label: string): string =>
  `<div class="box copyrow"><code>${esc(text)}</code><button type="button" data-copy="${esc(text)}" aria-label="Copy ${esc(label)}">Copy</button></div>`;

interface Card { logo: keyof typeof CLIENT_LOGOS; name: string; where: string; body: string }

const card = (c: Card): string =>
  `<section class="box app"><div class="head"><span class="tile">${CLIENT_LOGOS[c.logo]}</span><div><b>${esc(c.name)}</b><span>${esc(c.where)}</span></div></div>${c.body}</section>`;

/** The apps, in the order people most often have them. */
export function connectCards(mcpUrl: string): Card[] {
  const cmd = remoteCommands(mcpUrl);
  const link = (href: string, text: string): string => `<a class="add" href="${esc(href)}">${esc(text)}</a>`;
  return [
    {
      logo: "claude", name: "Claude", where: "claude.ai, Claude Desktop and the mobile apps",
      body: `${link(claudeConnectorLink(mcpUrl), "Add to Claude")}<p class="step">Opens claude.ai with the connector filled in: press <b>Add</b>, then <b>Connect</b>. It shows up in Claude Desktop and on your phone too.</p>`,
    },
    {
      logo: "openai", name: "ChatGPT", where: "chatgpt.com, the ChatGPT desktop app and Codex",
      body: `<p class="step">On chatgpt.com: <b>Plugins</b> → <b>Add</b> (top right) → <b>Add custom MCP server</b>. Paste the address above, tick the box, then <b>Create as a plugin</b> and <b>Continue</b>.</p><p class="step">For the desktop app and Codex, run this in a terminal (it opens the sign-in itself):</p>${copyRow(cmd.codex, "the Codex command")}`,
    },
    {
      logo: "claude", name: "Claude Code", where: "in a terminal",
      body: `${copyRow(cmd.claudeCode, "the Claude Code command")}<p class="step">Then sign in: <b>claude mcp login whoop</b>, or <b>/mcp</b> inside Claude Code.</p>`,
    },
    {
      logo: "cursor", name: "Cursor", where: "the editor",
      body: `${link(cursorInstallLink({ url: mcpUrl }), "Add to Cursor")}<p class="step">Cursor asks to install the server; then log in from <b>Settings → MCP → whoop</b>.</p>`,
    },
    {
      logo: "vscode", name: "VS Code", where: "with GitHub Copilot",
      body: `${link(vscodeInstallLink({ type: "http", url: mcpUrl }), "Add to VS Code")}<p class="step">VS Code asks to install the server, then opens the sign-in when Copilot first uses it.</p>`,
    },
    {
      logo: "opencode", name: "OpenCode", where: "the terminal and desktop apps, versions 1 and 2",
      body: `${copyRow(cmd.opencode, "the OpenCode command")}<p class="step">Then sign in: <b>opencode mcp auth whoop</b>, or <b>/mcps</b> inside OpenCode.</p>`,
    },
    {
      logo: "antigravity", name: "Antigravity", where: "Google's agent app",
      body: `<p class="step">Add this to <b>~/.gemini/config/mcp_config.json</b> (merge it with what is there), then sign in from the app's MCP settings:</p>${copyRow(antigravityEntry(mcpUrl), "the Antigravity entry")}`,
    },
  ];
}

export function renderConnectPage(d: { mcpUrl: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
${FAVICON_LINK}
<title>Connect your apps · totem</title>
<style>${CSS}</style>
</head>
<body>
  <p class="brand">${TOTEM_MARK}totem</p>
  <main>
    <h1>Connect your apps to WHOOP</h1>
    <p class="lead">Add this server to the apps you use. Each one then opens totem's sign-in page, where you enter your connector password.</p>
    <p class="label">Server address</p>
    ${copyRow(d.mcpUrl, "the server address")}
    <div class="apps">
${connectCards(d.mcpUrl).map((c) => `      ${card(c)}`).join("\n")}
    </div>
    <p class="foot">totem is open source and not affiliated with WHOOP.</p>
  </main>
  <script>${SCRIPT}</script>
</body>
</html>`;
}
