import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerCoachHistory } from "../../src/tools/v2/coach_history.js";
import { body, closeAll, connect, errorText, load } from "./helpers_coach.js";

afterEach(closeAll);

const AI = "/ai-conversation-bff/v1";

function whoop(get: (path: string, query: Record<string, unknown>) => unknown, post?: (path: string, b: unknown) => unknown) {
  const g = vi.fn(async (path: string, query: Record<string, unknown> = {}) => get(path, query));
  const p = vi.fn(async (path: string, b: unknown) => {
    if (!post) throw new Error(`unexpected POST ${path}`);
    return post(path, b);
  });
  return { client: { get: g, post: p } as unknown as WhoopClient, get: g, post: p };
}

describe("whoop_coach_history", () => {
  it("lists one short row per conversation with a cursor (default limit 10)", async () => {
    const w = whoop(() => load("coach/conversations.json"));
    const client = await connect((s) => registerCoachHistory(s, w.client));
    const out = body(await client.callTool({ name: "whoop_coach_history", arguments: {} }));
    expect(w.get).toHaveBeenCalledWith(`${AI}/conversations`, { limit: 10, next_token: undefined }, { fresh: true });
    expect(out.view).toBe("list");
    const rows = out.conversations as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ fingerprint: "totem-HOME-2026-11-21", title: "Can you chart my strain this week?", agent: "coach", day: "TODAY" });
    // App agents totem doesn't map keep their source id.
    expect(rows[1]!.agent).toBe("journal-agent");
    expect(Object.keys(rows[0]!).sort()).toEqual(["agent", "day", "fingerprint", "title"]);
    expect(out.next_cursor).toBe("eyIkIjoib0AxIiwibyI6NX0=");
    expect(w.post).not.toHaveBeenCalled();
  });

  it("passes the cursor through verbatim", async () => {
    const w = whoop(() => ({ conversations: [], next_token: null }));
    const client = await connect((s) => registerCoachHistory(s, w.client));
    await client.callTool({ name: "whoop_coach_history", arguments: { cursor: "eyIkIjoib0AxIiwibyI6Mn0=", limit: 2 } });
    expect(w.get).toHaveBeenCalledWith(`${AI}/conversations`, { limit: 2, next_token: "eyIkIjoib0AxIiwibyI6Mn0=" }, { fresh: true });
  });

  it("refuses to open a fingerprint that isn't listed (opening would create it)", async () => {
    const w = whoop(() => ({ ...(load("coach/conversations.json") as object), next_token: null }));
    const client = await connect((s) => registerCoachHistory(s, w.client));
    const result = await client.callTool({ name: "whoop_coach_history", arguments: { view: "transcript", fingerprint: "daily-outlook___cycle___1" } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("isn't in your coach history");
    expect(w.post).not.toHaveBeenCalled();
  });

  it("reopens a listed thread with the app's history body and returns compact turns", async () => {
    const w = whoop(
      () => load("coach/conversations.json"),
      () => ({ metadata: { title: "NEW CHAT 18:37:06", source_id: null }, turns: [{ id: "t0", turn_status: "COMPLETE", messages: [{ role: "assistant", items: [] }] }, load("coach/turn_chart.json"), load("coach/turn_logged_walk.json")] }),
    );
    const client = await connect((s) => registerCoachHistory(s, w.client));
    const out = body(await client.callTool({ name: "whoop_coach_history", arguments: { view: "transcript", fingerprint: "totem-HOME-2026-11-21" } }));
    expect(w.post).toHaveBeenCalledWith(`${AI}/conversation`, { fingerprint: "totem-HOME-2026-11-21", source_type: "UNKNOWN", source_id: "coach-chat" });
    expect(out).toMatchObject({ view: "transcript", agent: "coach", title: "Can you chart my strain this week?", total_turns: 2 });
    const turns = out.turns as Array<Record<string, unknown>>;
    expect(turns[1]).toMatchObject({ user: "Yes, log the walk", actions: ["Logged Walk"] });
    // Never a read receipt.
    expect(w.post.mock.calls.every((c) => !/seen|last-viewed/.test(String(c[0])))).toBe(true);
  });

  it("outlook: reports available:false without opening when the report doesn't exist (D8)", async () => {
    const w = whoop((path) => {
      if (path === "/home-service/v1/home") return { metadata: { cycle_metadata: { cycle_id: 555 } } };
      return { conversations: [], next_token: null };
    });
    const client = await connect((s) => registerCoachHistory(s, w.client));
    const out = body(await client.callTool({ name: "whoop_coach_history", arguments: { view: "outlook" } }));
    expect(out).toMatchObject({ view: "outlook", available: false });
    expect(String(out.note)).toContain('whoop_coach_ask {agent:"daily_outlook"}');
    expect(w.post).not.toHaveBeenCalled();
  });

  it("outlook: opens a listed report and reads its recommendations; falls back to today's older-cycle entry", async () => {
    const outlook = load("coach/outlook_turn.json");
    const w = whoop(
      (path) => {
        // Current cycle 1974268448 has no outlook, but today's group has one under 1974049188.
        if (path === "/home-service/v1/home") return { metadata: { cycle_metadata: { cycle_id: 1974268448 } } };
        if (path === `${AI}/conversations`) return load("coach/conversations.json");
        if (path === `${AI}/recommendation-widget`) return load("coach/recommendation_widget.json");
        throw new Error(`unexpected GET ${path}`);
      },
      (_path, b) => {
        expect(b).toEqual({ fingerprint: "daily-outlook___cycle___1974049188", source_type: "UNKNOWN", source_id: "daily-outlook" });
        return { turns: [outlook] };
      },
    );
    const client = await connect((s) => registerCoachHistory(s, w.client));
    const out = body(await client.callTool({ name: "whoop_coach_history", arguments: { view: "outlook" } }));
    expect(out).toMatchObject({ view: "outlook", available: true, fingerprint: "daily-outlook___cycle___1974049188" });
    expect(String(out.text)).toContain("Steady start");
    expect((out.recommendations as unknown[]).length).toBe(3);
    expect((out.warnings as string[]).join(" ")).toContain("older cycle id");
  });

  it("outlook: looks the day's cycle up from home?date and refuses future dates", async () => {
    const w = whoop((path, query) => {
      if (path === "/home-service/v1/home") {
        expect(query).toEqual({ date: "2026-11-20" });
        return { metadata: { cycle_metadata: { cycle_id: 1974266347 } } };
      }
      return { conversations: [], next_token: null };
    });
    const client = await connect((s) => registerCoachHistory(s, w.client));
    const out = body(await client.callTool({ name: "whoop_coach_history", arguments: { view: "outlook", kind: "day_in_review", date: "2026-11-20" } }));
    expect(out.available).toBe(false);
    const future = await client.callTool({ name: "whoop_coach_history", arguments: { view: "outlook", date: "2999-01-01" } });
    expect(future.isError).toBe(true);
  });

  it("is read-only", async () => {
    const client = await connect((s) => registerCoachHistory(s, whoop(() => ({})).client));
    const { tools } = await client.listTools();
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true });
  });
});
