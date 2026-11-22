// The links and commands that add a totem server to each app, in one place:
// the Connect page on a cloud server (src/whoop/connect_page.ts) and the CLI
// (src/cli/clients.ts) both build from these.
//
// Formats, checked against each app on 2026-11-22 (whoop-testing/install-map):
//  - claude.ai: a documented link that opens "Add custom connector" filled in.
//    The connector belongs to the account, so it also shows up in Claude
//    Desktop and the mobile apps.
//  - Cursor: cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64 JSON>,
//    and the same through https://cursor.com/en/install-mcp for pages that
//    strip custom schemes (GitHub).
//  - VS Code: vscode:mcp/install?<URL-encoded JSON with name and type>.
//  - Claude Code, Codex (ChatGPT desktop shares its config), OpenCode: one command.
//  - chatgpt.com and Antigravity: no link exists; steps or a config entry.

/** The name the server gets in every app. */
export const SERVER_NAME = "whoop";

/** The display name for the claude.ai connector list, next to "Notion" or "Linear". */
export const CONNECTOR_NAME = "WHOOP";

export function claudeConnectorLink(mcpUrl: string): string {
  const q = new URLSearchParams({ modal: "add-custom-connector", connectorName: CONNECTOR_NAME, connectorUrl: mcpUrl });
  return `https://claude.ai/customize/connectors?${q.toString()}`;
}

/** What Cursor's link carries: { url } for a server, { command, args } for a local one. */
export type CursorServer = { url: string } | { command: string; args: string[]; env?: Record<string, string> };

const cursorConfig = (server: CursorServer): string => encodeURIComponent(Buffer.from(JSON.stringify(server)).toString("base64"));

export function cursorInstallLink(server: CursorServer): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${cursorConfig(server)}`;
}

/** The same through cursor.com, which offers to open Cursor: for pages that drop custom-scheme links. */
export function cursorWebLink(server: CursorServer): string {
  return `https://cursor.com/en/install-mcp?name=${SERVER_NAME}&config=${cursorConfig(server)}`;
}

/** What VS Code's link carries. */
export type VsCodeServer = { type: "http"; url: string } | { type: "stdio"; command: string; args: string[] };

export function vscodeInstallLink(server: VsCodeServer): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, ...server }))}`;
}

/** Commands for the apps a terminal sets up, for a server at `mcpUrl`. */
export function remoteCommands(mcpUrl: string): { claudeCode: string; codex: string; opencode: string } {
  return {
    claudeCode: `claude mcp add --transport http --scope user ${SERVER_NAME} ${mcpUrl}`,
    codex: `codex mcp add ${SERVER_NAME} --url ${mcpUrl}`,
    // Run from the global config folder, OpenCode 1 and 2 both write the global file.
    opencode: `cd ~/.config/opencode && opencode mcp add ${SERVER_NAME} --url ${mcpUrl}`,
  };
}

/** Antigravity's config entry (~/.gemini/config/mcp_config.json) for a server at `mcpUrl`. */
export function antigravityEntry(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { serverUrl: mcpUrl } } }, null, 2);
}
