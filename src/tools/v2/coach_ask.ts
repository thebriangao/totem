import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CoachAskOut } from "../../schemas/coach.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { randomInt } from "node:crypto";
import { WRITE_ADDITIVE } from "../annotations.js";

const TERMINAL_STATUSES = new Set(["COMPLETE", "COMPLETED", "DONE", "FINISHED"]);

function extractCoachText(msgs: unknown[]): string | null {
  for (const m of msgs) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as Record<string, unknown>;
    if (msg.role && msg.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content;
    if (!Array.isArray(msg.items)) continue;
    for (const item of msg.items) {
      if (typeof item !== "object" || item === null) continue;
      const itemContent = (item as Record<string, unknown>).content;
      if (typeof itemContent !== "object" || itemContent === null) continue;
      const text = (itemContent as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

export async function pollCoachTurn(
  client: WhoopClient,
  conversationId: string,
  turnId: string,
  options: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    nextDelayMs?: () => number;
  } = {},
): Promise<{ responseText: string | null; status: string; polled: number; timedOut: boolean }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nextDelayMs = options.nextDelayMs ?? (() => randomInt(850, 1400));
  const deadline = now() + (options.timeoutMs ?? 30_000);
  let polled = 0;
  let status = "PENDING";
  let responseText: string | null = null;
  let stableFor = 0;

  while (now() < deadline) {
    await sleep(Math.min(nextDelayMs(), Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    const response = await client.get<Record<string, unknown>>(
      `/ai-conversation-bff/v1/conversation/${conversationId}/turn/${turnId}`,
    );
    polled++;
    status = typeof response.turn_status === "string" ? response.turn_status.toUpperCase() : status;
    const latest = extractCoachText(Array.isArray(response.messages) ? response.messages : []);
    if (latest !== null) {
      stableFor = latest === responseText ? stableFor + 1 : 0;
      responseText = latest;
    }
    if (TERMINAL_STATUSES.has(status) || (responseText !== null && stableFor >= 2)) {
      return { responseText, status, polled, timedOut: false };
    }
  }
  return { responseText, status, polled, timedOut: true };
}

export function registerCoachAsk(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_coach_ask",
    "WRITE (creates a coach conversation): ask Whoop Coach a question and poll up to 30s for the reply. context tells the coach which screen you're asking about — one of HOME, RECOVERY, STRAIN, SLEEP, STRESS, CARDIO_DETAILS, WAKE_UP_REPORT (default HOME). Preview unless confirm:true.",
    {
      message: z.string(),
      context: z
        .enum(["HOME", "RECOVERY", "STRAIN", "SLEEP", "STRESS", "CARDIO_DETAILS", "WAKE_UP_REPORT"])
        .default("HOME"),
      confirm: z.boolean().default(false).describe("Set true to actually send. Default returns a preview."),
    },
    WRITE_ADDITIVE,
    async ({ message, context, confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("POST", "/ai-conversation-bff/v1/conversation + /turn", {
                  message: message.slice(0, 100),
                  context,
                }),
              ),
            },
          ],
        };
      }
      // Conversation creation response: { metadata: { id, ... }, turns: [...], tag }
      const conv = await client.post<{
        metadata?: { id?: string };
        conversation_id?: string;
        id?: string;
      }>("/ai-conversation-bff/v1/conversation", {
        context,
        fingerprint: `CHAT_WITH_AGENT${context}_${new Date().toISOString().slice(0, 10)}`,
        source_type: "CHAT_WITH_AGENT",
        chat_entrypoint_experience: "STANDARD",
        tracking_capabilities: {
          is_dismiss_tracking_enabled: false,
          is_seen_tracking_enabled: true,
        },
      });
      const conversationId = conv.metadata?.id ?? conv.conversation_id ?? conv.id ?? "";
      if (!conversationId) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Whoop Coach created a conversation without returning its ID. Retry the request." }) }],
          isError: true,
        };
      }

      // Turn response: { id, turn_status, messages, turn_number, feedback }
      const turn = await client.post<{ id?: string; turn_id?: string }>(
        `/ai-conversation-bff/v1/conversation/${conversationId}/turn`,
        {
          role: "user",
          content: message,
          is_suggestion: false,
          tracking_capabilities: {
            is_dismiss_tracking_enabled: false,
            is_seen_tracking_enabled: true,
          },
        },
      );
      const turnId = turn.id ?? turn.turn_id ?? "";
      if (!turnId) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Whoop Coach created a turn without returning its ID. The conversation exists, but no polling request was sent." }) }],
          isError: true,
        };
      }

      // Response text lives at messages[].items[].content.text (BFF rich-content
      // shape); fall back to messages[].content for older shapes. Only the
      // ASSISTANT's reply counts — the turn echoes the user's message first, so
      // breaking on "any message present" returns before the coach has answered.
      // The assistant reply streams token-by-token, so the FIRST non-empty read
      // is almost always a partial chunk (e.g. just "56"). Breaking on first text
      // returns a truncated answer. Instead keep the latest text each poll and
      // stop only once the turn is terminal (server says it's done) or the text
      // has stopped growing for two polls (the stream has settled). The 30s cap
      // is the backstop.
      const { responseText, status, polled, timedOut } = await pollCoachTurn(client, conversationId, turnId);
      const out = CoachAskOut.parse({
        conversation_id: conversationId,
        turn_id: turnId,
        response_text: responseText,
        turn_status: status,
        polled_iterations: polled,
        timed_out: timedOut,
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
