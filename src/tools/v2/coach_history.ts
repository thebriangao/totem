import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { CoachHistoryOut, type CoachConversationT, type CoachHistoryOutT } from "../../schemas/coach.js";
import {
  AGENT_SOURCES,
  REPORT_PREFIX,
  assistantText,
  projectTranscript,
  recommendationPath,
  turnStatus,
} from "../../projections/coach.js";
import {
  FAILED,
  fetchRecommendations,
  findListed,
  listConversations,
  openConversation,
  reportFingerprint,
  resolveCycleId,
} from "../../lib/coach_session.js";
import { todayIso } from "../../lib/dates.js";

const TOOL = "whoop_coach_history";

export const coachHistoryInput = {
  view: z.enum(["list", "transcript", "outlook"]).default("list"),
  limit: z.number().int().min(1).max(50).optional().describe("list page size (default 10); transcript: newest turns kept (default 5)"),
  cursor: z.string().min(1).max(500).optional().describe("list: next_cursor from the previous page"),
  fingerprint: z.string().min(1).max(200).optional().describe("transcript: a fingerprint from view list"),
  kind: z.enum(["daily_outlook", "day_in_review"]).default("daily_outlook").describe("outlook: which report"),
  date: z.iso.date().optional().describe("outlook: the day (default today)"),
};

type Input = z.infer<z.ZodObject<typeof coachHistoryInput>>;

async function transcript(client: WhoopClient, input: Input): Promise<CoachHistoryOutT> {
  if (!input.fingerprint) throw new Error("view transcript needs a fingerprint from view list.");
  // Reopening an unlisted fingerprint would create it (and generate an outlook),
  // so only fingerprints present in a fresh list are reopened (S23).
  const listed = await findListed(client, (c) => c.fingerprint === input.fingerprint);
  if (!listed) {
    throw new Error(`"${input.fingerprint}" isn't in your coach history, so totem won't open it (opening an unlisted fingerprint creates it). Use view list to find one.`);
  }
  const conversation = await openConversation(client, {
    fingerprint: listed.fingerprint,
    source_type: "UNKNOWN",
    ...(listed.source_id ? { source_id: listed.source_id } : {}),
  });
  const { total, turns } = projectTranscript(conversation, input.limit ?? 5);
  return {
    view: "transcript",
    fingerprint: listed.fingerprint,
    agent: listed.agent ?? listed.source_id,
    title: listed.title,
    total_turns: total,
    turns,
  };
}

async function outlook(client: WhoopClient, input: Input): Promise<CoachHistoryOutT> {
  if (input.date && input.date > todayIso()) throw new Error(`${input.date} is in the future; reports exist only for past days and today.`);
  const kind = input.kind;
  const warnings: string[] = [];
  // The cycle id is resolved from home right before use and never kept (S19).
  const fingerprint = reportFingerprint(kind, await resolveCycleId(client, input.date));
  // Sleep edits re-cut cycles, so today's report can sit under an older cycle id
  // (ai §4.5): for today, a same-kind report in the TODAY group also counts,
  // but only when the current cycle's own report isn't listed.
  const older: { hit: CoachConversationT | null } = { hit: null };
  const exact = await findListed(client, (c) => {
    if (c.fingerprint === fingerprint) return true;
    if (!older.hit && !input.date && c.fingerprint.startsWith(REPORT_PREFIX[kind]) && c.day?.toUpperCase() === "TODAY") older.hit = c;
    return false;
  });
  const listed = exact ?? older.hit;
  if (listed && listed.fingerprint !== fingerprint) {
    warnings.push("Today's report is listed under an older cycle id (the cycle was re-cut after it was generated).");
  }
  if (!listed) {
    return {
      view: "outlook",
      available: false,
      fingerprint: null,
      status: null,
      text: null,
      recommendations: null,
      note: `Not generated for this cycle. whoop_coach_ask {agent:"${kind}"} generates it (current cycle only).`,
      warnings,
    };
  }
  const conversation = await openConversation(client, {
    fingerprint: listed.fingerprint,
    source_type: "UNKNOWN",
    source_id: listed.source_id ?? AGENT_SOURCES[kind]!.source_id,
  });
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const first = turns[0] ?? null;
  const status = turnStatus(first);
  const done = status === "COMPLETE";
  if (status === FAILED) warnings.push("WHOOP failed to generate this report (turn FAILED); it won't complete.");
  else if (!done) warnings.push("The report is still being generated; try again shortly.");
  return {
    view: "outlook",
    available: true,
    fingerprint: listed.fingerprint,
    status: done ? null : status,
    text: assistantText(first),
    recommendations: done ? await fetchRecommendations(client, recommendationPath(first)) : null,
    note: turns.length > 1 ? `${turns.length - 1} follow-up turn(s); view transcript shows them.` : null,
    warnings,
  };
}

export function registerCoachHistory(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: TOOL,
      description:
        "Read WHOOP Coach history without changing it. list: one row per conversation (fingerprint, AI title, agent, day), newest first, paged by cursor. transcript: a listed thread's turns (user text, coach reply, actions the coach took, cards); only listed fingerprints are opened. outlook: today's (or date's) Daily Outlook or Day in Review with its recommendations, only if it already exists; whoop_coach_ask generates one. Pass a fingerprint as whoop_coach_ask thread to reply.",
      input: coachHistoryInput,
      annotations: READ_ONLY,
    },
    async (input) => {
      if (input.view === "transcript") return respond(TOOL, CoachHistoryOut, await transcript(client, input));
      if (input.view === "outlook") return respond(TOOL, CoachHistoryOut, await outlook(client, input));
      const page = await listConversations(client, input.limit ?? 10, input.cursor);
      return respond(TOOL, CoachHistoryOut, {
        view: "list",
        conversations: page.conversations.map((c) => ({ fingerprint: c.fingerprint, title: c.title, agent: c.agent ?? c.source_id, day: c.day })),
        next_cursor: page.next_cursor,
      });
    },
  );
}
