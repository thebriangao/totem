// The brand module (src/lib/brand.ts) against the logo file, and where it shows.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BRAND, SERVER_ICONS, TOTEM_LOGO_SVG, TOTEM_MARK, serverIdentity } from "../../src/lib/brand.js";
import { renderConsentForm } from "../../src/whoop/consent_page.js";
import { renderConnectPage } from "../../src/whoop/connect_page.js";

const FILE = readFileSync(resolve("assets/brand/totem.svg"), "utf8");
const shapes = (svg: string) => [...svg.matchAll(/<(rect|polygon)\b([^>]*)\/>/g)].map((m) => `${m[1]}${m[2]!.trim()}`);

describe("the logo", () => {
  it("in code draws exactly what assets/brand/totem.svg draws", () => {
    expect(shapes(TOTEM_LOGO_SVG)).toEqual(shapes(FILE));
    expect(TOTEM_LOGO_SVG.match(/viewBox="[^"]+"/)![0]).toBe(FILE.match(/viewBox="[^"]+"/)![0]);
    // Safe to inline: no ids to collide, no styles or scripts for a CSP to drop.
    for (const bad of [/\bid=/, /style/i, /<script/i, /href/i, /\son[a-z]+=/i]) expect(TOTEM_LOGO_SVG).not.toMatch(bad);
  });

  it("uses the brand colours and never has a background", () => {
    expect(BRAND).toEqual({ ice: "#B7D3F2", ink: "#141414", fold: "#7A9CC6" });
    // Ice and fold draw the mark. Ink is the pages' colour, not a square behind the logo.
    for (const c of [BRAND.ice, BRAND.fold]) expect(TOTEM_LOGO_SVG).toContain(`"${c}"`);
    for (const svg of [FILE, TOTEM_LOGO_SVG, TOTEM_MARK]) {
      expect(svg).not.toContain("<rect");
      expect(svg).not.toContain(BRAND.ink);
    }
    // The PNG renders are transparent too (a palette with alpha).
    expect(readFileSync(resolve("assets/brand/totem.png")).includes("tRNS")).toBe(true);
    // The header mark is the same shapes, cut to the mark so it lines up with the text beside it.
    expect(TOTEM_MARK.startsWith('<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="125 176 750 648">')).toBe(true);
    expect(shapes(TOTEM_MARK)).toEqual(shapes(FILE));
  });

  it("is the header of both pages, with the old placeholder gone", () => {
    const pages = [
      renderConnectPage({ mcpUrl: "https://totem.example/mcp" }),
      renderConsentForm({ clientId: "c", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "x", state: "s", scopes: "", resource: "r", error: false }),
    ];
    for (const html of pages) {
      expect(html).toContain(`<p class="brand">${TOTEM_MARK}totem</p>`);
      expect(html).not.toContain('viewBox="0 0 22 22"');
      // Plain buttons: black with white text in the light theme, white with black text in the dark one.
      expect(html).toContain("--go: #141414; --on: #ffffff;");
      expect(html).toContain("--go: #ffffff; --on: #141414;");
      expect(html).not.toMatch(/--(go|on): #b7d3f2/i);
      expect(html).toContain("--page: #141414;");
    }
  });
});

describe("the MCP server's identity", () => {
  it("carries the logo as SVG and PNG icons", async () => {
    const [svg, png] = SERVER_ICONS;
    expect(svg).toMatchObject({ mimeType: "image/svg+xml", sizes: ["any"] });
    expect(Buffer.from(svg!.src.replace("data:image/svg+xml;base64,", ""), "base64").toString()).toBe(TOTEM_LOGO_SVG);
    expect(png).toMatchObject({ mimeType: "image/png", sizes: ["128x128"] });
    const bytes = Buffer.from(png!.src.replace("data:image/png;base64,", ""), "base64");
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(128); // IHDR width
    expect(bytes.includes("tRNS")).toBe(true); // transparent: no square behind the mark

    const server = new McpServer(serverIdentity("9.9.9"));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);
    expect(client.getServerVersion()).toMatchObject({ name: "totem", version: "9.9.9", websiteUrl: "https://github.com/thebriangao/totem", icons: SERVER_ICONS });
    await client.close();
  });
});
