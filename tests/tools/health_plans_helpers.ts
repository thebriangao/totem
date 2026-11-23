// Test helpers for the health-plans tools: an in-memory MCP pair, fixture loading,
// and a path-routed mocked WHOOP client.
import { afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

export const fx = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

export async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  register(server);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { isError: result.isError === true, out: JSON.parse(text) as Record<string, any>, text };
}

type Route = unknown | ((query: Record<string, unknown>, nth: number) => unknown);

/**
 * GET router: `routes[path]` is a value, an Error to throw, or a function of
 * (query, nth call to that path). Arrays of responses are served in order (last repeats).
 */
export function routedGet(routes: Record<string, Route>) {
  const seen = new Map<string, number>();
  return vi.fn(async (path: string, query: Record<string, unknown> = {}) => {
    if (!(path in routes)) throw new Error(`unexpected GET ${path}`);
    const n = seen.get(path) ?? 0;
    seen.set(path, n + 1);
    let r = routes[path];
    if (typeof r === "function") r = (r as (q: Record<string, unknown>, n: number) => unknown)(query, n);
    else if (Array.isArray(r) && r.length && r.every((x) => x !== null && typeof x === "object" && "__seq" in (x as object))) {
      r = (r[Math.min(n, r.length - 1)] as { __seq: unknown }).__seq;
    }
    if (r instanceof Error) throw r;
    return structuredClone(r);
  });
}

/** Serve responses in order for one path (the last one repeats). */
export const seq = (...values: unknown[]) => values.map((v) => ({ __seq: v }));

export function mockClient(parts: Partial<Record<"get" | "post" | "put" | "delete", ReturnType<typeof vi.fn>>>): WhoopClient {
  return parts as unknown as WhoopClient;
}
