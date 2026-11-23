// Pure projections over the AI coach BFF (/ai-conversation-bff/v1): turns,
// the history list and recommendation widgets. specs/ai.md §2.3, §2.4, §2.8.
import { byType, get, str, type Node } from "../whoop/bff.js";
import type {
  CoachCardT,
  CoachConversationT,
  CoachRecommendationT,
  CoachTranscriptTurnT,
} from "../schemas/coach.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** agent name ↔ WHOOP agent (source_id) + create args. ai §2.1, §3 recipe 2. */
export const AGENT_SOURCES: Record<string, { source_id: string; context?: string; tag: string }> = {
  coach: { source_id: "coach-chat", tag: "HOME" },
  sleep: { source_id: "sleep-deep-dive-agent", context: "sleep_deepdive", tag: "SLEEP" },
  recovery: { source_id: "recovery-deep-dive-agent", context: "recovery_deepdive", tag: "RECOVERY" },
  strain: { source_id: "strain-deep-dive-agent", context: "strain_deepdive", tag: "STRAIN" },
  stress: { source_id: "coach-everywhere-stress-monitor-page", context: "stress_monitor", tag: "STRESS" },
  activity: { source_id: "coach-everywhere-cardio-activity-details", context: "cardio_activity_details", tag: "ACTIVITY" },
  daily_outlook: { source_id: "daily-outlook", tag: "OUTLOOK" },
  day_in_review: { source_id: "day-in-review", tag: "REVIEW" },
};

/** Fingerprint prefixes of the generated reports; the cycle id follows. ai §2.7. */
export const REPORT_PREFIX = { daily_outlook: "daily-outlook___cycle___", day_in_review: "day-in-review___cycle___" } as const;

export function agentForSource(sourceId: string | null): string | null {
  if (!sourceId) return null;
  for (const [agent, def] of Object.entries(AGENT_SOURCES)) if (def.source_id === sourceId) return agent;
  return null;
}

function messages(turn: unknown, role: "user" | "assistant"): Obj[] {
  return arr(get(turn, "messages")).filter((m): m is Obj => isObj(m) && m.role === role);
}

function items(message: Obj): Obj[] {
  return arr(message.items).filter(isObj);
}

/** One message's MARKDOWN_CHAT_TEXT fragments, concatenated (they carry their own newlines). */
function messageText(message: Obj): string {
  return items(message)
    .filter((it) => it.type === "MARKDOWN_CHAT_TEXT")
    .map((it) => (typeof get(it, "content", "text") === "string" ? (get(it, "content", "text") as string) : ""))
    .join("");
}

/**
 * Every assistant MARKDOWN_CHAT_TEXT in the turn, in order: the preface, the
 * main answer's fragments and any follow-up. Empty placeholder messages are
 * skipped. Only meaningful at COMPLETE (order shifts while streaming).
 */
export function assistantText(turn: unknown): string | null {
  const parts = messages(turn, "assistant").map((m) => messageText(m).trim()).filter((t) => t !== "");
  return parts.length ? parts.join("\n\n") : null;
}

export function userText(turn: unknown): string | null {
  const parts = messages(turn, "user").map((m) => messageText(m).trim()).filter((t) => t !== "");
  return parts.length ? parts.join("\n\n") : null;
}

export function userAttachmentCount(turn: unknown): number {
  let n = 0;
  for (const m of messages(turn, "user")) {
    for (const it of items(m)) {
      if (it.type === "CHAT_ATTACHMENT_CAROUSEL") n += arr(get(it, "content", "attachments")).length;
    }
  }
  return n;
}

/** ICON_MARKDOWN_CALLOUT badges ("Logged Walk"): the coach's receipts for real writes. Its `id` is not the activity id. */
export function turnActions(turn: unknown): string[] {
  const out: string[] = [];
  for (const m of messages(turn, "assistant")) {
    for (const it of items(m)) {
      if (it.type !== "ICON_MARKDOWN_CALLOUT") continue;
      const text = str(get(it, "content", "body_text"));
      if (text) out.push(text);
    }
  }
  return out;
}

function graphBars(content: unknown): NonNullable<CoachCardT["bars"]> {
  const out: NonNullable<CoachCardT["bars"]> = [];
  for (const plot of arr(get(content, "graph", "plots"))) {
    for (const group of arr(get(plot, "plot", "bar_groups"))) {
      const a11y = str(get(group, "accessibility_label"));
      const date = a11y?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? a11y;
      out.push([date ?? null, str(get(group, "top_label", "label"))]);
    }
  }
  return out;
}

/** Non-text assistant items as short rows (charts, deep links, drafts). Widget paths stay internal. */
export function turnCards(turn: unknown): CoachCardT[] {
  const out: CoachCardT[] = [];
  for (const m of messages(turn, "assistant")) {
    for (const it of items(m)) {
      const type = typeof it.type === "string" ? it.type : "UNKNOWN";
      const c = it.content;
      switch (type) {
        case "MARKDOWN_CHAT_TEXT":
        case "ICON_MARKDOWN_CALLOUT":
        case "MINI_ARCH_WIDGET":
          break;
        case "GRAPHING_CARD":
          out.push({ type: "chart", title: str(get(c, "title")), bars: graphBars(c) });
          break;
        case "SECONDARY_BUTTON":
          out.push({ type: "link", title: str(get(c, "text")) });
          break;
        case "AI_WEIGHTLIFTING_SUGGESTION": {
          const key = get(c, "navigation_button", "action", "parameters", "starting_id");
          const exercises: string[] = [];
          for (const group of arr(get(c, "workout_list"))) {
            for (const w of arr(get(group, "workouts"))) {
              const t = str(get(w, "title"));
              if (t) exercises.push(t);
            }
          }
          out.push({
            type: "workout_draft",
            title: str(get(c, "title")),
            draft_template_key: typeof key === "number" ? key : typeof key === "string" && /^\d+$/.test(key) ? Number(key) : null,
            exercises,
          });
          break;
        }
        default:
          out.push({ type: type.toLowerCase(), title: str(get(c, "title")) ?? str(get(c, "text")) });
      }
    }
  }
  return out;
}

/** The recommendation-widget path from a turn's MINI_ARCH_WIDGET, if any. */
export function recommendationPath(turn: unknown): string | null {
  for (const m of messages(turn, "assistant")) {
    for (const it of items(m)) {
      if (it.type !== "MINI_ARCH_WIDGET") continue;
      const p = str(get(it, "content", "path"));
      if (p) return p;
    }
  }
  return null;
}

export function turnStatus(turn: unknown): string | null {
  const s = get(turn, "turn_status");
  return typeof s === "string" ? s.toUpperCase() : null;
}

/** Flatten `{conversations:[{title, conversation_metadata_list:[…]}]}` into rows. */
export function projectConversationList(raw: unknown): { conversations: CoachConversationT[]; next_cursor: string | null } {
  const conversations: CoachConversationT[] = [];
  for (const group of arr(get(raw, "conversations"))) {
    const day = str(get(group, "title"));
    for (const c of arr(get(group, "conversation_metadata_list"))) {
      const fingerprint = str(get(c, "fingerprint"));
      if (!fingerprint) continue;
      const sourceId = str(get(c, "source_id"));
      conversations.push({ fingerprint, source_id: sourceId, agent: agentForSource(sourceId), title: str(get(c, "title")), day });
    }
  }
  return { conversations, next_cursor: str(get(raw, "next_token")) };
}

/** RECOMMENDATION_TILEs from a recommendation-widget response. ai §2.8. */
export function projectRecommendations(raw: unknown): CoachRecommendationT[] {
  return byType(raw, "RECOMMENDATION_TILE").map((tile: Node) => {
    const c = tile.content;
    const body = byType(c, "MARKDOWN_TEXT")
      .map((n) => str(get(n, "content", "text")))
      .filter((t): t is string => t !== null)
      .join("\n");
    return {
      title: str(get(byType(c, "RECOMMENDATION_TILE_HEADER")[0], "content", "title")) ?? str(get(c, "header", "content", "title")),
      status: str(get(c, "status")),
      body: body || null,
    };
  });
}

/** Turns of a reopened conversation as short rows, newest `limit` kept. */
export function projectTranscript(raw: unknown, limit: number): { total: number; turns: CoachTranscriptTurnT[] } {
  const turns = arr(get(raw, "turns"))
    .filter(isObj)
    .map((t) => {
      const status = turnStatus(t);
      const images = userAttachmentCount(t);
      return {
        user: userText(t),
        coach: assistantText(t),
        actions: turnActions(t),
        cards: turnCards(t),
        images: images || null,
        status: status === "COMPLETE" ? null : status,
      };
    })
    // coach-chat's turn 0 is an empty greeting; drop turns with nothing in them.
    .filter((t) => t.user !== null || t.coach !== null || t.cards.length > 0 || t.actions.length > 0);
  return { total: turns.length, turns: turns.slice(-limit) };
}

/** `metadata.cycle_metadata.cycle_id` from a home response, or null. */
export function homeCycleId(home: unknown): number | null {
  const id = get(home, "metadata", "cycle_metadata", "cycle_id");
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}
