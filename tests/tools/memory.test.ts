import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhoopClient } from "../../src/whoop/client.js";
import { WhoopServerError } from "../../src/whoop/errors.js";
import { registerMemory } from "../../src/tools/v2/memory.js";
import { body, closeAll, connect, errorText, load } from "./helpers_coach.js";

afterEach(closeAll);

const CH = "/context-hub-bff/v1/context-hub";
const ID = "7d744bf9-9665-4382-bfe0-b3499491d84b";

describe("whoop_memory", () => {
  it("lists the timeline by default, fresh, without opening any detail", async () => {
    const get = vi.fn(async () => load("memory/items_goals.json"));
    const client = await connect((s) => registerMemory(s, { get } as unknown as WhoopClient));
    const out = body(await client.callTool({ name: "whoop_memory", arguments: {} }));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`${CH}/items`, { category: "timeline" }, { fresh: true });
    expect(out.view).toBe("items");
    expect((out.items as unknown[]).length).toBe(2);
  });

  it("passes any category string through", async () => {
    const get = vi.fn(async () => ({ filters: null, items: [], pagination: null }));
    const client = await connect((s) => registerMemory(s, { get } as unknown as WhoopClient));
    const out = body(await client.callTool({ name: "whoop_memory", arguments: { category: "coaching_preferences" } }));
    expect(get).toHaveBeenCalledWith(`${CH}/items`, { category: "coaching_preferences" }, { fresh: true });
    expect(out.items ?? []).toEqual([]);
    const bad = await client.callTool({ name: "whoop_memory", arguments: { category: "../x" } });
    expect(bad.isError).toBe(true);
  });

  it("opens a detail only on request and says it marks the memory seen", async () => {
    const get = vi.fn(async (path: string) => (path.includes("context-detail") ? load("memory/detail.json") : load("memory/items_goals.json")));
    const client = await connect((s) => registerMemory(s, { get } as unknown as WhoopClient));
    const out = body(await client.callTool({ name: "whoop_memory", arguments: { memory_id: ID } }));
    expect(get).toHaveBeenCalledWith(`${CH}/context-detail/${ID}`, {}, { fresh: true });
    expect(out).toMatchObject({ view: "detail", status: "ACTIVE", expires: "2027-03-31" });
    expect(String(out.note)).toContain("seen");
  });

  it("explains WHOOP's 500 for a deleted memory", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("context-detail")) throw new WhoopServerError(500, path, "Error 500 Internal Server Error");
      return load("memory/items_goals.json");
    });
    const client = await connect((s) => registerMemory(s, { get } as unknown as WhoopClient));
    const result = await client.callTool({ name: "whoop_memory", arguments: { memory_id: ID } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("deleted or unknown");
  });
});
