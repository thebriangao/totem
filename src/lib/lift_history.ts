// Reading GET /weightlifting-service/v3/exercise/{id}/exercise_history across pages.
// Live (2026-11-21): a page holds 5 workout cards, newest workout first, and
// `show_more.next_start_date` is an exclusive upper-bound timestamp for the next
// page. A newly logged or linked workout can take ~30 s to appear.
import type { WhoopClient } from "../whoop/client.js";
import { parseLiftCards, type LiftCard } from "../projections/lift_cards.js";

export const historyPath = (exerciseId: string) => `/weightlifting-service/v3/exercise/${encodeURIComponent(exerciseId)}/exercise_history`;

/** Read-back pacing; tests set this to zeros. */
export const liftReadback = { delaysMs: [0, 4_000, 8_000] as number[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Page through an exercise's history, newest first, until `notBefore` (ISO) is
 * passed, `maxPages` is reached, or `visit` returns true. Errors end the walk.
 */
export async function walkHistory(
  client: WhoopClient,
  exerciseId: string,
  opts: { notBefore?: string | undefined; maxPages: number; fresh?: boolean },
  visit: (cards: LiftCard[]) => boolean | void,
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < opts.maxPages; page++) {
    let raw: unknown;
    try {
      raw = await client.get(historyPath(exerciseId), cursor ? { startDate: cursor } : {}, opts.fresh ? { fresh: true } : {});
    } catch {
      return;
    }
    const { cards, next_cursor } = parseLiftCards(raw);
    if (visit(cards) === true) return;
    if (!next_cursor || (opts.notBefore && next_cursor < opts.notBefore)) return;
    cursor = next_cursor;
  }
}

/**
 * The history card for one activity, read fresh, retried while WHOOP catches up.
 * `notBefore` (the workout's start) bounds the paging.
 */
export async function findHistoryCard(client: WhoopClient, exerciseId: string, activityId: string, notBefore: string | undefined): Promise<LiftCard | null> {
  for (const delay of liftReadback.delaysMs) {
    if (delay > 0) await sleep(delay);
    let found: LiftCard | null = null;
    await walkHistory(client, exerciseId, { notBefore, maxPages: 6, fresh: true }, (cards) => {
      found = cards.find((c) => c.activity_id === activityId) ?? null;
      return found !== null;
    });
    if (found) return found;
  }
  return null;
}
