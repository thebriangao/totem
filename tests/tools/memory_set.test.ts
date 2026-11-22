import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerMemorySet } from "../../src/tools/v2/memory_set.js";
import { body, closeAll, connect, errorText, load } from "./helpers_coach.js";

afterEach(closeAll);

const CH = "/context-hub-bff/v1/context-hub";
const SETTINGS = "/ai-conversation-service/v1/settings";
const ID = "7d744bf9-9665-4382-bfe0-b3499491d84b";

type Card = { id: string; status: string };

/** A fake context hub: timeline items with mutable status; PUT/DELETE change it. */
function hub(initial: Card[] = [{ id: ID, status: "ACTIVE" }]) {
  const goals = load("memory/items_goals.json") as { filters: unknown; items: Array<{ content: Record<string, unknown> }> };
  let cards = initial.map((c) => ({ ...c }));
  const itemsFor = () => ({
    filters: goals.filters,
    items: cards.map((c) => {
      const tpl = goals.items.find((i) => i.content.id === c.id) ?? goals.items[0]!;
      return { type: "CONTEXT_CARD", content: { ...tpl.content, id: c.id, status: c.status } };
    }),
  });
  let memoryOn = true;
  const settings = () => {
    const s = load("memory/ai_settings_memory_off.json") as { settings: Array<{ setting_key: string; active: boolean }> };
    s.settings.find((x) => x.setting_key === "WHOOP_COACH_MEMORY")!.active = memoryOn;
    return s;
  };
  const get = vi.fn(async (path: string, query: Record<string, unknown> = {}) => {
    if (path === `${CH}/items`) return query.category === "timeline" ? itemsFor() : { items: [] };
    if (path === SETTINGS) return settings();
    throw new Error(`unexpected GET ${path}`);
  });
  const put = vi.fn(async (path: string, b: Record<string, unknown>) => {
    if (path === SETTINGS) { memoryOn = b.active as boolean; return settings(); }
    const id = path.split("/").at(-2);
    cards = cards.map((c) => (c.id === id ? { ...c, status: b.target_state as string } : c));
    return undefined;
  });
  const del = vi.fn(async (path: string) => { cards = cards.filter((c) => !path.endsWith(c.id)); return undefined; });
  return { client: { get, put, delete: del, post: vi.fn() } as unknown as WhoopClient, get, put, del, setMemory: (v: boolean) => { memoryOn = v; } };
}

describe("whoop_memory_set", () => {
  it("previews a delete with the card and changes nothing", async () => {
    const h = hub();
    const client = await connect((s) => registerMemorySet(s, h.client));
    const out = body(await client.callTool({ name: "whoop_memory_set", arguments: { action: "delete", memory_id: ID } }));
    const will = out.will_execute as { method: string; path: string; body_summary: { memory: Record<string, unknown>; note: string } };
    expect(will).toMatchObject({ method: "DELETE", path: `${CH}/context-detail/${ID}` });
    expect(will.body_summary.memory).toMatchObject({ id: ID, title: "Training for a 10k race", status: "ACTIVE" });
    expect(will.body_summary.note).toContain("Permanent");
    expect(h.del).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    // The pre-read never opens the detail (a read receipt).
    expect(h.get.mock.calls.every((c) => !String(c[0]).includes("context-detail"))).toBe(true);
  });

  it("deactivates with the exact PUT and verifies from the list", async () => {
    const h = hub();
    const client = await connect((s) => registerMemorySet(s, h.client));
    const out = body(await client.callTool({ name: "whoop_memory_set", arguments: { action: "deactivate", memory_id: ID, confirm: true } }));
    expect(h.put).toHaveBeenCalledWith(`${CH}/context-detail/${ID}/status`, { target_state: "INACTIVE" });
    expect(out).toMatchObject({ action: "deactivate", changed: true, verified: true, memory: { id: ID, status: "INACTIVE" } });
  });

  it("skips the write when the memory is already in the target state", async () => {
    const h = hub([{ id: ID, status: "ACTIVE" }]);
    const client = await connect((s) => registerMemorySet(s, h.client));
    const out = body(await client.callTool({ name: "whoop_memory_set", arguments: { action: "activate", memory_id: ID, confirm: true } }));
    expect(h.put).not.toHaveBeenCalled();
    expect(out).toMatchObject({ changed: false, verified: true });
  });

  it("deletes and verifies the card is gone", async () => {
    const h = hub();
    const client = await connect((s) => registerMemorySet(s, h.client));
    const out = body(await client.callTool({ name: "whoop_memory_set", arguments: { action: "delete", memory_id: ID, confirm: true } }));
    expect(h.del).toHaveBeenCalledWith(`${CH}/context-detail/${ID}`);
    expect(out).toMatchObject({ changed: true, verified: true, memory: { id: ID } });
  });

  it("reports verified:false when a 204 didn't stick", async () => {
    const h = hub();
    h.del.mockImplementation(async () => undefined); // WHOOP answers 204 but keeps it
    const client = await connect((s) => registerMemorySet(s, h.client));
    const out = body(await client.callTool({ name: "whoop_memory_set", arguments: { action: "delete", memory_id: ID, confirm: true } }));
    expect(out.verified).toBe(false);
    expect((out.warnings as string[]).join(" ")).toContain("still listed");
  });

  it("refuses an unknown memory id and bad action/id combinations", async () => {
    const h = hub();
    const client = await connect((s) => registerMemorySet(s, h.client));
    const unknown = await client.callTool({ name: "whoop_memory_set", arguments: { action: "delete", memory_id: "00000000-0000-4000-8000-000000000000", confirm: true } });
    expect(unknown.isError).toBe(true);
    expect(errorText(unknown)).toContain("No memory");
    const noId = await client.callTool({ name: "whoop_memory_set", arguments: { action: "activate" } });
    expect(noId.isError).toBe(true);
    const extraId = await client.callTool({ name: "whoop_memory_set", arguments: { action: "disable_memory", memory_id: ID } });
    expect(extraId.isError).toBe(true);
    expect(h.del).not.toHaveBeenCalled();
  });

  it("turns memory off with the exact settings PUT, reads it back, and warns the coach may still claim to save", async () => {
    const h = hub();
    const client = await connect((s) => registerMemorySet(s, h.client));
    const preview = body(await client.callTool({ name: "whoop_memory_set", arguments: { action: "disable_memory" } }));
    expect((preview.will_execute as { body_summary: Record<string, unknown> }).body_summary).toMatchObject({ setting_key: "WHOOP_COACH_MEMORY", active: false, currently: true });
    expect(h.put).not.toHaveBeenCalled();
    const out = body(await client.callTool({ name: "whoop_memory_set", arguments: { action: "disable_memory", confirm: true } }));
    expect(h.put).toHaveBeenCalledWith(SETTINGS, { setting_key: "WHOOP_COACH_MEMORY", active: false });
    expect(out).toMatchObject({ changed: true, memory_enabled: false, verified: true });
    expect((out.warnings as string[]).join(" ")).toContain("nothing is stored");
    // The read-back is a GET after the PUT.
    const lastGet = h.get.mock.calls.at(-1)!;
    expect(lastGet[0]).toBe(SETTINGS);
  });

  it("is annotated destructive", async () => {
    const client = await connect((s) => registerMemorySet(s, hub().client));
    const { tools } = await client.listTools();
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
