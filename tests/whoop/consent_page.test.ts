// The consent page: the one page of totem a person sees in a browser. It asks
// for a password on a public URL, so these tests hold it to being one
// script-free document that says who is asking and where access really goes,
// lets the owner say no, works without colour or a mouse, and comes back
// usable after a wrong password.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHttpServer, type HttpServerHandle } from "../../src/server-http.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { CONSENT_CSP, CONSENT_FONT_PATH, CONSENT_PERMISSIONS, UNKNOWN_CLIENT_ICON, cleanClientName, consentClient, renderConsentForm } from "../../src/whoop/consent_page.js";
import { CLIENT_LOGOS } from "../../src/whoop/consent_logos.js";
import { consentFont } from "../../src/whoop/consent_font.js";

const base = {
  clientId: "c.client-id", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "challenge",
  state: "state-123", scopes: "a b", resource: "https://totem.example.com/mcp",
};
const page = (over: Partial<typeof base> & { error?: boolean; clientName?: string } = {}): string => renderConsentForm({ ...base, error: false, ...over });
const LOOPBACK = "http://127.0.0.1:53124/callback";
/** Every opening tag in the page, lower-cased. */
const tags = (html: string): string[] => [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b/g)].map((m) => m[1]!.toLowerCase());
const attr = (html: string, tag: RegExp, name: string): string | null => {
  const el = html.match(tag)?.[0] ?? "";
  return el.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
};
const heading = (html: string): string => html.match(/<h1>([\s\S]*?)<\/h1>/)![1]!;
const tile = (html: string): string => html.match(/<span class="tile">([\s\S]*?)<\/span><div>/)![1]!;
const sentTo = (html: string): string => html.match(/<p class="sent">Access will be sent to <b>([\s\S]*?)<\/b>\.<\/p>/)![1]!;

describe("consent page: one document that loads only its own typeface and favicon", () => {
  const html = page();

  it("has no scripts, images, frames, links (bar its favicon) or inline handlers", () => {
    for (const forbidden of ["script", "img", "image", "iframe", "object", "embed", "video", "audio", "base", "foreignobject", "use"]) expect(tags(html), forbidden).not.toContain(forbidden);
    // One link: the favicon, from this server.
    expect([...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])).toEqual(['<link rel="icon" href="/favicon.svg" type="image/svg+xml">']);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);       // no onclick= etc.
    expect(html).not.toMatch(/\sstyle\s*=/i);          // no inline style attributes (the CSP would drop them), logos included
    expect(html).not.toMatch(/@import/i);
    // No src, and no href but the favicon's: the form's action is the only other address in the markup.
    expect([...html.matchAll(/\b(?:src|href|xlink:href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1])).toEqual(["/favicon.svg"]);
    expect(attr(html, /<form\b[^>]*>/, "action")).toBe("/oauth/consent");
    expect(attr(html, /<form\b[^>]*>/, "method")).toBe("POST");
  });

  it("loads exactly one thing: its typeface, from this server", () => {
    const urls = [...html.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls).toEqual([`"${CONSENT_FONT_PATH}"`]);
    expect(CONSENT_FONT_PATH).toBe("/oauth/consent/manrope.woff2");
    expect(html).toMatch(/@font-face \{ font-family: "Manrope";[^}]*font-display: swap; \}/);
    // The system fonts are right behind it, so the page reads the same if the file never arrives.
    expect(html).toMatch(/font: 15px\/1\.5 "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI"/);
  });

  it("follows the system's light or dark mode", () => {
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("is one column on a phone and two on a wide screen", () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toMatch(/\nform \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(html).toMatch(/@media \(min-width: 860px\) \{[\s\S]*form \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
    // 16px text in the field: iOS zooms the page for anything smaller.
    expect(html).toMatch(/\.pw input \{[^}]*font-size: 16px/);
  });

  it("has a language, a title and one heading", () => {
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(html).toContain("<title>Authorize Claude · totem</title>");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });
});

describe("consent page: who is asking, and where access goes", () => {
  it("reads in the order that matters: who, where, the password, what, then the buttons", () => {
    const html = page();
    const order = ["<h1>Allow Claude to access WHOOP</h1>", "<b>Claude</b>", "Access will be sent to <b>claude.ai</b>.", 'name="password"', "<h2>Requested permissions</h2>", "Only continue if you started this from Claude.", ">Authorize</button>", ">Deny</button>"];
    const at = order.map((piece) => html.indexOf(piece));
    expect(at.every((i) => i >= 0), at.join(",")).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("lists what the client will be able to do", () => {
    const html = page();
    expect(CONSENT_PERMISSIONS).toHaveLength(8);
    for (const p of CONSENT_PERMISSIONS) expect(html).toContain(`<li>${p}</li>`);
    // Writes are said plainly, not folded into "access".
    expect(CONSENT_PERMISSIONS.filter((p) => /write/i.test(p)).length).toBeGreaterThanOrEqual(3);
  });

  it("names a web client by the address access is sent to, with its logo", () => {
    for (const [uri, name, logo] of [
      ["https://claude.ai/api/mcp/auth_callback", "Claude", "claude"],
      ["https://claude.com/api/mcp/auth_callback", "Claude", "claude"],
      ["https://chatgpt.com/connector_platform_oauth_redirect", "ChatGPT", "openai"],
      ["https://vscode.dev/redirect", "VS Code", "vscode"],
    ] as const) {
      const html = page({ redirectUri: uri });
      expect(heading(html), uri).toBe(`Allow ${name} to access WHOOP`);
      expect(tile(html), uri).toBe(CLIENT_LOGOS[logo]);
      expect(sentTo(html), uri).toBe(new URL(uri).host);
    }
  });

  // Registration is open: anyone can register a client called "Claude" whose
  // redirect is their own site, and send the owner a link to the owner's own
  // server. The page must show the address, never the name that client chose.
  it("ignores the name a client gave itself when access goes to a site", () => {
    const html = page({ redirectUri: "https://claude.ai.evil.example/api/mcp/auth_callback", clientName: "Claude" });
    expect(heading(html)).toBe("Allow claude.ai.evil.example to access WHOOP");
    expect(tile(html)).toBe(UNKNOWN_CLIENT_ICON); // a globe, not Claude's logo
    expect(html).not.toContain(CLIENT_LOGOS.claude);
    expect(html).not.toMatch(/Allow Claude\b|<b>Claude<\/b>/);
    expect(html).toContain("Only continue if you started this from there.");
    expect(sentTo(html)).toBe("claude.ai.evil.example");
  });

  it("gives a lookalike or plain-http address no name and no logo", () => {
    for (const uri of ["https://xn--clude-0qa.ai/cb", "https://claude.ai.example/cb", "http://claude.ai/cb", "https://chatgpt.com.evil.example/cb", "https://sub.claude.ai/cb"]) {
      const c = consentClient(uri, "Claude");
      expect(c.logo, uri).toBeNull();
      expect(c.name, uri).toBe(c.destination);
    }
    expect(consentClient("http://claude.ai/cb").destination).toBe("http://claude.ai"); // the scheme shows when it isn't https
  });

  it("names an app on this device by the name it registered with, and says the access stays on this device", () => {
    for (const [registered, name, logo] of [
      ["Claude Code", "Claude Code", "claude"],
      ["claude-code/2.1.316", "Claude Code", "claude"],
      ["Codex", "Codex", "openai"],
      ["codex-mcp-client", "Codex", "openai"],
      ["ChatGPT", "ChatGPT", "openai"],
      ["opencode", "OpenCode", "opencode"],
      ["Cursor", "Cursor", "cursor"],
      ["Visual Studio Code", "VS Code", "vscode"],
      ["Antigravity", "Antigravity", "antigravity"],
    ] as const) {
      const html = page({ redirectUri: LOOPBACK, clientName: registered });
      expect(heading(html), registered).toBe(`Allow ${name} to access WHOOP`);
      expect(tile(html), registered).toBe(CLIENT_LOGOS[logo]);
      expect(sentTo(html), registered).toBe("an app on this device (127.0.0.1:53124)");
    }
  });

  it("shows an unknown device app's own name with a globe, and a nameless one as what it is", () => {
    const named = page({ redirectUri: LOOPBACK, clientName: "Goose" });
    expect(heading(named)).toBe("Allow Goose to access WHOOP");
    expect(tile(named)).toBe(UNKNOWN_CLIENT_ICON);
    const nameless = page({ redirectUri: "http://localhost:8976/cb" });
    expect(heading(nameless)).toBe("Allow an app on this device to access WHOOP");
    expect(nameless).toContain("<b>An app on this device</b>");
    expect(tile(nameless)).toBe(UNKNOWN_CLIENT_ICON);
    expect(nameless).toContain("Only continue if you started this from there.");
    expect(nameless).toContain("<title>Authorize An app on this device · totem</title>");
  });

  it("recognises apps that take the redirect through their own URL scheme", () => {
    expect(consentClient("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({ name: "Cursor", logo: "cursor", destination: "cursor://anysphere.cursor-mcp" });
    expect(consentClient("vscode://vscode.github-authentication/did-authenticate")).toMatchObject({ name: "VS Code", logo: "vscode" });
    // A scheme totem doesn't know is shown as it is, whatever the client calls itself.
    expect(consentClient("evilapp://cb", "Cursor")).toEqual({ name: "evilapp://cb", logo: null, destination: "evilapp://cb" });
    // Cursor's web agents and Antigravity, by their exact sign-in hosts only.
    expect(consentClient("https://www.cursor.com/agents/mcp/oauth/callback")).toEqual({ name: "Cursor", logo: "cursor", destination: "www.cursor.com" });
    expect(consentClient("https://antigravity.google/oauth-callback")).toEqual({ name: "Antigravity", logo: "antigravity", destination: "antigravity.google" });
    expect(consentClient("https://antigravity.google.evil.example/cb", "Google Antigravity")).toMatchObject({ name: "antigravity.google.evil.example", logo: null });
  });

  it("shows a long host whole, wrapping instead of clipping it", () => {
    const html = page({ redirectUri: "https://claude.ai.account-verification.example-attacker-domain.com/cb" });
    expect(sentTo(html)).toBe("claude.ai.account-verification.example-attacker-domain.com");
    expect(html).toMatch(/\nh1 \{[^}]*overflow-wrap: anywhere/);
    expect(html).toMatch(/\.sent b \{[^}]*overflow-wrap: anywhere/);
    expect(html).toMatch(/\.who b \{[^}]*overflow-wrap: anywhere/);
    expect(html).not.toMatch(/text-overflow|word-break: break-all/);
  });

  it("keeps a registered name to one short printable line", () => {
    expect(cleanClientName("  Claude\n\tCode  ")).toBe("Claude Code");
    expect(cleanClientName("a\u0000b‮c​d")).toBe("a b c d");
    expect(cleanClientName("x".repeat(200))).toHaveLength(60);
    for (const nothing of ["", "   ", "\u0000", undefined, null, 42, {}]) expect(cleanClientName(nothing)).toBeUndefined();
  });
});

describe("consent page: Authorize and Deny", () => {
  const html = page();

  it("has exactly two buttons, each saying which decision it is", () => {
    expect(html.match(/<button\b/g)).toHaveLength(2);
    expect(html).toContain('<button type="submit" name="decision" value="allow" class="go">Authorize</button>');
    expect(html).toContain('<button type="submit" name="decision" value="deny" class="deny" formnovalidate>Deny</button>');
  });

  // A form's first submit button is the one Enter presses. It must be Authorize:
  // pressing Enter after typing the password must not deny.
  it("makes Authorize the button Enter presses, and shows Deny on the left", () => {
    expect(html.indexOf('value="allow"')).toBeLessThan(html.indexOf('value="deny"'));
    expect(html).toMatch(/\.deny \{[^}]*order: -1;/);
  });

  it("lets Deny through without a password", () => {
    expect(html.match(/<button[^>]*value="deny"[^>]*>/)![0]).toMatch(/\bformnovalidate\b/);
    expect(html.match(/<button[^>]*value="allow"[^>]*>/)![0]).not.toMatch(/formnovalidate/);
  });
});

describe("consent page: the password field", () => {
  const html = page();
  const field = /<input type="password"[^>]*>/;

  it("is labelled, focused, and described", () => {
    expect(html).toContain('<label for="pw">Connector password</label>');
    expect(attr(html, field, "id")).toBe("pw");
    expect(html.match(field)![0]).toMatch(/\bautofocus\b/);
    expect(html.match(field)![0]).toMatch(/\brequired\b/);
    expect(attr(html, field, "aria-describedby")).toBe("pw-help");
    expect(html).toContain('<p id="pw-help">The one totem cloud gave you</p>');
  });

  it("tells password managers what it is", () => {
    expect(attr(html, field, "autocomplete")).toBe("current-password");
    expect(attr(html, field, "name")).toBe("password");
    // A (hidden) username gives a password manager something to file the password under.
    expect(html).toMatch(/<input type="text" name="username" value="totem connector" autocomplete="username" readonly hidden>/);
    expect(attr(html, field, "autocapitalize")).toBe("off");
    expect(attr(html, field, "spellcheck")).toBe("false");
  });

  it("shows keyboard focus on the field's box and on the buttons", () => {
    expect(html).toMatch(/\.pw:focus-within \{ border-color: var\(--fg\); \}/);
    expect(html).toMatch(/button:focus-visible \{ outline: 2px solid var\(--fg\); outline-offset: 2px; \}/);
  });
});

describe("consent page: after a wrong password", () => {
  const html = page({ error: true });
  const field = /<input type="password"[^>]*>/;

  it("says so next to the field, and announces it", () => {
    expect(html).toContain('<p class="error" id="pw-error" role="alert">Incorrect password. Try again.</p>');
    expect(html.indexOf('id="pw-error"')).toBeGreaterThan(html.indexOf('name="password"'));
    expect(html.indexOf('id="pw-error"')).toBeLessThan(html.indexOf("Requested permissions"));
    expect(attr(html, field, "aria-invalid")).toBe("true");
    expect(attr(html, field, "aria-describedby")).toBe("pw-error pw-help");
    expect(html).toContain('<div class="box pw bad">');
    expect(html).toContain("<title>Incorrect password · totem</title>");
  });

  it("keeps the whole form: every field the client sent, who is asking, the focus", () => {
    for (const [name, value] of [["client_id", base.clientId], ["redirect_uri", base.redirectUri], ["code_challenge", base.codeChallenge], ["state", base.state], ["scope", base.scopes], ["resource", base.resource]] as const) {
      expect(html).toContain(`<input type="hidden" name="${name}" value="${value}">`);
    }
    expect(heading(html)).toBe("Allow Claude to access WHOOP");
    expect(sentTo(html)).toBe("claude.ai");
    expect(html.match(field)![0]).toMatch(/\bautofocus\b/);
    // The password itself is never sent back.
    expect(attr(html, field, "value")).toBeNull();
  });

  it("is otherwise the same page", () => {
    const strip = (s: string): string => s.replace(/\n\s*<p class="error"[^\n]*/, "").replace(/ aria-invalid="true"/, "").replace("pw-error pw-help", "pw-help").replace("box pw bad", "box pw").replace("Incorrect password · totem", "Authorize Claude · totem").replace(/\s+/g, " ");
    expect(strip(html)).toBe(strip(page()));
  });
});

describe("consent page: escaping", () => {
  it("escapes every value it shows or posts back, single quotes included", () => {
    const nasty = `"><script>alert(1)</script><img src=x onerror=1>'&`;
    const html = page({ clientId: nasty, redirectUri: `https://evil.example/${nasty}`, codeChallenge: nasty, state: nasty, scopes: nasty, resource: nasty, clientName: nasty, error: true });
    expect(tags(html)).not.toContain("script");
    expect(tags(html)).not.toContain("img");
    expect(html).not.toMatch(/onerror=1>/);
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=1&gt;&#39;&amp;");
    // Each of the six posted-back fields closes where it should.
    expect(html.match(/<input type="hidden" name="[a-z_]+" value="[^"<>]*">/g)).toHaveLength(6);
  });

  it("escapes a device app's registered name wherever it appears", () => {
    const html = page({ redirectUri: LOOPBACK, clientName: `<b onmouseover=x>"Evil" & Co</b>` });
    expect(html).not.toMatch(/<b onmouseover/);
    expect(heading(html)).toBe("Allow &lt;b onmouseover=x&gt;&quot;Evil&quot; &amp; Co&lt;/b&gt; to access WHOOP");
    expect(html).toContain("<title>Authorize &lt;b onmouseover=x&gt;&quot;Evil&quot; &amp; Co&lt;/b&gt; · totem</title>");
    expect(tile(html)).toBe(UNKNOWN_CLIENT_ICON);
  });

  it("can't be given a destination that isn't one", () => {
    expect(sentTo(page({ redirectUri: `javascript:alert(1)//"><b>` }))).toBe("javascript://");
    expect(sentTo(page({ redirectUri: "<b>not a url</b>" }))).toBe("an unrecognised address");
    expect(tile(page({ redirectUri: "<b>not a url</b>" }))).toBe(UNKNOWN_CLIENT_ICON);
  });
});

describe("consent page: the logos", () => {
  it("are inline drawings that need nothing the page's policy forbids", () => {
    const ids: string[] = [];
    for (const [id, svg] of [...Object.entries(CLIENT_LOGOS), ["the globe for an unknown client", UNKNOWN_CLIENT_ICON] as const]) {
      expect(svg, id).toMatch(/^<svg\b[^>]*\bviewBox="[^"]+"[^>]*>[\s\S]*<\/svg>$/);
      expect(svg, id).toContain('aria-hidden="true"');
      expect(svg.match(/^<svg\b[^>]*>/)![0], id).not.toMatch(/\s(width|height)=/); // sized by the page
      for (const forbidden of [/\sstyle\s*=/i, /<style/i, /<script/i, /<image/i, /<foreignObject/i, /href\s*=/i, /url\(\s*["']?(?!#)/i, /\son[a-z]+\s*=/i, /`|\$\{/]) expect(svg, `${id} ${forbidden}`).not.toMatch(forbidden);
      ids.push(...[...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
    }
    // Two logos on one page never happens, but ids are unique anyway.
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(CLIENT_LOGOS).sort()).toEqual(["antigravity", "claude", "cursor", "openai", "opencode", "vscode"]);
  });
});

describe("consent page: Content-Security-Policy", () => {
  it("allows the page's own stylesheet by hash, its typeface and favicon from this server, and nothing else", () => {
    const css = page().match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const hash = createHash("sha256").update(css).digest("base64");
    expect(CONSENT_CSP).toBe(`default-src 'none'; style-src 'sha256-${hash}'; font-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    // One stylesheet for every state and every client.
    for (const other of [page({ error: true }), page({ redirectUri: LOOPBACK, clientName: "Codex" }), page({ redirectUri: "https://evil.example/cb" })]) {
      expect(other.match(/<style>([\s\S]*?)<\/style>/)![1]).toBe(css);
    }
    expect(page().match(/<style\b/g)).toHaveLength(1);
  });

  // form-action also governs where the form's response may redirect: with it,
  // the browser refuses the 302 back to the client and the submit goes nowhere.
  it("never restricts where the form may go", () => {
    expect(CONSENT_CSP).not.toMatch(/form-action|navigate-to/);
    expect(CONSENT_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|https?:/);
  });
});

describe("consent page: as the server sends it", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const PASSWORD = "correct horse battery staple";
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
  let server: HttpServerHandle;
  let url = "";
  let clientId = "";
  let errors: ReturnType<typeof vi.spyOn>;
  const previousPassword = process.env.AUTH_PASSWORD;

  const register = async (body: Record<string, unknown>): Promise<string> => {
    const r = await fetch(`${url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token_endpoint_auth_method: "none", ...body }) });
    return ((await r.json()) as { client_id: string }).client_id;
  };
  const authorize = (id: string, redirect: string): Promise<Response> =>
    fetch(`${url}/authorize?response_type=code&client_id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${"x".repeat(43)}&code_challenge_method=S256&state=s1`);

  beforeAll(async () => {
    process.env.AUTH_PASSWORD = PASSWORD;
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startHttpServer({} as WhoopClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${server.port}`;
    clientId = await register({ redirect_uris: [REDIRECT] });
  });
  afterAll(async () => {
    await server.close();
    errors.mockRestore();
    if (previousPassword === undefined) delete process.env.AUTH_PASSWORD;
    else process.env.AUTH_PASSWORD = previousPassword;
  });

  const post = (fields: Record<string, string>, id = clientId, redirect = REDIRECT): Promise<Response> => fetch(`${url}/oauth/consent`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.77" },
    body: new URLSearchParams({ client_id: id, redirect_uri: redirect, code_challenge: "x".repeat(43), state: "s1", scope: "", resource: "", username: "totem connector", ...fields }),
  });
  const consent = (password: string): Promise<Response> => post({ decision: "allow", password });
  const expectHeaders = (r: Response): void => {
    expect(r.headers.get("content-security-policy")).toBe(CONSENT_CSP);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toMatch(/^text\/html; charset=utf-8/);
  };

  it("/authorize serves the page with its security headers", async () => {
    const r = await authorize(clientId, REDIRECT);
    expect(r.status).toBe(200);
    expectHeaders(r);
    const html = await r.text();
    expect(heading(html)).toBe("Allow Claude to access WHOOP");
    expect(sentTo(html)).toBe("claude.ai");
    expect(html).toContain('<input type="hidden" name="state" value="s1">');
  });

  it("serves the typeface the page asks for, and it is a real font file", async () => {
    const r = await fetch(`${url}${CONSENT_FONT_PATH}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("font/woff2");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(bytes.equals(consentFont())).toBe(true);
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.length).toBeLessThan(120_000);
  });

  it("remembers the name a device app registered with, through a restart-proof client id", async () => {
    const id = await register({ redirect_uris: ["http://127.0.0.1/callback"], client_name: "Claude Code" });
    const html = await (await authorize(id, "http://127.0.0.1:41000/callback")).text();
    expect(heading(html)).toBe("Allow Claude Code to access WHOOP");
    expect(sentTo(html)).toBe("an app on this device (127.0.0.1:41000)");
    // It says who registered, and only that.
    const logged = (errors.mock.calls as unknown[][]).map((c) => String(c[0])).filter((l) => l.includes("client registered"));
    expect(logged.at(-1)).toBe('[totem] client registered: "Claude Code" -> an app on this device (127.0.0.1)');
    // A wrong password brings the same named page back.
    const again = await post({ decision: "allow", password: "wrong" }, id, "http://127.0.0.1:41000/callback");
    expect(again.status).toBe(401);
    expect(heading(await again.text())).toBe("Allow Claude Code to access WHOOP");
  });

  it("does not let a site borrow a name by registering with it", async () => {
    const id = await register({ redirect_uris: ["https://evil.example/cb"], client_name: "Claude" });
    const html = await (await authorize(id, "https://evil.example/cb")).text();
    expect(heading(html)).toBe("Allow evil.example to access WHOOP");
    expect(html).not.toContain(CLIENT_LOGOS.claude);
  });

  it("a wrong password re-serves it as a 401 with the error and the same headers", async () => {
    const r = await consent("wrong");
    expect(r.status).toBe(401);
    expectHeaders(r);
    const html = await r.text();
    expect(html).toContain('role="alert">Incorrect password. Try again.</p>');
    expect(html).toContain('<input type="hidden" name="state" value="s1">');
    expect(html).not.toContain("wrong");
  });

  it("the right password redirects to the client, ignoring the username helper field", async () => {
    const r = await consent(PASSWORD);
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("s1");
    expect(to.searchParams.get("code")).toBeTruthy();
    expect(to.searchParams.get("error")).toBeNull();
  });

  it("a form without a decision (an older page, or Enter) still authorizes with the right password", async () => {
    const r = await post({ password: PASSWORD });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("Deny sends the client back with access_denied and no code, without asking for the password", async () => {
    for (const fields of [{ decision: "deny" }, { decision: "deny", password: PASSWORD }, { decision: "deny", password: "wrong" }]) {
      const r = await post(fields);
      expect(r.status).toBe(302);
      const to = new URL(r.headers.get("location")!);
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(to.searchParams.get("error")).toBe("access_denied");
      expect(to.searchParams.get("state")).toBe("s1");
      expect(to.searchParams.get("code")).toBeNull();
    }
  });

  it("Deny never redirects to an address the client didn't register", async () => {
    for (const [id, redirect] of [[clientId, "https://evil.example/cb"], ["c.not-a-client", REDIRECT], [clientId, "not a url"]] as const) {
      const r = await post({ decision: "deny" }, id, redirect);
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
      expectHeaders(r);
      const html = await r.text();
      expect(html).toContain("Nothing was authorized.");
      expect(html).not.toContain("evil.example");
    }
  });

  it("puts the consent CSP on no other response", async () => {
    for (const path of ["/health", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/mcp", CONSENT_FONT_PATH]) {
      const r = await fetch(`${url}${path}`);
      expect(r.headers.get("content-security-policy"), path).not.toBe(CONSENT_CSP);
      expect(r.headers.get("x-frame-options"), path).toBeNull();
      await r.arrayBuffer();
    }
  });
});
