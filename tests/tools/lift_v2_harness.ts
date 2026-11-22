// Shared MCP harness for the v2 strength tool tests: register a tool against a
// mocked WhoopClient and call it through an in-memory MCP client.
import { afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { readFileSync } from "node:fs";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

export type Register = (server: McpServer, client: WhoopClient) => void;

export async function connect(register: Register | Register[], whoop: Partial<Record<"get" | "post" | "put" | "delete", unknown>>): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  for (const r of Array.isArray(register) ? register : [register]) r(server, whoop as unknown as WhoopClient);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/strength_v2/${name}.json`, import.meta.url), "utf8")) as T;
}

/** Parse a tool result's JSON text. */
export function body(result: unknown): any {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0]!.text);
}

export const notFound = (path: string) => new WhoopApiError(404, path, "<html><title>404 Not Found</title></html>", "404 Not Found");

/**
 * A GET mock routed by path (exact, or a function of path + query). Unrouted
 * paths throw so a test notices an unexpected call.
 */
export function routes(table: Record<string, unknown | ((query: Record<string, unknown>, opts: unknown) => unknown)>) {
  return vi.fn(async (path: string, query: Record<string, unknown> = {}, opts: unknown = {}) => {
    if (!(path in table)) throw new Error(`unexpected GET ${path}`);
    const v = table[path];
    const out = typeof v === "function" ? (v as (q: Record<string, unknown>, o: unknown) => unknown)(query, opts) : v;
    if (out instanceof Error) throw out;
    return structuredClone(out);
  });
}

export const IMPERIAL = { profile: { unit_system: "imperial" } };
export const METRIC = { profile: { unit_system: "metric" } };
