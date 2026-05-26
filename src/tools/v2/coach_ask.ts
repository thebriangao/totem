import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CoachAskOut } from "../../schemas/coach.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerCoachAsk(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_coach_ask",
    "WRITE (sends a message): ask Whoop Coach. Polls up to 30s. Preview unless confirm:true.",
    {
      message: z.string(),
      context: z
        .enum(["HOME", "RECOVERY", "STRAIN", "SLEEP", "STRESS", "CARDIO_DETAILS", "WAKE_UP_REPORT"])
        .default("HOME"),
      confirm: z.boolean().default(false).describe("Set true to actually send. Default returns a preview."),
    },
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

      let polled = 0;
      let lastResult: Record<string, unknown> = {};
      let status = "PENDING";
      for (; polled < 30; polled++) {
        await new Promise((r) => setTimeout(r, 1000));
        const r = await client.get<Record<string, unknown>>(
          `/ai-conversation-bff/v1/conversation/${conversationId}/turn/${turnId}`,
        );
        lastResult = r;
        status = typeof r.turn_status === "string" ? r.turn_status.toUpperCase() : status;
        if (["COMPLETE", "COMPLETED", "DONE"].includes(status)) break;
        if (Array.isArray(r.messages) && r.messages.length > 0) break;
      }

      // Response text lives at messages[].items[].content.text (BFF rich-content shape).
      // Fall back to messages[].content for older shapes.
      function extractText(msgs: unknown[]): string | null {
        for (const m of msgs) {
          if (typeof m !== "object" || m === null) continue;
          const msg = m as Record<string, unknown>;
          if (msg.role && msg.role !== "assistant") continue;
          if (typeof msg.content === "string") return msg.content;
          if (Array.isArray(msg.items)) {
            for (const item of msg.items) {
              if (typeof item !== "object" || item === null) continue;
              const it = item as Record<string, unknown>;
              const itemContent = it.content;
              if (typeof itemContent === "object" && itemContent !== null) {
                const t = (itemContent as Record<string, unknown>).text;
                if (typeof t === "string") return t;
              }
            }
          }
        }
        return null;
      }
      const msgs = Array.isArray(lastResult.messages) ? lastResult.messages : [];
      const responseText = extractText(msgs);
      const out = CoachAskOut.parse({
        conversation_id: conversationId,
        turn_id: turnId,
        response_text: responseText,
        turn_status: status,
        polled_iterations: polled,
        timed_out: polled === 30,
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
