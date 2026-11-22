import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE, openWorld } from "../annotations.js";
import { preview } from "../../whoop/write_safety.js";
import { todayIso } from "../../lib/dates.js";
import { COACH_AGENTS, CoachAskOut, type CoachAgent } from "../../schemas/coach.js";
import { AGENT_SOURCES, REPORT_PREFIX } from "../../projections/coach.js";
import {
  AI,
  DEFAULT_TIMING,
  askCoach,
  dailyFingerprint,
  parseImage,
  type AskPlan,
  type CoachTiming,
} from "../../lib/coach_session.js";

const TOOL = "whoop_coach_ask";
const REPORTS = new Set<CoachAgent>(["daily_outlook", "day_in_review"]);

export const coachAskInput = {
  message: z.string().trim().min(1).max(4000).optional()
    .describe("What to ask (not used by the report agents)"),
  agent: z.enum(COACH_AGENTS).default("coach").describe("Which coach agent; activity needs activity_id"),
  activity_id: z.uuid().optional().describe("The activity to discuss (agent activity)"),
  thread: z.string().min(1).max(200).optional()
    .describe("Continue a conversation: a fingerprint from whoop_coach_history"),
  new_thread: z.boolean().default(false).describe("Start a fresh thread instead of today's"),
  image_base64: z.string().max(7_200_000).optional().describe("PNG or JPEG to attach, base64, ≤5 MB"),
  confirm: z.boolean().default(false).describe("true sends; default returns a preview"),
};

type Input = z.infer<z.ZodObject<typeof coachAskInput>>;

/** Validate the input and build the plan (pure; throws a readable error). */
export function planAsk(input: Input, localDate: string = todayIso()): AskPlan {
  const report = REPORTS.has(input.agent);
  if (input.thread && input.new_thread) throw new Error("Use either thread (continue) or new_thread (start fresh), not both.");
  if (report) {
    if (input.thread || input.new_thread || input.image_base64 || input.message) {
      throw new Error(
        `agent ${input.agent} only generates or opens the current cycle's report. To reply to it, pass its fingerprint as thread with your message.`,
      );
    }
  } else if (!input.message) {
    throw new Error("message is required.");
  }
  if (input.agent === "activity" && !input.activity_id && !input.thread) throw new Error("agent activity needs activity_id.");
  if (input.activity_id && input.agent !== "activity") throw new Error("activity_id only applies to agent activity.");
  const plan: AskPlan = { agent: input.agent, newThread: input.new_thread, localDate };
  if (input.message) plan.message = input.message;
  if (input.activity_id) plan.activityId = input.activity_id;
  if (input.thread) plan.thread = input.thread;
  if (input.image_base64) plan.image = parseImage(input.image_base64);
  return plan;
}

function previewFor(plan: AskPlan) {
  if (plan.agent === "daily_outlook" || plan.agent === "day_in_review") {
    return preview("POST", `${AI}/conversation`, {
      fingerprint: `${REPORT_PREFIX[plan.agent]}<current cycle, read from home at send>`,
      effect: "Opens the current cycle's report, generating it first if it doesn't exist yet.",
    });
  }
  const thread = plan.thread ?? (plan.newThread ? `${dailyFingerprint(plan.agent, plan.localDate)}-<new>` : dailyFingerprint(plan.agent, plan.localDate, plan.activityId));
  return preview("POST", `${AI}/conversation/${thread}/turn`, {
    thread,
    mode: plan.thread ? "continue listed thread" : plan.newThread ? "new thread" : "today's thread (created if needed)",
    source_id: plan.thread ? null : AGENT_SOURCES[plan.agent]!.source_id,
    image_bytes: plan.image ? plan.image.bytes : null,
    warning: "The coach can create, edit or delete activities, save memories and draft templates if the message asks; its writes come back in actions.",
  });
}

export function registerCoachAsk(server: McpServer, client: WhoopClient, timing: CoachTiming = DEFAULT_TIMING): void {
  defineTool(
    server,
    {
      name: TOOL,
      description:
        "Ask WHOOP Coach (AI) and wait for the full reply (up to ~60 s). One thread per agent per local day; thread continues a fingerprint from whoop_coach_history, new_thread starts fresh. agent daily_outlook / day_in_review generates (or opens) the current cycle's report. The coach really creates, edits and deletes activities, saves memories and builds draft templates when asked (it usually asks for an in-chat yes first); every write it made is listed in actions. Optional image. Preview unless confirm:true.",
      input: coachAskInput,
      annotations: openWorld(WRITE_DESTRUCTIVE),
    },
    async (input) => {
      const plan = planAsk(input);
      if (!input.confirm) return respond(TOOL, CoachAskOut, previewFor(plan));
      return respond(TOOL, CoachAskOut, await askCoach(client, plan, timing));
    },
  );
}
