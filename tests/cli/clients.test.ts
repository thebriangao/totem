// The client list. Checked on 2026-11-21 against each vendor's docs and the
// tools installed on the maintainer's machine; these tests pin what that found,
// so a change to a recipe is a deliberate edit here too.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENTS, findClient, mergeJsonConfig, recipeJson, type Recipe, type Target } from "../../src/cli/clients.js";
import { runCli, type AppCtx } from "../../src/cli/app.js";
import { writeDeployRecord } from "../../src/cli/deploy_record.js";
import type { Sys } from "../../src/cli/sys.js";
import { TOKEN, fakeWorld, type FakeWorld, type WorldOptions } from "./helpers.js";

const LOCAL: Target = { kind: "local", node: "/usr/local/bin/node", serverJs: "/opt/totem/dist/server.js" };
const REMOTE: Target = { kind: "remote", mcpUrl: "https://totem.example.com/mcp" };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "totem-clients-")); dirs.push(d); return d; };

/** Just enough of Sys for a recipe: a home, an environment, and which commands exist. */
const sysWith = (home: string, has: string[] = [], env: Record<string, string> = {}): Sys =>
  ({ platform: "darwin", home, env, has: (cmd: string) => has.includes(cmd) }) as unknown as Sys;
const recipe = (id: string, target: Target, sys: Sys): Recipe => findClient(id)!.recipe(target, sys);
const file = (r: Recipe): Extract<Recipe, { kind: "file" }> => { expect(r.kind).toBe("file"); return r as Extract<Recipe, { kind: "file" }>; };
const command = (r: Recipe): Extract<Recipe, { kind: "command" }> => { expect(r.kind).toBe("command"); return r as Extract<Recipe, { kind: "command" }>; };

describe("which clients totem knows", () => {
  it("is these eight, in this order", () => {
    expect(CLIENTS.map((c) => c.id)).toEqual(["claude", "claude-desktop", "claude-code", "chatgpt", "opencode", "cursor", "vscode", "antigravity"]);
    // The connect card lists the first six; the other two are offered by name.
    expect(CLIENTS.filter((c) => c.featured).map((c) => c.id)).toEqual(["claude", "claude-desktop", "claude-code", "chatgpt", "opencode", "cursor"]);
  });

  it("still answers to the names of clients that merged or were replaced, and has dropped Windsurf", () => {
    // Codex and ChatGPT are one app; Antigravity took over from Gemini CLI.
    for (const old of ["codex", "codex-cli", "Codex CLI"]) expect(findClient(old)?.id, old).toBe("chatgpt");
    for (const old of ["gemini", "gemini-cli", "agy"]) expect(findClient(old)?.id, old).toBe("antigravity");
    for (const name of ["vs-code", "copilot", "VS Code"]) expect(findClient(name)?.id, name).toBe("vscode");
    expect(findClient("windsurf")).toBeUndefined();
  });
});

describe("ChatGPT (the desktop app and the Codex CLI share one config)", () => {
  it("uses the codex command when it is installed, for a local server and for a deployed one", () => {
    const sys = sysWith(tmp(), ["codex"]);
    expect(command(recipe("chatgpt", LOCAL, sys)).argv).toEqual(["codex", "mcp", "add", "whoop", "--", LOCAL.node, LOCAL.serverJs]);
    const remote = command(recipe("chatgpt", REMOTE, sys));
    expect(remote.argv).toEqual(["codex", "mcp", "add", "whoop", "--url", REMOTE.mcpUrl]);
    expect(remote.remove).toEqual(["codex", "mcp", "remove", "whoop"]);
    // `codex mcp add` opens the sign-in page itself (seen with codex-cli 0.154), so the
    // person is told before it runs, and `mcp login` is only the way to do it again.
    expect(remote.before).toMatch(/opens the sign-in page/);
    expect(remote.after).toContain("codex mcp login whoop");
    // chatgpt.com has its own path now (Plugins, not Developer mode).
    expect(remote.then).toHaveLength(1);
    expect(remote.then[0]).toMatch(/chatgpt\.com: Plugins .* Add custom MCP server/);
    expect(JSON.stringify(remote)).not.toMatch(/Developer mode/i);
  });

  it("gives the app's own settings steps when the codex command isn't there", () => {
    const sys = sysWith(tmp());
    const local = recipe("chatgpt", LOCAL, sys);
    expect(local).toMatchObject({ kind: "steps" });
    expect(JSON.stringify(local)).toContain("STDIO");
    expect(JSON.stringify(local)).toContain(`${LOCAL.node} ${LOCAL.serverJs}`);
    const remote = recipe("chatgpt", REMOTE, sys);
    expect(JSON.stringify(remote)).toContain("Streamable HTTP");
    expect(JSON.stringify(remote)).toContain("Authenticate");
  });

  it("is available on this computer, unlike claude.ai", () => {
    const sys = sysWith(tmp(), ["codex"]);
    expect(recipe("chatgpt", LOCAL, sys).kind).not.toBe("unavailable");
    expect(recipe("claude", LOCAL, sys).kind).toBe("unavailable");
  });
});

describe("OpenCode (version 2 keeps servers under mcp.servers; 1.19 reads that too)", () => {
  it("writes mcp.servers.<name>, with no `enabled` field", () => {
    const home = tmp();
    const local = file(recipe("opencode", LOCAL, sysWith(home)));
    expect(local).toMatchObject({ path: join(home, ".config", "opencode", "opencode.json"), key: "mcp.servers", entry: { type: "local", command: [LOCAL.node, LOCAL.serverJs] } });
    expect(file(recipe("opencode", REMOTE, sysWith(home))).entry).toEqual({ type: "remote", url: REMOTE.mcpUrl });
    expect(recipeJson(local)).toEqual(JSON.stringify({ mcp: { servers: { whoop: local.entry } } }, null, 2).split("\n"));
  });

  it("follows XDG_CONFIG_HOME, and uses opencode.jsonc when that is the file the person has", () => {
    const home = tmp();
    const xdg = join(home, "xdg");
    expect(file(recipe("opencode", LOCAL, sysWith(home, [], { XDG_CONFIG_HOME: xdg }))).path).toBe(join(xdg, "opencode", "opencode.json"));
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    writeFileSync(join(xdg, "opencode", "opencode.jsonc"), "{}\n");
    expect(file(recipe("opencode", LOCAL, sysWith(home, [], { XDG_CONFIG_HOME: xdg }))).path).toBe(join(xdg, "opencode", "opencode.jsonc"));
    // With both, opencode.json: that is where OpenCode 2's own `mcp add --global` writes.
    writeFileSync(join(xdg, "opencode", "opencode.json"), "{}\n");
    expect(file(recipe("opencode", LOCAL, sysWith(home, [], { XDG_CONFIG_HOME: xdg }))).path).toBe(join(xdg, "opencode", "opencode.json"));
  });

  it("adds itself beside version 1 and version 2 servers without touching them", () => {
    const path = join(tmp(), "opencode.json");
    const before = { $schema: "https://opencode.ai/config.json", provider: { x: 1 }, mcp: { old: { type: "local", command: ["a"], enabled: true }, servers: { other: { type: "remote", url: "https://o" } } } };
    writeFileSync(path, JSON.stringify(before, null, 2));
    expect(mergeJsonConfig(path, "mcp.servers", "whoop", { type: "remote", url: REMOTE.mcpUrl }).changed).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8")) as typeof before;
    expect(after).toEqual({ ...before, mcp: { ...before.mcp, servers: { other: before.mcp.servers.other, whoop: { type: "remote", url: REMOTE.mcpUrl } } } });
    expect(Object.keys(after)).toEqual(Object.keys(before));
    // Again: nothing to change.
    expect(mergeJsonConfig(path, "mcp.servers", "whoop", { type: "remote", url: REMOTE.mcpUrl }).changed).toBe(false);
  });

  it("creates the nested objects in a config that has none, and refuses one where they aren't objects", () => {
    const dir = tmp();
    const fresh = join(dir, "a.json");
    writeFileSync(fresh, '{ "theme": "x" }');
    mergeJsonConfig(fresh, "mcp.servers", "whoop", { type: "local", command: ["n"] });
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ theme: "x", mcp: { servers: { whoop: { type: "local", command: ["n"] } } } });
    for (const [text, where] of [['{ "mcp": ["x"] }', '"mcp"'], ['{ "mcp": { "servers": "x" } }', '"mcp.servers"']] as const) {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, text);
      expect(() => mergeJsonConfig(bad, "mcp.servers", "whoop", {})).toThrow(new RegExp(`${where.replace(".", "\\.")} in .* isn't an object`));
      expect(readFileSync(bad, "utf8")).toBe(text);
    }
  });
});

describe("VS Code (the personal Copilot config, not the deprecated profile mcp.json)", () => {
  it("writes ~/.copilot/mcp-config.json in the portable mcpServers format", () => {
    const home = tmp();
    const local = file(recipe("vscode", LOCAL, sysWith(home)));
    expect(local).toMatchObject({ path: join(home, ".copilot", "mcp-config.json"), key: "mcpServers" });
    expect(local.entry).toEqual({ type: "stdio", command: LOCAL.node, args: [LOCAL.serverJs], tools: ["*"] });
    expect(file(recipe("vscode", REMOTE, sysWith(home))).entry).toEqual({ type: "http", url: REMOTE.mcpUrl, tools: ["*"] });
    expect(local.path).not.toContain(join("Code", "User"));
  });

  it("follows COPILOT_HOME", () => {
    const home = tmp();
    expect(file(recipe("vscode", LOCAL, sysWith(home, [], { COPILOT_HOME: join(home, "cp") }))).path).toBe(join(home, "cp", "mcp-config.json"));
  });
});

describe("Antigravity (in Gemini CLI's place)", () => {
  it("writes ~/.gemini/config/mcp_config.json, with serverUrl for a deployed server", () => {
    const home = tmp();
    const local = file(recipe("antigravity", LOCAL, sysWith(home)));
    expect(local).toMatchObject({ path: join(home, ".gemini", "config", "mcp_config.json"), key: "mcpServers", entry: { command: LOCAL.node, args: [LOCAL.serverJs] } });
    expect(file(recipe("antigravity", REMOTE, sysWith(home))).entry).toEqual({ serverUrl: REMOTE.mcpUrl });
  });

  it("fills in the empty config file Antigravity creates on first run", () => {
    const home = tmp();
    const r = file(recipe("antigravity", LOCAL, sysWith(home)));
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(r.path, "");
    expect(mergeJsonConfig(r.path, r.key, "whoop", r.entry)).toEqual({ changed: true });
    expect(JSON.parse(readFileSync(r.path, "utf8"))).toEqual({ mcpServers: { whoop: r.entry } });
  });

  it("is noticed from its folders, since its command may not be on PATH", () => {
    const home = tmp();
    const antigravity = findClient("antigravity")!;
    expect(antigravity.detect(sysWith(home))).toBe(false);
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
    expect(antigravity.detect(sysWith(home))).toBe(true);
  });
});

describe("totem connect <client> against a deployed server", () => {
  let world: FakeWorld | undefined;
  afterEach(() => { world?.cleanup(); world = undefined; });
  const totem = async (argv: string[], opts: WorldOptions | ((w: FakeWorld) => void) = {}): Promise<{ code: number; text: string; w: FakeWorld }> => {
    const w = fakeWorld(typeof opts === "function" ? {} : opts);
    world = w;
    if (typeof opts === "function") opts(w);
    writeDeployRecord(w.root, { platform: "fly", app: "totem-a1b2c3", url: "https://totem-a1b2c3.fly.dev", mcp_auth_token: TOKEN });
    const app: AppCtx = { root: w.root, version: "1.5.1", pkgName: "@thebriangao/totem", pkgPath: join(w.root, "package.json"), cliEntry: join(w.root, "dist", "cli", "index.js") };
    return { code: await runCli(argv, app, w.io), text: w.transcript(), w };
  };

  it("writes a file-based client's entry itself: only the address, never the token", async () => {
    const { code, text, w } = await totem(["connect", "opencode"]);
    expect(code).toBe(0);
    const path = join(w.home, ".config", "opencode", "opencode.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcp: { servers: { whoop: { type: "remote", url: "https://totem-a1b2c3.fly.dev/mcp" } } } });
    expect(readFileSync(path, "utf8")).not.toContain(TOKEN);
    expect(text).toContain("Added the whoop server to OpenCode");
    expect(text).toMatch(/run \/mcps and sign in to whoop/);
    expect(text).not.toContain(TOKEN);
  });

  it("runs a command-based client's own command, then says how to sign in", async () => {
    const { code, text, w } = await totem(["connect", "codex"]);
    expect(code).toBe(0);
    expect(w.commands).toContain("exec  codex mcp add whoop --url https://totem-a1b2c3.fly.dev/mcp");
    expect(text).toContain("Codex opens the sign-in page in your browser");
    expect(text).toContain("run: codex mcp login whoop");
  });

  it("--print only shows what would be added", async () => {
    const { code, text, w } = await totem(["connect", "opencode", "--print"]);
    expect(code).toBe(0);
    expect(existsSync(join(w.home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(w.commands.filter((c) => c.startsWith("exec"))).toEqual([]);
    expect(text).toContain('"servers"');
    expect(text).toContain('"url": "https://totem-a1b2c3.fly.dev/mcp"');
  });

  it("opens claude.ai's Add custom connector dialog with the server filled in", async () => {
    const { code, text } = await totem(["connect", "claude"]);
    expect(code).toBe(0);
    expect(text).toContain("Opened claude.ai with the server filled in");
    expect(text.replace(/\s+/g, "")).toContain("https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=WHOOP&connectorUrl=https%3A%2F%2Ftotem-a1b2c3.fly.dev%2Fmcp");
  });

  it("sets up claude.ai once when Claude Desktop is also there (one connector serves both)", async () => {
    const { text } = await totem(["connect"], (w) => mkdirSync(join(w.home, "Library", "Application Support", "Claude"), { recursive: true }));
    expect(text.match(/Opened claude\.ai with the server filled in/g) ?? []).toHaveLength(1);
    expect(text).toContain("Opened your server's Connect page");
  });
});

describe("OpenCode: the older entry and commented config files", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
  const entry = { type: "remote", url: "https://totem-a1b2c3.fly.dev/mcp" };

  it("updates OpenCode 1's flat mcp.whoop when it is there, so both generations agree", () => {
    dir = mkdtempSync(join(tmpdir(), "totem-oc-"));
    const path = join(dir, "opencode.json");
    writeFileSync(path, JSON.stringify({ mcp: { whoop: { type: "local", command: ["node", "/old/server.js"], enabled: true }, other: { type: "remote", url: "https://x" } } }));
    mergeJsonConfig(path, "mcp.servers", "whoop", entry, { key: "mcp", entry: { ...entry, enabled: true } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      mcp: { whoop: { ...entry, enabled: true }, other: { type: "remote", url: "https://x" }, servers: { whoop: entry } },
    });
  });

  it("doesn't create the flat entry when it isn't there", () => {
    dir = mkdtempSync(join(tmpdir(), "totem-oc-"));
    const path = join(dir, "opencode.json");
    mergeJsonConfig(path, "mcp.servers", "whoop", entry, { key: "mcp", entry: { ...entry, enabled: true } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcp: { servers: { whoop: entry } } });
  });

  it("hands a file with comments to OpenCode's own command, run in the config folder", async () => {
    const w = fakeWorld({});
    try {
      const cfg = join(w.home, ".config", "opencode");
      mkdirSync(cfg, { recursive: true });
      writeFileSync(join(cfg, "opencode.json"), '{\n  // mine\n  "theme": "dark",\n}\n');
      writeDeployRecord(w.root, { platform: "fly", app: "totem-a1b2c3", url: "https://totem-a1b2c3.fly.dev", mcp_auth_token: TOKEN });
      const app: AppCtx = { root: w.root, version: "1.5.1", pkgName: "@thebriangao/totem", pkgPath: join(w.root, "package.json"), cliEntry: join(w.root, "dist", "cli", "index.js") };
      const code = await runCli(["connect", "opencode"], app, w.io);
      expect(code).toBe(0);
      expect(w.commands.some((c) => c.includes("opencode mcp add whoop --url https://totem-a1b2c3.fly.dev/mcp"))).toBe(true);
      expect(readFileSync(join(cfg, "opencode.json"), "utf8")).toContain("// mine");
      expect(w.transcript().replace(/\s+/g, " ")).toContain("letting OpenCode add the server itself");
    } finally {
      w.cleanup();
    }
  });
});

describe("totem connect, everything found", () => {
  it("keeps going when one app fails in a way totem didn't foresee", async () => {
    const w = fakeWorld({ exec: (cmd) => (cmd === "claude" ? (() => { throw new Error("EACCES: permission denied"); })() : undefined) });
    try {
      mkdirSync(join(w.home, ".cursor"), { recursive: true });
      writeDeployRecord(w.root, { platform: "local" });
      mkdirSync(join(w.root, "dist"), { recursive: true });
      writeFileSync(join(w.root, "dist", "server.js"), "");
      const app: AppCtx = { root: w.root, version: "2.0.0", pkgName: "@thebriangao/totem", pkgPath: join(w.root, "package.json"), cliEntry: join(w.root, "dist", "cli", "index.js") };
      await runCli(["connect"], app, w.io);
      const text = w.transcript().replace(/\s+/g, " ");
      expect(text).toContain("Couldn't set up Claude Code.");
      expect(text).toContain("Added the whoop server to Cursor");
    } finally {
      w.cleanup();
    }
  });
});
