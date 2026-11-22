import { z } from "zod";
import { withPreview } from "./primitives.js";

// whoop_coach_ask / whoop_coach_history (SPEC.md §3, §4.10; specs/ai.md).
// Compact by design: the joined reply once, short card rows, no raw turn JSON.

export const COACH_AGENTS = [
  "coach", "sleep", "recovery", "strain", "stress", "activity", "daily_outlook", "day_in_review",
] as const;
export type CoachAgent = (typeof COACH_AGENTS)[number];

/** A non-text item of a reply, as a short row. */
export const CoachCard = z.object({
  type: z.string(),
  title: z.string().nullable(),
  /** GRAPHING_CARD bars as [date, label]. */
  bars: z.array(z.tuple([z.string().nullable(), z.string().nullable()])).optional(),
  /** AI_WEIGHTLIFTING_SUGGESTION: the hidden draft template the coach created. */
  draft_template_key: z.number().nullable().optional(),
  exercises: z.array(z.string()).optional(),
});
export type CoachCardT = z.infer<typeof CoachCard>;

export const CoachRecommendation = z.object({
  title: z.string().nullable(),
  status: z.string().nullable(),
  body: z.string().nullable(),
});
export type CoachRecommendationT = z.infer<typeof CoachRecommendation>;

export const CoachAskReceipt = z.object({
  thread: z.string(),
  text: z.string().nullable(),
  /** ICON_MARKDOWN_CALLOUT badges: writes the coach performed ("Logged Walk"). */
  actions: z.array(z.string()),
  cards: z.array(CoachCard),
  suggestions: z.array(z.string()),
  report: z.object({
    kind: z.enum(["daily_outlook", "day_in_review"]),
    generated: z.boolean(),
    recommendations: z.array(CoachRecommendation).nullable(),
  }).nullable(),
  image_deleted: z.boolean().nullable(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
});
export type CoachAskReceiptT = z.infer<typeof CoachAskReceipt>;
export const CoachAskOut = withPreview(CoachAskReceipt);

/** Internal list row (lookups need source_id); the tool output uses CoachListRow. */
export interface CoachConversationT {
  fingerprint: string;
  source_id: string | null;
  agent: string | null;
  title: string | null;
  day: string | null;
}

export const CoachListRow = z.object({
  fingerprint: z.string(),
  title: z.string().nullable(),
  agent: z.string().nullable(),
  day: z.string().nullable(),
});

export const CoachTranscriptTurn = z.object({
  user: z.string().nullable(),
  coach: z.string().nullable(),
  actions: z.array(z.string()),
  cards: z.array(CoachCard),
  images: z.number().int().nullable(),
  status: z.string().nullable(),
});
export type CoachTranscriptTurnT = z.infer<typeof CoachTranscriptTurn>;

export const CoachHistoryOut = z.discriminatedUnion("view", [
  z.object({
    view: z.literal("list"),
    conversations: z.array(CoachListRow),
    next_cursor: z.string().nullable(),
  }),
  z.object({
    view: z.literal("transcript"),
    fingerprint: z.string(),
    agent: z.string().nullable(),
    title: z.string().nullable(),
    total_turns: z.number().int(),
    turns: z.array(CoachTranscriptTurn),
  }),
  z.object({
    view: z.literal("outlook"),
    available: z.boolean(),
    fingerprint: z.string().nullable(),
    status: z.string().nullable(),
    text: z.string().nullable(),
    recommendations: z.array(CoachRecommendation).nullable(),
    note: z.string().nullable(),
    warnings: z.array(z.string()),
  }),
]);
export type CoachHistoryOutT = z.infer<typeof CoachHistoryOut>;
