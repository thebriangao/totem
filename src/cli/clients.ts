// The AI clients totem connects to, and exactly what each one needs.
//
// One registry answers both questions a person has at the end of setup:
//   - "do it for me": `totem local` / `totem connect <client>` write the
//     client's config file or run its own `mcp add` command;
//   - "what do I paste where": the connect card (connectCard) prints the same
//     recipe for every client.
//
// A recipe is data: a JSON file entry, a command, or steps in the client's
// settings. Rendering (recipeLines, connectCard) is pure; only applyRecipe
// touches the disk or runs anything.
//
// Two ways to reach totem:
//   - local: the client starts `node dist/server.js` itself (stdio). No secrets.
//   - remote: the client talks to https://<server>/mcp and signs in through
//     the server's own page with the connector password (OAuth). Nothing
//     secret is pasted into a config file or a command line.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { appConfigDir } from "./spawn.js";
import type { Io, Sys } from "./sys.js";
import { shellLines, type Kit } from "./ui.js";

/** The name totem registers itself under in every client. */
export const SERVER_NAME = "whoop";
export const FIRST_QUESTION = '"How did I sleep last night?"';

export type Target =
  | { kind: "local"; node: string; serverJs: string }
  | { kind: "remote"; mcpUrl: string };

export type Recipe =
  /** Merge `entry` under `key` in a JSON config file. A dotted key ("mcp.servers") names a nested object. */
  | { kind: "file"; path: string; key: string; entry: Record<string, unknown>; after: string }
  /**
   * Run the client's own command; `then` are follow-up commands or steps.
   * `remove` un-registers an earlier entry, so a re-run replaces it.
   */
  | { kind: "command"; argv: string[]; remove: string[]; then: string[]; after: string }
  /** Nothing to write: steps in the client's own settings. */
  | { kind: "steps"; steps: string[] }
  /** This client can't use this kind of install. */
  | { kind: "unavailable"; why: string };

export interface Client {
  id: string;
  name: string;
  /** Shown in the connect card (the rest are offered by `totem local` only). */
  featured: boolean;
  /** Is it installed on this machine? Decides the default choice. */
  detect(sys: Sys): boolean;
  recipe(target: Target, sys: Sys): Recipe;
}

const stdio = (t: Extract<Target, { kind: "local" }>): Record<string, unknown> => ({ command: t.node, args: [t.serverJs] });
const needsUrl = (name: string): Recipe => ({ kind: "unavailable", why: `${name} connects over the internet, so it needs a deployed server: totem cloud` });
const exists = (...parts: string[]): boolean => existsSync(join(...parts));

/** Arrow between menu levels, set per render (ASCII terminals get ">"). */
const PATH_SEP = "\u0001";
const menu = (...levels: string[]): string => levels.join(` ${PATH_SEP} `);

/**
 * OpenCode's global config. It reads `opencode.json` and `opencode.jsonc`; use
 * whichever the person already has, so totem never creates a second file
 * beside theirs.
 */
function opencodeConfig(sys: Sys): string {
  const dir = join(sys.env.XDG_CONFIG_HOME || join(sys.home, ".config"), "opencode");
  return !existsSync(join(dir, "opencode.json")) && existsSync(join(dir, "opencode.jsonc")) ? join(dir, "opencode.jsonc") : join(dir, "opencode.json");
}

// Checked on 2026-11-21 against each vendor's docs and, where installed, the
// tool's own --help (Claude Code 2.1, codex-cli 0.154, OpenCode 1.19 and 2.3,
// VS Code 1.142). What changed since v1:
//   - ChatGPT and Codex are one desktop app (July 2026). The app, the Codex CLI
//     and the IDE extension share ~/.codex/config.toml, so one `codex mcp add`
//     covers all three. chatgpt.com adds outside servers through Plugins.
//   - OpenCode 2 keeps servers under mcp.servers (1.19 reads that too) and has
//     no `enabled` field.
//   - VS Code reads the personal Copilot config, ~/.copilot/mcp-config.json
//     (shared with Copilot CLI). Its profile mcp.json is the deprecated path.
//   - Gemini CLI was retired in June 2026; Antigravity replaced it.
export const CLIENTS: Client[] = [
  {
    id: "claude", name: "claude.ai", featured: true,
    detect: () => false,
    recipe: (t) => t.kind === "local" ? needsUrl("claude.ai")
      : { kind: "steps", steps: [`${menu("Settings", "Connectors", "Add custom connector")}. Paste the URL.`] },
  },
  {
    id: "claude-desktop", name: "Claude Desktop", featured: true,
    detect: (sys) => exists(appConfigDir(sys.platform, sys.home, sys.env), "Claude"),
    recipe: (t, sys) => t.kind === "local"
      ? { kind: "file", path: join(appConfigDir(sys.platform, sys.home, sys.env), "Claude", "claude_desktop_config.json"), key: "mcpServers", entry: stdio(t), after: "Quit and reopen Claude Desktop." }
      : { kind: "steps", steps: ["Uses the claude.ai connector: add it there once and it shows up here and in the mobile app."] },
  },
  {
    id: "claude-code", name: "Claude Code", featured: true,
    detect: (sys) => sys.has("claude"),
    recipe: (t) => t.kind === "local"
      ? { kind: "command", argv: ["claude", "mcp", "add", "--scope", "user", SERVER_NAME, "--", t.node, t.serverJs], remove: ["claude", "mcp", "remove", "--scope", "user", SERVER_NAME], then: [], after: "Start a new Claude Code session." }
      : { kind: "command", argv: ["claude", "mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, t.mcpUrl], remove: ["claude", "mcp", "remove", "--scope", "user", SERVER_NAME], then: [`In Claude Code: /mcp ${PATH_SEP} ${SERVER_NAME} ${PATH_SEP} Authenticate`], after: `In Claude Code, run /mcp and authenticate ${SERVER_NAME}.` },
  },
  {
    // The ChatGPT desktop app and the Codex CLI: one config, so one entry.
    id: "chatgpt", name: "ChatGPT", featured: true,
    detect: (sys) => sys.has("codex") || exists(sys.home, ".codex"),
    recipe: (t, sys) => {
      const web = `On chatgpt.com: ${menu("Plugins", "+", "Add custom MCP server")}. Paste the URL.`;
      if (!sys.has("codex")) {
        // The desktop app without the codex command: its own settings screen.
        const add = menu("Settings", "MCP servers", "Add server");
        return t.kind === "local"
          ? { kind: "steps", steps: [`In the ChatGPT desktop app: ${add}. Choose STDIO and enter this command, then save and restart:`, `${t.node} ${t.serverJs}`] }
          : { kind: "steps", steps: [`In the ChatGPT desktop app: ${add}. Choose Streamable HTTP, paste the URL, save and restart, then select Authenticate.`, web] };
      }
      return t.kind === "local"
        ? { kind: "command", argv: ["codex", "mcp", "add", SERVER_NAME, "--", t.node, t.serverJs], remove: ["codex", "mcp", "remove", SERVER_NAME], then: [], after: "Restart ChatGPT, or start a new Codex session." }
        : { kind: "command", argv: ["codex", "mcp", "add", SERVER_NAME, "--url", t.mcpUrl], remove: ["codex", "mcp", "remove", SERVER_NAME], then: [`codex mcp login ${SERVER_NAME}`, web], after: `Run: codex mcp login ${SERVER_NAME}` };
    },
  },
  {
    id: "opencode", name: "OpenCode", featured: true,
    detect: (sys) => sys.has("opencode") || exists(sys.env.XDG_CONFIG_HOME || join(sys.home, ".config"), "opencode"),
    recipe: (t, sys) => ({
      kind: "file", path: opencodeConfig(sys), key: "mcp.servers",
      entry: t.kind === "local" ? { type: "local", command: [t.node, t.serverJs] } : { type: "remote", url: t.mcpUrl },
      after: t.kind === "local" ? "Start a new OpenCode session." : `In OpenCode, run /mcps and sign in to ${SERVER_NAME} (or run: opencode mcp auth ${SERVER_NAME}).`,
    }),
  },
  {
    id: "cursor", name: "Cursor", featured: true,
    detect: (sys) => exists(sys.home, ".cursor"),
    recipe: (t, sys) => ({
      kind: "file", path: join(sys.home, ".cursor", "mcp.json"), key: "mcpServers",
      entry: t.kind === "local" ? stdio(t) : { url: t.mcpUrl },
      after: t.kind === "local" ? `In Cursor: ${menu("Settings", "MCP")}, check ${SERVER_NAME} is on.` : `In Cursor: ${menu("Settings", "MCP", SERVER_NAME)}, then log in.`,
    }),
  },
  {
    id: "vscode", name: "VS Code", featured: false,
    detect: (sys) => exists(appConfigDir(sys.platform, sys.home, sys.env), "Code") || exists(sys.env.COPILOT_HOME || join(sys.home, ".copilot")),
    recipe: (t, sys) => ({
      kind: "file", path: join(sys.env.COPILOT_HOME || join(sys.home, ".copilot"), "mcp-config.json"), key: "mcpServers",
      entry: t.kind === "local" ? { type: "stdio", ...stdio(t), tools: ["*"] } : { type: "http", url: t.mcpUrl, tools: ["*"] },
      after: `In VS Code, run "Chat: Open Customizations" and find ${SERVER_NAME} under MCP Servers${t.kind === "local" ? "" : ", then sign in"}.`,
    }),
  },
  {
    id: "antigravity", name: "Antigravity", featured: false,
    detect: (sys) => sys.has("agy") || exists(sys.home, ".gemini", "antigravity") || exists(sys.home, ".gemini", "config"),
    recipe: (t, sys) => ({
      kind: "file", path: join(sys.home, ".gemini", "config", "mcp_config.json"), key: "mcpServers",
      entry: t.kind === "local" ? stdio(t) : { serverUrl: t.mcpUrl },
      after: `In Antigravity, type /mcp and check ${SERVER_NAME} is connected${t.kind === "local" ? "" : " (sign in when it asks)"}.`,
    }),
  },
];

export function findClient(id: string): Client | undefined {
  const wanted = id.toLowerCase().replace(/[\s_.]+/g, "-");
  // Old names still find the client that took their place.
  const alias: Record<string, string> = {
    "claude.ai": "claude", "claude-ai": "claude", desktop: "claude-desktop", code: "claude-code",
    codex: "chatgpt", "codex-cli": "chatgpt", "chatgpt-desktop": "chatgpt",
    "vs-code": "vscode", copilot: "vscode",
    gemini: "antigravity", "gemini-cli": "antigravity", agy: "antigravity",
  };
  return CLIENTS.find((cl) => cl.id === (alias[wanted] ?? wanted));
}

// ── rendering (pure) ─────────────────────────────────────────────────────────

/** `~/…` for a path under the home directory: shorter, and no username on screen. */
export function tildify(path: string, home: string): string {
  return home && (path === home || path.startsWith(home + "/") || path.startsWith(home + "\\")) ? "~" + path.slice(home.length) : path;
}

const withSep = (text: string, k: Kit): string => text.split(PATH_SEP).join(k.g.arrow);

/** The JSON a file recipe adds, as the lines to paste. */
export function recipeJson(recipe: Extract<Recipe, { kind: "file" }>): string[] {
  const nested = recipe.key.split(".").reduceRight<Record<string, unknown>>((inner, k) => ({ [k]: inner }), { [SERVER_NAME]: recipe.entry });
  return JSON.stringify(nested, null, 2).split("\n");
}

/** What to paste where for one recipe, indented under the client's name. */
export function recipeLines(recipe: Recipe, k: Kit, sys: Pick<Sys, "home" | "platform">): string[] {
  const width = k.style.width;
  switch (recipe.kind) {
    case "steps":
      return recipe.steps.flatMap((s) => k.para(withSep(s, k), 4));
    case "unavailable":
      return k.hint(recipe.why, 4);
    case "command":
      return [
        ...k.code(shellLines(recipe.argv, width - 4, sys.platform), 4),
        ...recipe.then.flatMap((t) => (t.includes(PATH_SEP) ? k.para(withSep(t, k), 4) : k.code([t], 4))),
      ];
    case "file":
      return [
        ...k.para(`Add to ${tildify(recipe.path, sys.home)}:`, 4),
        ...k.code(recipeJson(recipe), 4),
      ];
  }
}

export interface CardData {
  target: Target;
  /** Remote only: the connector password to show; null when totem doesn't have it. */
  password?: string | null | undefined;
  /** The password was put on the clipboard. */
  copied?: boolean | undefined;
}

/**
 * The connect card: for every featured client, exactly what to paste where.
 * Remote installs get the URL and password once at the top; every client then
 * needs only the URL, and signs in on the server's own page.
 */
export function connectCard(k: Kit, sys: Pick<Sys, "home" | "platform" | "has" | "env">, data: CardData): string[] {
  const { target } = data;
  const lines: string[] = [];
  if (target.kind === "remote") {
    lines.push(...k.rows([
      ["URL", k.c.accent(target.mcpUrl)],
      ["Password", data.password ? `${k.c.bold(data.password)}${data.copied ? k.c.dim("  (copied to the clipboard)") : ""}` : "the connector password from totem cloud"],
    ]));
    if (data.password) lines.push(...k.hint("totem shows the password this once. Save it in your password manager.", 2));
    lines.push("");
    lines.push(...k.para("Every client below opens a totem page in your browser. Check where access is going, then enter the password."));
  } else {
    lines.push(...k.para("Each client starts the server itself, on this computer:"));
    lines.push(...k.code(shellLines([tildify(target.node, sys.home), tildify(target.serverJs, sys.home)], k.style.width - 4, sys.platform)));
  }
  if (target.kind === "local") {
    // totem can set every one of these up itself: one command each, nothing to
    // paste by hand.
    const able = CLIENTS.filter((cl) => cl.recipe(target, sys as Sys).kind !== "unavailable");
    lines.push("", ...k.para("totem sets a client up for you:"));
    lines.push(...k.rows([
      ...able.map((cl): [string, string] => [cl.name, k.c.accent(`totem connect ${cl.id}`)]),
      ["Another client", k.c.accent("totem connect other")],
    ], 4));
    lines.push("", ...k.para("claude.ai connects over the internet, so it needs a deployed server: totem cloud"));
    return lines;
  }
  for (const client of CLIENTS.filter((cl) => cl.featured)) {
    const recipe = client.recipe(target, sys as Sys);
    lines.push("", `  ${k.c.bold(client.name)}`);
    // A config file is totem's to write (one command), not JSON to paste by hand.
    // `totem connect <client> --print` still shows the entry itself.
    if (recipe.kind === "file") lines.push(...k.code([`totem connect ${client.id}`], 4), ...k.para(withSep(recipe.after, k), 4));
    else lines.push(...recipeLines(recipe, k, sys));
  }
  lines.push("", `  ${k.c.bold("Another client")}`);
  lines.push(...k.para("Give it the URL. If it can't sign in through a browser, send the server's token as a bearer header instead:", 4));
  lines.push(...k.code(["Authorization: Bearer $(totem token)"], 4));
  return lines;
}

// ── applying a recipe ────────────────────────────────────────────────────────

/** A client config that totem won't rewrite, with the reason to show the user. */
export class ConfigNotMergeableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigNotMergeableError";
  }
}

// Merge { [key]: { [name]: entry } } into a JSON config without clobbering the
// user's other servers/settings. Idempotent.
//
// The file belongs to another app, and it is read strictly: when it isn't a
// plain JSON object (VS Code's mcp.json allows comments; hand-edited configs
// pick up trailing commas) totem can't tell what is in it, so it throws
// ConfigNotMergeableError and leaves the file exactly as it was. It used to
// treat that as an empty config and write one back holding only its own entry,
// deleting every other server. Before a file is changed, the previous contents
// are copied to `<file>.totem-backup`.
export function mergeJsonConfig(cfgPath: string, key: string, name: string, entry: Record<string, unknown>): { changed: boolean; backup?: string } {
  let merged: Record<string, unknown> = {};
  let previous: string | null = null;
  if (existsSync(cfgPath)) {
    previous = readFileSync(cfgPath, "utf8");
    if (previous.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(previous);
      } catch {
        throw new ConfigNotMergeableError(`${cfgPath} isn't plain JSON (comments or a trailing comma?), so totem left it untouched.`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ConfigNotMergeableError(`${cfgPath} doesn't hold a JSON object, so totem left it untouched.`);
      }
      merged = parsed as Record<string, unknown>;
    }
  }
  // Walk to the object that holds the servers ("mcp.servers" is two levels), creating
  // what is missing and refusing anything on the way that isn't an object.
  let holder = merged;
  const path = key.split(".");
  path.forEach((part, i) => {
    const existing = holder[part];
    if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
      throw new ConfigNotMergeableError(`"${path.slice(0, i + 1).join(".")}" in ${cfgPath} isn't an object, so totem left the file untouched.`);
    }
    const next = { ...((existing as Record<string, unknown> | undefined) ?? {}) };
    holder[part] = next;
    holder = next;
  });
  holder[name] = entry;
  const next = JSON.stringify(merged, null, 2) + "\n";
  if (previous !== null && previous.trim() === next.trim()) return { changed: false };
  mkdirSync(dirname(cfgPath), { recursive: true });
  let backup: string | undefined;
  if (previous !== null && previous.trim() !== "") {
    backup = `${cfgPath}.totem-backup`;
    copyFileSync(cfgPath, backup);
  }
  writeFileSync(cfgPath, next);
  return backup ? { changed: true, backup } : { changed: true };
}

export interface Applied {
  /** totem did it itself. */
  done: boolean;
  /** What the person still does, in order, for the closing "Next" box. */
  steps: string[];
}

/**
 * Do what a recipe says: write the file, or run the command. Prints the
 * result. When totem can't (a config it won't touch, a CLI that isn't
 * installed, a command that fails) it prints exactly what to do by hand and
 * returns done: false.
 */
export async function applyRecipe(io: Io, client: Client, recipe: Recipe): Promise<Applied> {
  const { ui, sys } = io;
  const k = ui.kit;
  switch (recipe.kind) {
    case "steps":
      ui.lines(recipeLines(recipe, k, sys));
      return { done: false, steps: [`Add the connector in ${client.name}.`] };
    case "unavailable":
      ui.warn(recipe.why);
      return { done: false, steps: [] };
    case "file": {
      const shown = tildify(recipe.path, sys.home);
      try {
        const { changed, backup } = mergeJsonConfig(recipe.path, recipe.key, SERVER_NAME, recipe.entry);
        ui.ok(changed ? `Added the ${SERVER_NAME} server to ${client.name}` : `${client.name} already has the ${SERVER_NAME} server`, shown);
        if (backup) ui.hint(`The previous file is kept as ${basename(backup)}.`);
        return { done: true, steps: [withSep(recipe.after, k)] };
      } catch (error) {
        if (!(error instanceof ConfigNotMergeableError)) throw error;
        ui.warn(error.message.split(recipe.path).join(shown));
        ui.para(`Add this under "${recipe.key}" in that file yourself:`, 4);
        ui.code(JSON.stringify({ [SERVER_NAME]: recipe.entry }, null, 2).split("\n"));
        return { done: false, steps: [`Add the entry above to ${shown}.`, withSep(recipe.after, k)] };
      }
    }
    case "command": {
      const [cmd, ...args] = recipe.argv as [string, ...string[]];
      const byHand = (): void => {
        ui.code(shellLines(recipe.argv, k.style.width - 4, sys.platform));
      };
      if (!sys.has(cmd)) {
        ui.warn(`The ${cmd} command isn't installed here. Once it is, run:`);
        byHand();
        return { done: false, steps: [`Install ${client.name}, then run the command above.`, withSep(recipe.after, k)] };
      }
      let r = await ui.task(`Adding ${SERVER_NAME} to ${client.name}`, () => sys.exec(cmd, args));
      let replaced = false;
      // An entry from an earlier setup may point somewhere else (another path,
      // a server since replaced): put this one in its place.
      if (r.code !== 0 && /already exists/i.test(`${r.stderr}\n${r.stdout}`) && recipe.remove.length) {
        const [rm, ...rmArgs] = recipe.remove as [string, ...string[]];
        r = await ui.task(`Replacing ${SERVER_NAME} in ${client.name}`, async () => {
          await sys.exec(rm, rmArgs);
          return sys.exec(cmd, args);
        });
        replaced = true;
      }
      if (r.code === 0) {
        ui.ok(`${replaced ? "Replaced" : "Added"} the ${SERVER_NAME} server ${replaced ? "in" : "to"} ${client.name}`, `${cmd} ${args.slice(0, 2).join(" ")}`);
        return { done: true, steps: [withSep(recipe.after, k)] };
      }
      ui.problem(`${cmd} ${args.slice(0, 2).join(" ")} failed.`, { detail: lastLine(r) });
      ui.para("Run it yourself:", 4);
      byHand();
      return { done: false, steps: ["Run the command above.", withSep(recipe.after, k)] };
    }
  }
}

/** The last non-empty line a command printed: usually its error. */
export function lastLine(r: { stdout: string; stderr: string }): string {
  const lines = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : "(it printed nothing)";
}
