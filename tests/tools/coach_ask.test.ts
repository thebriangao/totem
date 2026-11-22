import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhoopClient } from "../../src/whoop/client.js";
import { WhoopConflictError } from "../../src/whoop/errors.js";
import { askCoach, type CoachTiming } from "../../src/lib/coach_session.js";
import { planAsk, registerCoachAsk } from "../../src/tools/v2/coach_ask.js";
import { PNG_1PX, body, closeAll, connect, errorText, load } from "./helpers_coach.js";

afterEach(closeAll);

const AI = "/ai-conversation-bff/v1";
const DAY = "2026-11-21";

function fakeTiming(): CoachTiming & { clock: { t: number } } {
  const clock = { t: 0 };
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    pollDelayMs: () => 3_500,
    replyTimeoutMs: 60_000,
    settleTimeoutMs: 30_000,
  };
}

const base = { agent: "coach" as const, new_thread: false, confirm: false };

/** A mock WhoopClient routed by method + path. Unknown calls throw. */
function mockClient(routes: {
  get?: (path: string, query: Record<string, unknown>) => unknown;
  post?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const get = vi.fn(async (path: string, query: Record<string, unknown> = {}) => {
    if (!routes.get) throw new Error(`unexpected GET ${path}`);
    return routes.get(path, query);
  });
  const post = vi.fn(async (path: string, b: unknown) => {
    if (!routes.post) throw new Error(`unexpected POST ${path}`);
    return routes.post(path, b);
  });
  const del = vi.fn(async (path: string) => (routes.del ? routes.del(path) : undefined));
  const put = vi.fn(async () => { throw new Error("unexpected PUT"); });
  return { client: { get, post, put, delete: del } as unknown as WhoopClient, get, post, del, put };
}

const completeChart = load("coach/turn_chart.json") as Record<string, unknown>;

describe("planAsk validation", () => {
  it("rejects contradictory or incomplete inputs before any call", () => {
    expect(() => planAsk({ ...base, message: "hi", thread: "x", new_thread: true }, DAY)).toThrow(/not both/);
    expect(() => planAsk({ ...base, agent: "daily_outlook", message: "hi" }, DAY)).toThrow(/only generates or opens/);
    expect(() => planAsk({ ...base, agent: "activity", message: "hi" }, DAY)).toThrow(/needs activity_id/);
    expect(() => planAsk({ ...base, message: "hi", activity_id: "19c0b808-a639-4db0-9a01-2a9d84f5a0b5" }, DAY)).toThrow(/only applies/);
    expect(() => planAsk({ ...base }, DAY)).toThrow(/message is required/);
    expect(() => planAsk({ ...base, message: "hi", image_base64: "R0lGODlhAQABAAAAACw=" }, DAY)).toThrow(/PNG or JPEG/);
    expect(() => planAsk({ ...base, message: "hi", image_base64: "not base64!!" }, DAY)).toThrow(/valid base64/);
  });

  it("accepts a report agent with no message, and a PNG data URL", () => {
    expect(planAsk({ ...base, agent: "day_in_review" }, DAY)).toMatchObject({ agent: "day_in_review", newThread: false });
    const plan = planAsk({ ...base, message: "what's this?", image_base64: `data:image/png;base64,${PNG_1PX}` }, DAY);
    expect(plan.image).toMatchObject({ contentType: "image/png", bytes: 69 });
  });
});

describe("whoop_coach_ask through MCP", () => {
  it("previews today's local-day thread without calling WHOOP", async () => {
    const m = mockClient({});
    const client = await connect((server) => registerCoachAsk(server, m.client));
    const result = await client.callTool({ name: "whoop_coach_ask", arguments: { message: "How was my sleep?" } });
    expect(result.isError).not.toBe(true);
    const out = body(result);
    expect(out.preview).toBe(true);
    const will = out.will_execute as { method: string; path: string; body_summary: Record<string, unknown> };
    expect(will.method).toBe("POST");
    expect(will.path).toMatch(/^\/ai-conversation-bff\/v1\/conversation\/totem-HOME-\d{4}-\d{2}-\d{2}\/turn$/);
    expect(will.body_summary.source_id).toBe("coach-chat");
    expect(String(will.body_summary.warning)).toMatch(/create, edit or delete/);
    expect(m.get).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });

  it("is annotated destructive and open-world", async () => {
    const client = await connect((server) => registerCoachAsk(server, mockClient({}).client));
    const { tools } = await client.listTools();
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(tools[0]!.description!.length).toBeLessThanOrEqual(600);
  });

  it("returns validation errors as tool errors", async () => {
    const m = mockClient({});
    const client = await connect((server) => registerCoachAsk(server, m.client));
    const result = await client.callTool({ name: "whoop_coach_ask", arguments: { agent: "activity", message: "x", confirm: true } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("activity_id");
    expect(m.post).not.toHaveBeenCalled();
  });
});

describe("askCoach send path", () => {
  it("creates the day thread, posts by fingerprint, polls to COMPLETE and joins the reply", async () => {
    let polls = 0;
    const m = mockClient({
      post: (path) => {
        if (path === `${AI}/conversation`) return { metadata: { id: "uuid-not-used" }, turns: [{ id: "t0", turn_status: "ACTIVE", messages: [] }] };
        if (path === `${AI}/conversation/totem-HOME-${DAY}/turn`) return { id: "turn-1", turn_status: "ACTIVE", messages: [] };
        throw new Error(`unexpected POST ${path}`);
      },
      get: (path) => {
        // coach-chat's empty turn 0 must finish before posting (a post while it is ACTIVE 409'd live).
        if (path === `${AI}/conversation/totem-HOME-${DAY}/turn/t0`) return { id: "t0", turn_status: "COMPLETE", messages: [{ role: "assistant", items: [] }] };
        if (path === `${AI}/conversation/totem-HOME-${DAY}/turn/turn-1`) {
          polls++;
          return polls < 3 ? { id: "turn-1", turn_status: "ACTIVE", messages: completeChart.messages } : completeChart;
        }
        if (path === `${AI}/conversation/totem-HOME-${DAY}/suggestions`) return { suggestions: ["Show last week", "Explain strain"] };
        throw new Error(`unexpected GET ${path}`);
      },
    });
    const out = await askCoach(m.client, planAsk({ ...base, message: "Chart my strain" }, DAY), fakeTiming());
    expect(m.post.mock.calls[0]).toEqual([`${AI}/conversation`, {
      fingerprint: `totem-HOME-${DAY}`, source_type: "CHAT_WITH_AGENT", source_id: "coach-chat", args: {}, chat_entrypoint_experience: "STANDARD",
    }]);
    expect(m.post.mock.calls[1]).toEqual([`${AI}/conversation/totem-HOME-${DAY}/turn`, { role: "user", content: "Chart my strain", is_suggestion: false }]);
    // Turn 0 settled first, then 3 polls of the reply; no read receipts.
    expect(m.get.mock.calls[0]![0]).toBe(`${AI}/conversation/totem-HOME-${DAY}/turn/t0`);
    expect(polls).toBe(3);
    const paths = [...m.get.mock.calls, ...m.post.mock.calls].map((c) => String(c[0]));
    expect(paths.some((p) => /\/(seen|end-seen|last-viewed-turn)$/.test(p))).toBe(false);
    expect(paths.some((p) => p.includes("uuid-not-used"))).toBe(false);
    expect(out.verified).toBe(true);
    expect(out.thread).toBe(`totem-HOME-${DAY}`);
    expect(out.text).toContain("- Allow 8–9 hours for sleep");
    expect(out.cards[0]).toMatchObject({ type: "chart", bars: [["2026-11-21", "20.9"]] });
    expect(out.suggestions).toEqual(["Show last week", "Explain strain"]);
    expect(out.warnings).toEqual([]);
  });

  it("waits for a non-coach agent's turn-0 greeting before posting, with the agent's args", async () => {
    const order: string[] = [];
    const fp = `totem-SLEEP-${DAY}`;
    const m = mockClient({
      post: (path, b) => {
        order.push(`POST ${path}`);
        if (path === `${AI}/conversation`) {
          expect(b).toMatchObject({ source_id: "sleep-deep-dive-agent", args: { context: "sleep_deepdive" } });
          return { turns: [{ id: "greet", turn_status: "ACTIVE", messages: [] }] };
        }
        return { id: "turn-1" };
      },
      get: (path) => {
        order.push(`GET ${path}`);
        if (path.endsWith("/turn/greet")) return { id: "greet", turn_status: "COMPLETE", messages: [{ role: "assistant", items: [{ type: "MARKDOWN_CHAT_TEXT", content: { text: "Hi!" } }] }] };
        if (path.endsWith("/turn/turn-1")) return load("coach/turn_logged_walk.json");
        return { suggestions: [] };
      },
    });
    const out = await askCoach(m.client, planAsk({ ...base, agent: "sleep", message: "Why short?" }, DAY), fakeTiming());
    expect(order.slice(0, 3)).toEqual([`POST ${AI}/conversation`, `GET ${AI}/conversation/${fp}/turn/greet`, `POST ${AI}/conversation/${fp}/turn`]);
    expect(out.actions).toEqual(["Logged Walk"]);
    expect(out.warnings.join(" ")).toMatch(/changed your data/);
  });

  it("on 409 'Another message is currently being processed', waits for the active turn and resends", async () => {
    let turnPosts = 0;
    const m = mockClient({
      post: (path) => {
        if (path === `${AI}/conversation`) return { turns: [{ id: "t0", turn_status: "COMPLETE" }, { id: "busy", turn_status: "ACTIVE" }].slice(0, turnPosts === 0 ? 1 : 2) };
        turnPosts++;
        if (turnPosts === 1) {
          throw new WhoopConflictError(`${AI}/conversation/x/turn`, "Another message is currently being processed for this chat session.", []);
        }
        return { id: "turn-2" };
      },
      get: (path) => {
        if (path.endsWith("/turn/busy")) return { id: "busy", turn_status: "COMPLETE", messages: [] };
        if (path.endsWith("/turn/turn-2")) return completeChart;
        return { suggestions: [] };
      },
    });
    const out = await askCoach(m.client, planAsk({ ...base, message: "And hydration?" }, DAY), fakeTiming());
    expect(turnPosts).toBe(2);
    expect(m.get.mock.calls.some((c) => String(c[0]).endsWith("/turn/busy"))).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/busy/);
  });

  it("times out after the reply window without the 'stable text' shortcut", async () => {
    const timing = fakeTiming();
    const m = mockClient({
      post: (path) => (path === `${AI}/conversation` ? { turns: [] } : { id: "turn-1" }),
      // Same partial text every poll while ACTIVE (tools running): keep waiting.
      get: () => ({ id: "turn-1", turn_status: "ACTIVE", messages: [{ role: "assistant", items: [{ type: "MARKDOWN_CHAT_TEXT", content: { text: "I'll pull your data…" } }] }] }),
    });
    const out = await askCoach(m.client, planAsk({ ...base, message: "Chart it" }, DAY), timing);
    expect(timing.clock.t).toBeGreaterThanOrEqual(60_000);
    expect(m.get.mock.calls.length).toBeGreaterThan(10);
    expect(out.verified).toBe(false);
    expect(out.text).toBe("I'll pull your data…");
    expect(out.warnings.join(" ")).toMatch(/whoop_coach_history \{view:"transcript"/);
    expect(out.suggestions).toEqual([]);
  });

  it("stops at WHOOP's FAILED status instead of polling out the timeouts", async () => {
    // Shapes from the live run (2026-11-21): the activity agent's greeting and the
    // turn posted after it both came back FAILED with no messages, and stayed so.
    const timing = fakeTiming();
    const failed = (id: string, n: number) => ({ id, turn_status: "FAILED", messages: [], turn_number: n, feedback: null });
    const m = mockClient({
      post: (path) => (path === `${AI}/conversation`
        ? { turns: [{ id: "greet", turn_status: "ACTIVE", messages: [], turn_number: 0 }] }
        : { id: "turn-1", turn_status: "ACTIVE", messages: [], turn_number: 1 }),
      get: (path) => {
        if (path.endsWith("/turn/greet")) return failed("greet", 0);
        if (path.endsWith("/turn/turn-1")) return failed("turn-1", 1);
        throw new Error(`unexpected GET ${path}`);
      },
    });
    const plan = planAsk({ ...base, agent: "activity", activity_id: "70ad76a1-1e3c-4c8e-a026-903ff3175783", message: "How hard was it?" }, DAY);
    const out = await askCoach(m.client, plan, timing);
    // One poll of the failed greeting and one of the failed reply (it was 9 + 18
    // polls over 90 s), and no suggestions read.
    expect(m.get).toHaveBeenCalledTimes(2);
    expect(timing.clock.t).toBeLessThan(10_000);
    expect(out.verified).toBe(false);
    expect(out.text).toBeNull();
    expect(out.warnings.join(" ")).toMatch(/FAILED/);
    expect(out.warnings.join(" ")).not.toMatch(/read it later/);
  });

  it("uploads, attaches and then deletes an image", async () => {
    const m = mockClient({
      post: (path, b) => {
        if (path === `${AI}/files`) {
          expect(b).toMatchObject({ origin: "camera_roll", content_type: "image/png", base64_content: PNG_1PX });
          expect((b as { filename: string }).filename).toMatch(/^totem-\d+\.png$/);
          return { file_id: "d2a3060c-e478-426b-a221-f359dda81fc0.png", size: 69 };
        }
        if (path.endsWith("/turn")) {
          expect(b).toEqual({ role: "user", content: "What is this?", is_suggestion: false, file_ids: ["d2a3060c-e478-426b-a221-f359dda81fc0.png"] });
          return { id: "turn-1" };
        }
        return { turns: [] };
      },
      get: (path) => (path.endsWith("/suggestions") ? { suggestions: [] } : completeChart),
    });
    const out = await askCoach(m.client, planAsk({ ...base, message: "What is this?", image_base64: PNG_1PX }, DAY), fakeTiming());
    expect(m.del).toHaveBeenCalledWith(`${AI}/files/d2a3060c-e478-426b-a221-f359dda81fc0.png`);
    expect(out.image_deleted).toBe(true);
  });

  it("still deletes the uploaded image when the turn fails", async () => {
    const m = mockClient({
      post: (path) => {
        if (path === `${AI}/files`) return { file_id: "f.png" };
        if (path.endsWith("/turn")) throw new Error("boom");
        return { turns: [] };
      },
    });
    await expect(askCoach(m.client, planAsk({ ...base, message: "x", image_base64: PNG_1PX }, DAY), fakeTiming())).rejects.toThrow("boom");
    expect(m.del).toHaveBeenCalledWith(`${AI}/files/f.png`);
  });

  it("continues only listed threads, reopening with the listed agent", async () => {
    const list = load("coach/conversations.json");
    const unlisted = mockClient({ get: () => ({ ...(list as object), next_token: null }) });
    await expect(askCoach(unlisted.client, planAsk({ ...base, message: "x", thread: "made-up-fp" }, DAY), fakeTiming())).rejects.toThrow(/isn't in your coach history/);
    expect(unlisted.post).not.toHaveBeenCalled();

    const m = mockClient({
      get: (path) => {
        if (path === `${AI}/conversations`) return list;
        if (path.endsWith("/suggestions")) return { suggestions: [] };
        return completeChart;
      },
      post: (path) => (path === `${AI}/conversation` ? { turns: [] } : { id: "turn-9" }),
    });
    await askCoach(m.client, planAsk({ ...base, message: "Thanks!", thread: "day-in-review___cycle___1974268448" }, DAY), fakeTiming());
    expect(m.post.mock.calls[0]).toEqual([`${AI}/conversation`, { fingerprint: "day-in-review___cycle___1974268448", source_type: "UNKNOWN", source_id: "day-in-review" }]);
    expect(m.post.mock.calls[1]![0]).toBe(`${AI}/conversation/day-in-review___cycle___1974268448/turn`);
  });

  it("puts the activity id in both the fingerprint and the agent args", async () => {
    const id = "19c0b808-a639-4db0-9a01-2a9d84f5a0b5";
    const m = mockClient({
      post: (path) => (path === `${AI}/conversation` ? { turns: [] } : { id: "turn-1" }),
      get: (path) => (path.endsWith("/suggestions") ? { suggestions: [] } : completeChart),
    });
    const out = await askCoach(m.client, planAsk({ ...base, agent: "activity", activity_id: id, message: "How hard was it?" }, DAY), fakeTiming());
    expect(out.thread).toBe(`totem-ACTIVITY-${DAY}-${id}`);
    expect(m.post.mock.calls[0]![1]).toMatchObject({
      source_id: "coach-everywhere-cardio-activity-details",
      args: { context: "cardio_activity_details", activity_id: id },
    });
  });

  it("generates the Daily Outlook for the cycle read fresh from home, then reads its recommendations", async () => {
    const outlook = load("coach/outlook_turn.json") as { id: string };
    const m = mockClient({
      get: (path, query) => {
        if (path === "/home-service/v1/home") return { metadata: { cycle_metadata: { cycle_id: 1974268448 } } };
        if (path === `${AI}/conversations`) return { conversations: [], next_token: null };
        if (path === `${AI}/conversation/daily-outlook___cycle___1974268448/turn/${outlook.id}`) return outlook;
        if (path === `${AI}/recommendation-widget`) {
          expect(query).toMatchObject({ turnId: outlook.id, conversationFingerprint: "daily-outlook___cycle___1974049188" });
          return load("coach/recommendation_widget.json");
        }
        throw new Error(`unexpected GET ${path}`);
      },
      post: (path, b) => {
        expect(path).toBe(`${AI}/conversation`);
        expect(b).toEqual({ fingerprint: "daily-outlook___cycle___1974268448", source_id: "daily-outlook", source_type: "UNKNOWN" });
        return { turns: [{ id: outlook.id, turn_status: "ACTIVE", messages: [] }] };
      },
    });
    const out = await askCoach(m.client, planAsk({ ...base, agent: "daily_outlook" }, DAY), fakeTiming());
    // Home was read uncached (cycle ids change under sleep edits).
    expect(m.get.mock.calls.find((c) => c[0] === "/home-service/v1/home")![2]).toEqual({ fresh: true });
    expect(out.thread).toBe("daily-outlook___cycle___1974268448");
    expect(out.verified).toBe(true);
    expect(out.report).toMatchObject({ kind: "daily_outlook", generated: true });
    expect(out.report!.recommendations).toHaveLength(3);
    expect(out.text).toContain("Steady start");
  });

  it("opens an existing report as turn 0, not the member's latest follow-up reply", async () => {
    // Live 2026-11-21: after one reply in the outlook thread, agent daily_outlook
    // returned that reply's text as the report, with no recommendations.
    const outlook = load("coach/outlook_turn.json") as { id: string };
    const followUp = {
      id: "follow-up", turn_status: "COMPLETE",
      messages: [
        { role: "user", items: [{ type: "MARKDOWN_CHAT_TEXT", content: { text: "Which matters most?" } }] },
        { role: "assistant", items: [{ type: "MARKDOWN_CHAT_TEXT", content: { text: "Cycling—keep it easy today." } }] },
      ],
    };
    const m = mockClient({
      get: (path) => {
        if (path === "/home-service/v1/home") return { metadata: { cycle_metadata: { cycle_id: 1974049188 } } };
        if (path === `${AI}/conversations`) return load("coach/conversations.json");
        if (path === `${AI}/recommendation-widget`) return load("coach/recommendation_widget.json");
        throw new Error(`unexpected GET ${path}`);
      },
      post: () => ({ turns: [outlook, followUp] }),
    });
    const out = await askCoach(m.client, planAsk({ ...base, agent: "daily_outlook" }, DAY), fakeTiming());
    expect(out.text).toContain("Steady start");
    expect(out.text).not.toContain("Cycling—keep it easy");
    expect(out.report).toMatchObject({ kind: "daily_outlook", generated: false });
    expect(out.report!.recommendations).toHaveLength(3);
    expect(out.verified).toBe(true);
  });
});
