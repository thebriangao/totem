// Shared helpers for the v2 activity tool tests: an in-memory MCP pair and a
// fake WhoopClient that routes by method + path and records every call.
import { afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { WhoopApiError, WhoopConflictError, parseOverlaps } from "../../src/whoop/errors.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

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

export const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

export function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

export interface Call { method: string; path: string; query: Record<string, unknown>; body?: unknown; fresh?: boolean }
type Handler = (call: Call) => unknown;

export const notFound = (path: string, text = "Requested activity does not exist"): WhoopApiError =>
  new WhoopApiError(404, path, text, text);
export const badRequest = (path: string, text: string): WhoopApiError => new WhoopApiError(400, path, text, text);
export const conflict = (path: string, body: string): WhoopConflictError => new WhoopConflictError(path, body, parseOverlaps(body));

/**
 * Fake WhoopClient. `route(call)` returns the response, or throws. Unrouted calls
 * throw so a test notices an unexpected request.
 */
export function fakeWhoop(route: Handler): { whoop: WhoopClient; calls: Call[]; writes: () => Call[] } {
  const calls: Call[] = [];
  const run = async (call: Call): Promise<unknown> => {
    calls.push(call);
    return route(call);
  };
  const whoop = {
    get: vi.fn((path: string, query: Record<string, unknown> = {}, options: { fresh?: boolean } = {}) =>
      run({ method: "GET", path, query, fresh: options.fresh === true })),
    post: vi.fn((path: string, body: unknown, query: Record<string, unknown> = {}) => run({ method: "POST", path, query, body })),
    put: vi.fn((path: string, body: unknown, query: Record<string, unknown> = {}) => run({ method: "PUT", path, query, body })),
    delete: vi.fn((path: string, query: Record<string, unknown> = {}) => run({ method: "DELETE", path, query })),
  } as unknown as WhoopClient;
  return { whoop, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

export function unrouted(call: Call): never {
  throw new Error(`unexpected ${call.method} ${call.path} ${JSON.stringify(call.query)}`);
}

/** The shared activity record, wrapped like create/edit responses. */
export function activityRecord(over: Record<string, unknown> = {}, wrap = true): Record<string, unknown> {
  const rec = {
    id: "act-1", cycle_id: 1974268448, user_id: 1, version: 0,
    during: "['2026-11-21T16:40:00.000Z','2026-11-21T16:45:00.000Z')",
    timezone: "America/Los_Angeles", source: "user", score_state: "pending",
    score_type: "CARDIO", type: "tennis", translated_type: "Tennis", activity_v1_id: 0, cycle_id_v2: 1974268448,
    ...over,
  };
  return wrap ? { activity: rec, strength_trainer_linkable: false } : rec;
}

export function cardioDetails(internal: string, start: string, end: string, scoreType = "CARDIO", strain = "---"): Record<string, unknown> {
  return {
    title_bar: { title_display: internal.toUpperCase() },
    horizontal_stat: { stat_main_value_display: strain },
    details_edit_components: {
      single_score_type: scoreType,
      activity_type_internal_name: internal,
      start_time_selector: { initial_time: start },
      end_time_selector: { initial_time: end },
      allowed_strap_locations: [{ strap_location: 0 }, { strap_location: 1 }],
    },
    link_workout_option_enabled: false,
  };
}

export function sleepDetails(nap: boolean, start: string, end: string): Record<string, unknown> {
  return {
    activity_display_type: "INCOMPLETE_ACTIVITY",
    sleep_details_labels: { screen_title_display: nap ? "INCOMPLETE NAP" : "INCOMPLETE SLEEP" },
    sleep_details_edit_components: { sleep_start_time: start, sleep_end_time: end, nap_to_sleep_available: nap },
  };
}

/** A home screen whose activities card holds the given tiles. */
export function homeWith(tiles: Array<{ id: string; type: string; internal_name: string; start: string; end: string; status?: string }>, cycleDay = "2026-11-21"): unknown {
  return {
    metadata: { cycle_metadata: { cycle_day: cycleDay } },
    pillars: [{ sections: [{ items: [{ content: { list: [{ content: { id: "activity_items_card", completed: { content: { items: tiles.map((t) => ({
      type: "ACTIVITY",
      content: {
        activity_v2_id: t.id, type: t.type, internal_name: t.internal_name, title: t.internal_name.toUpperCase(),
        status: t.status ?? "INCOMPLETE", score_display: "0:00", sport_id: -1,
        during: { lower_endpoint: t.start, upper_endpoint: t.end, lower_bound_type: "CLOSED", upper_bound_type: "OPEN" },
      },
    })) } } } }] } }] }] }],
  };
}
