// Coach projections on throwaway-account turns (probes/2026-11-21/ai.ndjson, scrubbed).
import { describe, expect, it } from "vitest";
import {
  agentForSource,
  assistantText,
  homeCycleId,
  projectConversationList,
  projectRecommendations,
  projectTranscript,
  recommendationPath,
  turnActions,
  turnCards,
  userText,
} from "../../src/projections/coach.js";
import { CoachAskReceipt } from "../../src/schemas/coach.js";
import { load } from "../tools/helpers_coach.js";

describe("coach turn projection", () => {
  it("joins every assistant MARKDOWN_CHAT_TEXT (preface + all fragments), not just the first", () => {
    const turn = load("coach/turn_chart.json");
    const text = assistantText(turn)!;
    expect(text.startsWith("I’ll pull your daily Strain")).toBe(true);
    expect(text).toContain("**Today’s Strain is 20.9");
    expect(text).toContain("- Keep the rest of tonight restful");
    expect(text).toContain("- Allow 8–9 hours for sleep");
    expect(text.endsWith("Does today’s reading match how active you’ve been?")).toBe(true);
    // The user's own message is never part of the reply.
    expect(text).not.toContain("Show me a chart");
    expect(userText(turn)).toContain("Show me a chart");
  });

  it("turns a chart into a short card with [date, label] bars and drops the deep-link payload", () => {
    const cards = turnCards(load("coach/turn_chart.json"));
    expect(cards).toEqual([
      { type: "chart", title: "Strain — Nov 16–21, 2026", bars: [["2026-11-21", "20.9"]] },
      { type: "link", title: "GO TO DAY STRAIN TRENDS" },
    ]);
  });

  it("surfaces ICON_MARKDOWN_CALLOUT badges as actions (the coach's real writes)", () => {
    const turn = load("coach/turn_logged_walk.json");
    expect(turnActions(turn)).toEqual(["Logged Walk"]);
    expect(assistantText(turn)).toContain("Your 20-minute walk is logged");
    expect(turnCards(turn)).toEqual([]);
  });

  it("reports an AI workout as a hidden draft template key", () => {
    const [card] = turnCards(load("coach/turn_workout_draft.json"));
    expect(card).toEqual({
      type: "workout_draft",
      title: "Probe AI Upper",
      draft_template_key: 18085225,
      exercises: ["Bench Press - Barbell", "Pull Up", "Overhead Press - Barbell"],
    });
  });

  it("finds the outlook's recommendation-widget path but keeps it out of the cards", () => {
    const turn = load("coach/outlook_turn.json");
    expect(recommendationPath(turn)).toMatch(/^\/ai-conversation-bff\/v1\/recommendation-widget\?cycleId=\d+&turnId=/);
    expect(turnCards(turn)).toEqual([]);
    expect(assistantText(turn)).toContain("## Steady start");
  });

  it("returns null text for an empty coach-chat greeting turn", () => {
    expect(assistantText({ turn_status: "COMPLETE", messages: [{ role: "assistant", items: [] }] })).toBeNull();
  });
});

describe("coach list, transcript and recommendations", () => {
  it("flattens the day groups into rows with agents mapped from source_id", () => {
    const { conversations, next_cursor } = projectConversationList(load("coach/conversations.json"));
    expect(next_cursor).toBe("eyIkIjoib0AxIiwibyI6NX0=");
    expect(conversations).toHaveLength(5);
    expect(conversations[0]).toEqual({ fingerprint: "totem-HOME-2026-11-21", source_id: "coach-chat", agent: "coach", title: "Can you chart my strain this week?", day: "TODAY" });
    expect(conversations[1]!.agent).toBeNull(); // journal-agent has no totem agent
    expect(conversations[2]!.agent).toBe("day_in_review");
    expect(conversations[4]).toMatchObject({ agent: "sleep", day: "YESTERDAY" });
  });

  it("maps source ids both ways", () => {
    expect(agentForSource("coach-everywhere-stress-monitor-page")).toBe("stress");
    expect(agentForSource("journal-agent")).toBeNull();
  });

  it("projects recommendation tiles as {title, status, body}", () => {
    const recs = projectRecommendations(load("coach/recommendation_widget.json"));
    expect(recs).toEqual([
      { title: "STRENGTH TRAINER", status: "COMPLETED", body: "Your Saturday strength sessions are a regular habit; focus on explosive leg work to build power." },
      { title: "WALKING", status: "UNCOMMITTED", body: "An easy indoor walk keeps your Saturday movement going." },
      { title: "YOGA", status: "UNCOMMITTED", body: "Your strength-training goal is building power; gentle yoga adds a different way to move today." },
    ]);
  });

  it("builds a compact transcript, dropping coach-chat's empty turn 0 and keeping the newest turns", () => {
    const conversation = {
      metadata: { title: "NEW CHAT 18:37:06" },
      turns: [
        { id: "t0", turn_status: "COMPLETE", messages: [{ role: "assistant", items: [] }] },
        load("coach/turn_chart.json"),
        load("coach/turn_logged_walk.json"),
      ],
    };
    const all = projectTranscript(conversation, 10);
    expect(all.total).toBe(2);
    expect(all.turns[1]).toMatchObject({ user: "Yes, log the walk", actions: ["Logged Walk"], status: null, images: null });
    const newest = projectTranscript(conversation, 1);
    expect(newest.turns).toHaveLength(1);
    expect(newest.turns[0]!.user).toBe("Yes, log the walk");
  });

  it("reads the cycle id from home metadata", () => {
    expect(homeCycleId({ metadata: { cycle_metadata: { cycle_id: 1974268448 } } })).toBe(1974268448);
    expect(homeCycleId({ metadata: {} })).toBeNull();
  });

  it("a receipt built from these pieces passes the output schema", () => {
    const turn = load("coach/turn_chart.json");
    expect(() => CoachAskReceipt.parse({
      thread: "totem-HOME-2026-11-21", text: assistantText(turn), actions: turnActions(turn), cards: turnCards(turn),
      suggestions: [], report: null, image_deleted: null, verified: true, warnings: [],
    })).not.toThrow();
  });
});
