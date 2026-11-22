// The consent page: the one page of totem a person sees in a browser. It asks
// for a password on a public URL, so these tests hold it to being one
// self-contained, script-free document that names where access goes, works
// without colour or a mouse, and comes back usable after a wrong password.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHttpServer, type HttpServerHandle } from "../../src/server-http.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { CONSENT_CSP, renderConsentForm } from "../../src/whoop/oauth_provider.js";

const base = {
  clientId: "c.client-id", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "challenge",
  state: "state-123", scopes: "a b", resource: "https://totem.example.com/mcp",
};
const page = (over: Partial<typeof base> & { error?: boolean } = {}): string => renderConsentForm({ ...base, error: false, ...over });
/** Every opening tag in the page, lower-cased. */
const tags = (html: string): string[] => [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b/g)].map((m) => m[1]!.toLowerCase());
const attr = (html: string, tag: RegExp, name: string): string | null => {
  const el = html.match(tag)?.[0] ?? "";
  return el.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
};

describe("consent page: a self-contained document", () => {
  const html = page();

  it("loads nothing: no scripts, images, fonts, frames, links or inline handlers", () => {
    for (const forbidden of ["script", "img", "link", "iframe", "object", "embed", "video", "audio", "base"]) expect(tags(html), forbidden).not.toContain(forbidden);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);       // no onclick= etc.
    expect(html).not.toMatch(/\sstyle\s*=/i);          // no inline style attributes (the CSP would drop them)
    expect(html).not.toMatch(/url\(|@import|@font-face/i);
    // The only URLs are the form's own action and the values it posts back.
    expect([...html.matchAll(/\b(?:src|href)\s*=/gi)]).toHaveLength(0);
    expect(attr(html, /<form\b[^>]*>/, "action")).toBe("/oauth/consent");
    expect(attr(html, /<form\b[^>]*>/, "method")).toBe("POST");
  });

  it("uses the system font stack, and follows the system's light or dark mode", () => {
    expect(html).toMatch(/font: 16px\/1\.5 system-ui, -apple-system, "Segoe UI"/);
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("is laid out for a phone", () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toMatch(/@media \(max-width: 420px\)/);
    // 16px text in the field (iOS zooms the page for anything smaller) and touch-sized controls.
    expect(html).toMatch(/input\[type=password\] \{[^}]*height: 46px[^}]*font: inherit/s);
    expect(html).toMatch(/button \{[^}]*height: 46px/s);
  });

  it("has a language, a title and one heading", () => {
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(html).toContain("<title>Allow access · totem</title>");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });
});

describe("consent page: what it asks and where access goes", () => {
  it("puts the destination before the password, with the line about who started this", () => {
    const html = page();
    const order = ["Allow access to your WHOOP data?", "Access goes to", '<strong class="dest">claude.ai</strong>', "Continue only if you started this from there.", 'name="password"', '<button type="submit">Allow access</button>'];
    const at = order.map((piece) => html.indexOf(piece));
    expect(at.every((i) => i >= 0), at.join(",")).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("shows a long host whole, wrapping instead of clipping it", () => {
    const html = page({ redirectUri: "https://claude.ai.account-verification.example-attacker-domain.com/cb" });
    expect(html).toContain('<strong class="dest">claude.ai.account-verification.example-attacker-domain.com</strong>');
    expect(html).toMatch(/\.dest \{[^}]*overflow-wrap: anywhere/);
    expect(html).not.toMatch(/text-overflow|overflow: hidden|word-break: break-all/);
  });

  it("has exactly one button", () => {
    expect(page().match(/<button\b/g)).toHaveLength(1);
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
    expect(html).toContain('id="pw-help"');
  });

  it("tells password managers what it is", () => {
    expect(attr(html, field, "autocomplete")).toBe("current-password");
    expect(attr(html, field, "name")).toBe("password");
    // A (hidden) username gives a password manager something to file the password under.
    expect(html).toMatch(/<input type="text" name="username" value="totem connector" autocomplete="username" readonly hidden>/);
    expect(attr(html, field, "autocapitalize")).toBe("off");
    expect(attr(html, field, "spellcheck")).toBe("false");
  });

  it("shows keyboard focus on the field and the button", () => {
    expect(html).toMatch(/input:focus-visible, button:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
    expect(html).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

describe("consent page: after a wrong password", () => {
  const html = page({ error: true });
  const field = /<input type="password"[^>]*>/;

  it("says so next to the field, and announces it", () => {
    expect(html).toContain('<p class="error" id="pw-error" role="alert">Incorrect password. Try again.</p>');
    expect(html.indexOf('id="pw-error"')).toBeGreaterThan(html.indexOf('name="password"'));
    expect(html.indexOf('id="pw-error"')).toBeLessThan(html.indexOf("<button"));
    expect(attr(html, field, "aria-invalid")).toBe("true");
    expect(attr(html, field, "aria-describedby")).toBe("pw-error pw-help");
    expect(html).toContain("<title>Incorrect password · totem</title>");
  });

  it("keeps the whole form: every field the client sent, the destination, the focus", () => {
    for (const [name, value] of [["client_id", base.clientId], ["redirect_uri", base.redirectUri], ["code_challenge", base.codeChallenge], ["state", base.state], ["scope", base.scopes], ["resource", base.resource]] as const) {
      expect(html).toContain(`<input type="hidden" name="${name}" value="${value}">`);
    }
    expect(html).toContain('<strong class="dest">claude.ai</strong>');
    expect(html.match(field)![0]).toMatch(/\bautofocus\b/);
    // The password itself is never sent back.
    expect(attr(html, field, "value")).toBeNull();
  });

  it("is otherwise the same page", () => {
    const strip = (s: string): string => s.replace(/<p class="error"[^\n]*\n?/, "").replace(/ aria-invalid="true"/, "").replace("pw-error pw-help", "pw-help").replace("Incorrect password · totem", "Allow access · totem").replace(/\s+/g, " ");
    expect(strip(html)).toBe(strip(page()));
  });
});

describe("consent page: escaping", () => {
  it("escapes every value it shows or posts back, single quotes included", () => {
    const nasty = `"><script>alert(1)</script><img src=x onerror=1>'&`;
    const html = page({ clientId: nasty, redirectUri: `https://evil.example/${nasty}`, codeChallenge: nasty, state: nasty, scopes: nasty, resource: nasty, error: true });
    expect(tags(html)).not.toContain("script");
    expect(tags(html)).not.toContain("img");
    expect(html).not.toMatch(/onerror=1>/);
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=1&gt;&#39;&amp;");
    // Each of the six posted-back fields closes where it should.
    expect(html.match(/<input type="hidden" name="[a-z_]+" value="[^"<>]*">/g)).toHaveLength(6);
  });

  it("can't be given a destination that isn't one", () => {
    expect(page({ redirectUri: `javascript:alert(1)//"><b>` })).toContain('<strong class="dest">javascript://</strong>');
    expect(page({ redirectUri: "<b>not a url</b>" })).toContain('<strong class="dest">an unrecognised address</strong>');
  });
});

describe("consent page: Content-Security-Policy", () => {
  it("allows nothing but the page's own stylesheet, by hash", () => {
    const css = page().match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const hash = createHash("sha256").update(css).digest("base64");
    expect(CONSENT_CSP).toBe(`default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'`);
    expect(page({ error: true }).match(/<style>([\s\S]*?)<\/style>/)![1]).toBe(css); // one stylesheet, both states
    expect(page().match(/<style\b/g)).toHaveLength(1);
  });

  // form-action also governs where the form's response may redirect: with it,
  // the browser refuses the 302 back to the client and the submit goes nowhere.
  it("never restricts where the form may go", () => {
    expect(CONSENT_CSP).not.toMatch(/form-action|navigate-to/);
    expect(CONSENT_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
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

  beforeAll(async () => {
    process.env.AUTH_PASSWORD = PASSWORD;
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startHttpServer({} as WhoopClient, { authToken: TOKEN, port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${server.port}`;
    const registered = await fetch(`${url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) });
    clientId = ((await registered.json()) as { client_id: string }).client_id;
  });
  afterAll(async () => {
    await server.close();
    errors.mockRestore();
    if (previousPassword === undefined) delete process.env.AUTH_PASSWORD;
    else process.env.AUTH_PASSWORD = previousPassword;
  });

  const consent = (password: string): Promise<Response> => fetch(`${url}/oauth/consent`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.77" },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: "x".repeat(43), state: "s1", scope: "", resource: "", username: "totem connector", password }),
  });
  const expectHeaders = (r: Response): void => {
    expect(r.headers.get("content-security-policy")).toBe(CONSENT_CSP);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toMatch(/^text\/html; charset=utf-8/);
  };

  it("/authorize serves the page with its security headers", async () => {
    const r = await fetch(`${url}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${"x".repeat(43)}&code_challenge_method=S256&state=s1`);
    expect(r.status).toBe(200);
    expectHeaders(r);
    const html = await r.text();
    expect(html).toContain('<strong class="dest">claude.ai</strong>');
    expect(html).toContain('<input type="hidden" name="state" value="s1">');
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
  });

  it("puts the consent CSP on no other response", async () => {
    for (const path of ["/health", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/mcp"]) {
      const r = await fetch(`${url}${path}`);
      expect(r.headers.get("content-security-policy"), path).not.toBe(CONSENT_CSP);
      expect(r.headers.get("x-frame-options"), path).toBeNull();
      await r.arrayBuffer();
    }
  });
});
