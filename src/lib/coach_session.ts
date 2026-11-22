// I/O for the AI coach: open/reopen a conversation by fingerprint, post a turn,
// poll it to COMPLETE, look fingerprints up in the history list, resolve the
// cycle for Daily Outlook / Day in Review, and attach an image. specs/ai.md.
//
// Rules (SPEC.md §7 S23): address turns by fingerprint only; never send /seen,
// /end-seen or /last-viewed-turn; reopen only listed fingerprints (reopening an
// unlisted one creates it, and for outlooks generates the report); never cache
// or accept a cycle id.
import { randomInt, randomUUID } from "node:crypto";
import type { WhoopClient } from "../whoop/client.js";
import { WhoopApiError, WhoopServerError } from "../whoop/errors.js";
import { get, str } from "../whoop/bff.js";
import {
  AGENT_SOURCES,
  REPORT_PREFIX,
  assistantText,
  homeCycleId,
  projectConversationList,
  projectRecommendations,
  recommendationPath,
  turnActions,
  turnCards,
  turnStatus,
} from "../projections/coach.js";
import type { CoachAgent, CoachAskReceiptT, CoachConversationT, CoachRecommendationT } from "../schemas/coach.js";

export const AI = "/ai-conversation-bff/v1";

const conversationPath = (fp: string) => `${AI}/conversation/${encodeURIComponent(fp)}`;

export interface CoachTiming {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Delay before each poll. The spec's cadence is every 3–4 s. */
  pollDelayMs: () => number;
  /** How long to wait for the reply to reach COMPLETE (spec: ≥45 s; replies take 3–20 s). */
  replyTimeoutMs: number;
  /** How long to wait for an agent's turn-0 greeting or a previous turn to finish before posting. */
  settleTimeoutMs: number;
}

export const DEFAULT_TIMING: CoachTiming = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollDelayMs: () => randomInt(3_000, 4_001),
  replyTimeoutMs: 60_000,
  settleTimeoutMs: 30_000,
};

type Turn = Record<string, unknown>;

/**
 * WHOOP's terminal failure: the turn comes back `turn_status:"FAILED"` with no
 * messages and never changes again (seen live 2026-11-21 on an activity-agent
 * greeting and on the user turn posted after it).
 */
export const FAILED = "FAILED";

/** A 5xx, a network failure or a request timeout: worth another poll. */
function isTransient(e: unknown): boolean {
  if (e instanceof WhoopServerError) return true;
  if (!(e instanceof Error)) return false;
  return e.name === "AbortError" || e.name === "TimeoutError" || (e instanceof TypeError && /fetch failed|network/i.test(e.message));
}

/** Poll GET …/conversation/{fingerprint}/turn/{id} until COMPLETE, FAILED or the deadline. */
export async function waitForTurn(
  client: WhoopClient,
  fingerprint: string,
  turnId: string,
  timeoutMs: number,
  timing: CoachTiming,
): Promise<{ turn: Turn | null; status: string; timedOut: boolean; polls: number }> {
  const deadline = timing.now() + timeoutMs;
  let turn: Turn | null = null;
  let status = "ACTIVE";
  let polls = 0;
  // No "text stable for N polls" shortcut: text can sit unchanged for several
  // polls while tools run (ai §2.3). COMPLETE is the only done signal; FAILED
  // is the only other state that ends the wait.
  while (timing.now() < deadline) {
    await timing.sleep(Math.min(timing.pollDelayMs(), Math.max(0, deadline - timing.now())));
    polls++;
    try {
      turn = await client.get<Turn>(`${conversationPath(fingerprint)}/turn/${encodeURIComponent(turnId)}`, {}, { fresh: true });
    } catch (e) {
      // One failed poll says nothing about the turn, which keeps running on WHOOP's side.
      if (!isTransient(e)) throw e;
      continue;
    }
    status = turnStatus(turn) ?? status;
    if (status === "COMPLETE" || status === FAILED) return { turn, status, timedOut: false, polls };
  }
  return { turn, status, timedOut: true, polls };
}

export type OpenBody = {
  fingerprint: string;
  source_type: "CHAT_WITH_AGENT" | "UNKNOWN";
  source_id?: string;
  args?: Record<string, unknown>;
  chat_entrypoint_experience?: "STANDARD";
};

/** POST …/conversation: creates the fingerprint, or reopens it (no side effects when it exists). */
export async function openConversation(client: WhoopClient, body: OpenBody): Promise<Turn> {
  const res = await client.post<Turn>(`${AI}/conversation`, body);
  return res && typeof res === "object" ? res : {};
}

function lastTurn(conversation: Turn): Turn | null {
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const last = turns[turns.length - 1];
  return last && typeof last === "object" ? (last as Turn) : null;
}

/**
 * Wait for the conversation's last turn when it is still ACTIVE: an agent's
 * turn-0 greeting (posting before it completes gets the greeting back as the
 * "reply", ai §2.2) or a previous user turn (a new post would 409). coach-chat's
 * empty turn 0 counts too: posting while it is ACTIVE got a 409 live
 * (coach-build smoke test, 2026-11-21).
 */
async function settle(client: WhoopClient, fingerprint: string, conversation: Turn, timing: CoachTiming): Promise<void> {
  const last = lastTurn(conversation);
  if (!last || turnStatus(last) !== "ACTIVE" || typeof last.id !== "string") return;
  await waitForTurn(client, fingerprint, last.id, timing.settleTimeoutMs, timing);
}

const isBusy = (e: unknown) => e instanceof WhoopApiError && e.status === 409;

/**
 * POST a user turn. On 409 "Another message is currently being processed",
 * reopen (no side effects), wait for the active turn to COMPLETE, and retry.
 */
export async function postTurn(
  client: WhoopClient,
  fingerprint: string,
  body: { role: "user"; content: string; is_suggestion: false; file_ids?: string[] },
  reopen: OpenBody,
  timing: CoachTiming,
  maxAttempts = 3,
): Promise<{ id: string; retries: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const turn = await client.post<Turn>(`${conversationPath(fingerprint)}/turn`, body);
      const id = str(get(turn, "id"));
      if (!id) throw new Error("WHOOP accepted the message but returned no turn id; read the thread with whoop_coach_history.");
      return { id, retries: attempt - 1 };
    } catch (e) {
      if (!isBusy(e) || attempt >= maxAttempts) {
        if (isBusy(e)) {
          throw new Error(`Another message is still being processed in thread ${fingerprint}; try again in a minute.`);
        }
        throw e;
      }
      const conversation = await openConversation(client, reopen);
      const last = lastTurn(conversation);
      if (last && turnStatus(last) === "ACTIVE" && typeof last.id === "string") {
        await waitForTurn(client, fingerprint, last.id, timing.settleTimeoutMs, timing);
      } else {
        await timing.sleep(timing.pollDelayMs());
      }
    }
  }
}

/** One page of the history list. */
export async function listConversations(
  client: WhoopClient,
  limit: number,
  cursor?: string,
): Promise<{ conversations: CoachConversationT[]; next_cursor: string | null }> {
  const raw = await client.get(`${AI}/conversations`, { limit, next_token: cursor }, { fresh: true });
  return projectConversationList(raw);
}

/** Look a fingerprint up in a fresh history list (newest first, a few pages). */
export async function findListed(
  client: WhoopClient,
  match: (c: CoachConversationT) => boolean,
  maxPages = 5,
  pageSize = 50,
): Promise<CoachConversationT | null> {
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { conversations, next_cursor } = await listConversations(client, pageSize, cursor);
    const hit = conversations.find(match);
    if (hit) return hit;
    if (!next_cursor) return null;
    cursor = next_cursor;
  }
  return null;
}

/** The cycle id from home, read right before use (never cached: it changes under edits). */
export async function resolveCycleId(client: WhoopClient, date?: string): Promise<number> {
  const home = await client.get("/home-service/v1/home", date ? { date } : {}, { fresh: true });
  const id = homeCycleId(home);
  if (id === null) throw new Error(`WHOOP's home screen${date ? ` for ${date}` : ""} has no cycle yet, so there is no report to open.`);
  return id;
}

export async function fetchRecommendations(client: WhoopClient, path: string | null): Promise<CoachRecommendationT[] | null> {
  if (!path) return null;
  try {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, "https://x");
    if (!url.pathname.startsWith(`${AI}/recommendation-widget`)) return null;
    const query = Object.fromEntries(url.searchParams.entries());
    const raw = await client.get(url.pathname, query, { fresh: true });
    return projectRecommendations(raw);
  } catch {
    return null;
  }
}

export async function fetchSuggestions(client: WhoopClient, fingerprint: string): Promise<string[]> {
  try {
    const raw = await client.get(`${conversationPath(fingerprint)}/suggestions`, {}, { fresh: true });
    const list = get(raw, "suggestions");
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

// ─── Images ───────────────────────────────────────────────────────────────

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Decode and sniff a base64 image (optionally a data: URL). PNG and JPEG only. */
export function parseImage(input: string): { base64: string; contentType: "image/png" | "image/jpeg"; bytes: number } {
  const base64 = input.replace(/^data:image\/[a-z+]+;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("image_base64 isn't valid base64.");
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0) throw new Error("image_base64 decodes to nothing.");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`The image is ${buf.length} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
  const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpeg) throw new Error("Only PNG or JPEG images can be attached.");
  return { base64, contentType: png ? "image/png" : "image/jpeg", bytes: buf.length };
}

// ─── Fingerprints ─────────────────────────────────────────────────────────

/** D7: one totem thread per agent per member-local day, e.g. `totem-HOME-2026-11-21`. */
export function dailyFingerprint(agent: CoachAgent, localDate: string, activityId?: string): string {
  const tag = AGENT_SOURCES[agent]?.tag ?? agent.toUpperCase();
  return activityId ? `totem-${tag}-${localDate}-${activityId}` : `totem-${tag}-${localDate}`;
}

export function freshFingerprint(agent: CoachAgent, localDate: string): string {
  return `${dailyFingerprint(agent, localDate)}-${randomUUID().slice(0, 8)}`;
}

export function reportFingerprint(kind: "daily_outlook" | "day_in_review", cycleId: number): string {
  return `${REPORT_PREFIX[kind]}${cycleId}`;
}


// ─── Ask ──────────────────────────────────────────────────────────────────

export interface AskPlan {
  agent: CoachAgent;
  message?: string;
  activityId?: string;
  thread?: string;
  newThread: boolean;
  image?: ReturnType<typeof parseImage>;
  localDate: string;
}

function emptyReceipt(thread: string): CoachAskReceiptT {
  return {
    thread, text: null, actions: [], cards: [], suggestions: [], report: null, image_deleted: null,
    verified: false, warnings: [],
  };
}

function describeTurn(receipt: CoachAskReceiptT, turn: Turn | null): void {
  receipt.text = turn ? assistantText(turn) : null;
  receipt.actions = turn ? turnActions(turn) : [];
  receipt.cards = turn ? turnCards(turn) : [];
  if (receipt.actions.length) {
    receipt.warnings.push("The coach changed your data (see actions). It returns no ids; check whoop_day or whoop_workouts.");
  }
  for (const card of receipt.cards) {
    if (card.type === "workout_draft") {
      receipt.warnings.push(
        `The coach created a hidden draft template${card.draft_template_key ? ` (${card.draft_template_key})` : ""}; it's not in your library until saved (whoop_lift_template).`,
      );
    }
  }
}

/** Local marker (never a WHOOP status): the turn was posted but could not be polled. */
const UNREAD = "UNREAD";

const notDone = (s: number, what: string, view: string) =>
  `The ${what} wasn't COMPLETE after ${s} s; read it later with whoop_coach_history ${view}.`;

/** Generate or open the current cycle's Daily Outlook / Day in Review. */
async function openReport(
  client: WhoopClient,
  kind: "daily_outlook" | "day_in_review",
  timing: CoachTiming,
): Promise<CoachAskReceiptT> {
  const cycleId = await resolveCycleId(client);
  const fingerprint = reportFingerprint(kind, cycleId);
  const existed = (await findListed(client, (c) => c.fingerprint === fingerprint, 1)) !== null;
  const receipt = emptyReceipt(fingerprint);
  const conversation = await openConversation(client, { fingerprint, source_id: AGENT_SOURCES[kind]!.source_id, source_type: "UNKNOWN" });
  // The report is turn 0. Later turns are the member's follow-up chat about it.
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  let turn: Turn | null = turns[0] && typeof turns[0] === "object" ? (turns[0] as Turn) : null;
  if (turn && turnStatus(turn) !== "COMPLETE" && turnStatus(turn) !== FAILED && typeof turn.id === "string") {
    turn = (await waitForTurn(client, fingerprint, turn.id, timing.replyTimeoutMs, timing)).turn ?? turn;
  }
  describeTurn(receipt, turn);
  receipt.verified = turnStatus(turn) === "COMPLETE";
  const recommendations = receipt.verified ? await fetchRecommendations(client, recommendationPath(turn)) : null;
  receipt.report = { kind, generated: !existed, recommendations };
  if (turnStatus(turn) === FAILED) receipt.warnings.push("WHOOP failed to generate the report (turn FAILED); nothing more will arrive.");
  else if (!receipt.verified) receipt.warnings.push(notDone(Math.round(timing.replyTimeoutMs / 1000), "report", '{view:"outlook"}'));
  return receipt;
}

/** The whole ask: open the thread, settle, (upload), post, poll, (delete the upload), suggestions. */
export async function askCoach(client: WhoopClient, plan: AskPlan, timing: CoachTiming = DEFAULT_TIMING): Promise<CoachAskReceiptT> {
  if (plan.agent === "daily_outlook" || plan.agent === "day_in_review") return openReport(client, plan.agent, timing);
  if (!plan.message) throw new Error("message is required for this agent.");

  let fingerprint: string;
  let open: OpenBody;
  if (plan.thread) {
    const listed = await findListed(client, (c) => c.fingerprint === plan.thread);
    if (!listed) {
      throw new Error(
        `Thread "${plan.thread}" isn't in your coach history. Only listed threads can be continued (reopening an unlisted fingerprint would create it); omit thread to use today's thread.`,
      );
    }
    fingerprint = listed.fingerprint;
    open = { fingerprint, source_type: "UNKNOWN", ...(listed.source_id ? { source_id: listed.source_id } : {}) };
  } else {
    const def = AGENT_SOURCES[plan.agent]!;
    fingerprint = plan.newThread ? freshFingerprint(plan.agent, plan.localDate) : dailyFingerprint(plan.agent, plan.localDate, plan.activityId);
    const args: Record<string, unknown> = def.context ? { context: def.context } : {};
    if (plan.agent === "activity" && plan.activityId) args.activity_id = plan.activityId;
    open = { fingerprint, source_type: "CHAT_WITH_AGENT", source_id: def.source_id, args, chat_entrypoint_experience: "STANDARD" };
  }

  const receipt = emptyReceipt(fingerprint);
  const conversation = await openConversation(client, open);
  await settle(client, fingerprint, conversation, timing);

  let fileId: string | null = null;
  let status = "ACTIVE";
  try {
    if (plan.image) {
      const uploaded = await client.post<Record<string, unknown>>(`${AI}/files`, {
        origin: "camera_roll",
        content_type: plan.image.contentType,
        filename: `totem-${timing.now()}.${plan.image.contentType === "image/png" ? "png" : "jpg"}`,
        base64_content: plan.image.base64,
      });
      fileId = str(get(uploaded, "file_id"));
      if (!fileId) throw new Error("WHOOP accepted the image but returned no file id; nothing was sent to the coach.");
    }
    const turnBody = {
      role: "user" as const,
      content: plan.message,
      is_suggestion: false as const,
      ...(fileId ? { file_ids: [fileId] } : {}),
    };
    const posted = await postTurn(client, fingerprint, turnBody, open, timing);
    if (posted.retries) receipt.warnings.push("The thread was busy with another message; totem waited for it and resent.");
    try {
      const polled = await waitForTurn(client, fingerprint, posted.id, timing.replyTimeoutMs, timing);
      status = polled.status;
      describeTurn(receipt, polled.turn);
    } catch (e) {
      // The message is already with the coach (and it may be acting on it): an
      // error here must not read as "nothing was sent", or the caller resends.
      status = UNREAD;
      receipt.warnings.push(
        `Your message was sent, but its reply couldn't be read (${e instanceof Error ? e.message : String(e)}). Don't resend it: read the thread with whoop_coach_history {view:"transcript", fingerprint:"${fingerprint}"}.`,
      );
    }
    // The client dropped its cache when the turn was POSTed, but the coach wrote
    // the data afterwards: anything read (by another call) in between is stale.
    if (receipt.actions.length || status === UNREAD) client.invalidateAll();
  } finally {
    if (fileId) {
      receipt.image_deleted = await client.delete(`${AI}/files/${encodeURIComponent(fileId)}`).then(() => true, () => false);
      if (!receipt.image_deleted) receipt.warnings.push(`Couldn't delete the uploaded image ${fileId} from WHOOP.`);
    }
  }

  if (status === "COMPLETE") {
    receipt.suggestions = await fetchSuggestions(client, fingerprint);
    receipt.verified = true;
  } else if (status === FAILED) {
    receipt.warnings.push(
      "WHOOP reports this turn FAILED: the coach produced no reply and none will arrive. Ask again, or use new_thread:true if this thread keeps failing.",
    );
  } else if (status !== UNREAD) {
    receipt.warnings.push(notDone(Math.round(timing.replyTimeoutMs / 1000), "reply", `{view:"transcript", fingerprint:"${fingerprint}"}`));
  }
  return receipt;
}
