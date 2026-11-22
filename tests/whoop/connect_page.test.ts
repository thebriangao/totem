// The Connect page and the install links it is built from.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  antigravityEntry, claudeConnectorLink, cursorInstallLink, cursorWebLink, remoteCommands, vscodeInstallLink,
} from "../../src/lib/install_links.js";
import { CONNECT_CSP, renderConnectPage } from "../../src/whoop/connect_page.js";
import { TOTEM_LOGO_SVG } from "../../src/lib/brand.js";

const MCP = "https://totem-a1b2c3.fly.dev/mcp";

describe("install links", () => {
  it("claude.ai: the documented add-custom-connector link, filled in", () => {
    const u = new URL(claudeConnectorLink(MCP));
    expect(u.origin + u.pathname).toBe("https://claude.ai/customize/connectors");
    expect(Object.fromEntries(u.searchParams)).toEqual({ modal: "add-custom-connector", connectorName: "WHOOP", connectorUrl: MCP });
  });

  it("Cursor: base64 of the server object, URL-encoded, for a server and for a local command", () => {
    const remote = cursorInstallLink({ url: MCP });
    expect(remote.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=whoop&config=")).toBe(true);
    const config = decodeURIComponent(remote.split("config=")[1]!);
    expect(JSON.parse(Buffer.from(config, "base64").toString("utf8"))).toEqual({ url: MCP });
    const local = cursorInstallLink({ command: "node", args: ["/Users/you/totem/dist/server.js"] });
    expect(JSON.parse(Buffer.from(decodeURIComponent(local.split("config=")[1]!), "base64").toString("utf8"))).toEqual({ command: "node", args: ["/Users/you/totem/dist/server.js"] });
    expect(cursorWebLink({ url: MCP })).toBe(remote.replace("cursor://anysphere.cursor-deeplink/mcp/install", "https://cursor.com/en/install-mcp"));
  });

  it("VS Code: the URL-encoded JSON with name and type", () => {
    const link = vscodeInstallLink({ type: "http", url: MCP });
    expect(link.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(link.slice("vscode:mcp/install?".length)))).toEqual({ name: "whoop", type: "http", url: MCP });
  });

  it("commands and the Antigravity entry name the server whoop", () => {
    const c = remoteCommands(MCP);
    expect(c.claudeCode).toBe(`claude mcp add --transport http --scope user whoop ${MCP}`);
    expect(c.codex).toBe(`codex mcp add whoop --url ${MCP}`);
    expect(c.opencode).toBe(`cd ~/.config/opencode && opencode mcp add whoop --url ${MCP}`);
    expect(JSON.parse(antigravityEntry(MCP))).toEqual({ mcpServers: { whoop: { serverUrl: MCP } } });
  });
});

describe("the Connect page", () => {
  const html = renderConnectPage({ mcpUrl: MCP });

  it("has a card for every app totem works with", () => {
    for (const name of ["Claude", "ChatGPT", "Claude Code", "Cursor", "VS Code", "OpenCode", "Antigravity"]) {
      expect(html).toContain(`<b>${name}</b>`);
    }
  });

  it("links straight into the three apps that take a link", () => {
    expect(html).toContain(`href="${claudeConnectorLink(MCP).replace(/&/g, "&amp;")}"`);
    expect(html).toContain(`href="${cursorInstallLink({ url: MCP }).replace(/&/g, "&amp;")}"`);
    expect(html).toContain(`href="${vscodeInstallLink({ type: "http", url: MCP })}"`);
  });

  it("allows exactly its own style and script by hash, and nothing else", () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const hash = (s: string): string => createHash("sha256").update(s).digest("base64");
    expect(CONNECT_CSP).toContain(`style-src 'sha256-${hash(style)}'`);
    expect(CONNECT_CSP).toContain(`script-src 'sha256-${hash(script)}'`);
    expect(CONNECT_CSP).toMatch(/^default-src 'none';/);
    expect(CONNECT_CSP).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/<img|<iframe|src="http|style="/);
  });

  it("escapes the address everywhere it appears", () => {
    const odd = renderConnectPage({ mcpUrl: 'https://x.example/mcp"><script>alert(1)</script>' });
    expect(odd).not.toContain("<script>alert(1)</script>");
    expect(odd.match(/<script>/g)).toHaveLength(1);
  });

  it("says it is not affiliated with WHOOP and holds no password", () => {
    expect(html).toContain("not affiliated with WHOOP");
    expect(html).not.toMatch(/AUTH_PASSWORD|MCP_AUTH_TOKEN/);
  });
});

describe("GET /connect and GET / on a running server", async () => {
  const { startHttpServer } = await import("../../src/server-http.js");
  const { afterAll, beforeAll, vi } = await import("vitest");
  const stub = { get: async () => ({}) } as never;
  let base = "";
  let close: () => Promise<void> = async () => {};
  const previous = process.env.PUBLIC_URL;
  beforeAll(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PUBLIC_URL = "https://totem-a1b2c3.fly.dev";
    const server = await startHttpServer(stub, { authToken: "c".repeat(64), port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${server.port}`;
    close = server.close;
  });
  afterAll(async () => {
    await close();
    if (previous === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = previous;
  });

  it("serves the page for this server's /mcp address, with its CSP and no caching", async () => {
    const r = await fetch(`${base}/connect`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CONNECT_CSP);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain(MCP);
  });

  it("serves the logo as its favicon, without a login", async () => {
    const r = await fetch(`${base}/favicon.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toBe(TOTEM_LOGO_SVG);
    const page = await (await fetch(`${base}/connect`)).text();
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(page).toContain('<p class="brand"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">');
    expect(CONNECT_CSP).toContain("img-src 'self'");
  });

  it("sends the bare address to the Connect page", async () => {
    const r = await fetch(`${base}/`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/connect");
  });
});
