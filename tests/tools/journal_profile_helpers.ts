// Shared harness for the journal / profile / settings v2 tool tests.
import { afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

export async function connect(register: (server: McpServer, client: WhoopClient) => void, whoop: unknown): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  register(server, whoop as WhoopClient);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

/** Tool text as JSON; input-schema rejections from the SDK are plain text. */
export function parse(result: unknown): any {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`../fixtures/v2/${name}`, import.meta.url), "utf8"));
}

/** A mock WhoopClient whose GETs are answered by path (functions get the call count). */
export function mockWhoop(routes: Record<string, unknown | ((n: number) => unknown)>) {
  const counts = new Map<string, number>();
  const get = vi.fn(async (path: string) => {
    const key = Object.keys(routes).find((k) => k === path) ?? Object.keys(routes).find((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)));
    if (key === undefined) throw new Error(`unmocked GET ${path}`);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const value = routes[key];
    const out = typeof value === "function" ? (value as (n: number) => unknown)(n) : value;
    if (out instanceof Error) throw out;
    return structuredClone(out);
  });
  return {
    get,
    put: vi.fn(async () => undefined as unknown),
    post: vi.fn(async () => undefined as unknown),
    delete: vi.fn(async () => undefined as unknown),
  };
}

/** Description and per-input describe budgets (BUILD-AGENTS token rules). */
export async function toolBudget(client: Client) {
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description?.length ?? 0,
    longestDescribe: Math.max(0, ...Object.values((t.inputSchema.properties ?? {}) as Record<string, { description?: string }>).map((p) => p.description?.length ?? 0)),
  }));
}
