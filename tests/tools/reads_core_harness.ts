// Shared test harness for the reads-core v2 tools: an in-memory MCP pair, a
// routed mock client, and fixture loading. Not a test file itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { WhoopServerError } from "../../src/whoop/errors.js";

const FX = fileURLToPath(new URL("../fixtures/v2-core/", import.meta.url));
const OLD_FX = fileURLToPath(new URL("../fixtures/", import.meta.url));
export const fx = (name: string): unknown => JSON.parse(readFileSync(`${FX}${name}.json`, "utf8"));
export const oldFx = (name: string): unknown => JSON.parse(readFileSync(`${OLD_FX}${name}.json`, "utf8"));

export const err500 = (path: string): WhoopServerError => new WhoopServerError(500, path, "Error 500 Internal Server Error");

/** A route value, or an Error to reject with. Keys are exact paths. */
export type Routes = Record<string, unknown>;

export function routedGet(routes: Routes): ReturnType<typeof vi.fn> {
  return vi.fn(async (path: string) => {
    if (!(path in routes)) throw new Error(`unexpected GET ${path}`);
    const v = routes[path];
    if (v instanceof Error) throw v;
    return v;
  });
}

const closers: Array<() => Promise<void>> = [];
export async function closeAll(): Promise<void> {
  await Promise.all(closers.splice(0).map((c) => c()));
}

export async function connect(register: (server: McpServer, client: WhoopClient) => void, get: ReturnType<typeof vi.fn>): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  register(server, { get } as unknown as WhoopClient);
  const client = new Client({ name: "test-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

/** Call a tool and parse its JSON text; throws with the text when the call errored. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

/** The paths a mocked get was called with, in order. */
export const paths = (get: ReturnType<typeof vi.fn>): string[] => get.mock.calls.map((c) => c[0] as string);
export const queryFor = (get: ReturnType<typeof vi.fn>, path: string): Record<string, unknown> =>
  (get.mock.calls.find((c) => c[0] === path)?.[1] ?? {}) as Record<string, unknown>;

/** Pin "today" to 2026-11-21 (US Pacific) for date-default logic. */
let savedTz: string | undefined;
export function pinToday(): void {
  savedTz = process.env.WHOOP_TIMEZONE;
  process.env.WHOOP_TIMEZONE = "America/Los_Angeles";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T20:00:00.000Z"));
}
export function unpinToday(): void {
  vi.useRealTimers();
  if (savedTz === undefined) delete process.env.WHOOP_TIMEZONE;
  else process.env.WHOOP_TIMEZONE = savedTz;
}
