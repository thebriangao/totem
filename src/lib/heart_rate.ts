// Reads of WHOOP's continuous heart-rate series (see projections/v2/heart_rate.ts).
// The endpoint is keyed by the numeric user id and answers 403 for anyone
// else's, so the id always comes from this account's own bootstrap.
import type { WhoopClient } from "../whoop/client.js";
import { hrPoints, type HrPoint } from "../projections/v2/heart_rate.js";

/** The only steps WHOOP accepts, in seconds. Anything else is a 400. */
export type HrStep = 6 | 60 | 600;

/** A series is at most about this many readings, so the step follows from the window. */
const MAX_HR_POINTS = 300;
/** The longest window one call reads: 48 hours is 288 readings at the coarsest step. */
export const MAX_HR_WINDOW_MS = 48 * 3_600_000;

/** The finest step that keeps a window within MAX_HR_POINTS: ≤30 min → 6 s, ≤5 h → 60 s, else 600 s. */
export function hrStepFor(windowMs: number): HrStep {
  if (windowMs <= MAX_HR_POINTS * 6_000) return 6;
  if (windowMs <= MAX_HR_POINTS * 60_000) return 60;
  return 600;
}

/** This account's numeric WHOOP user id (bootstrap is cached for ten minutes). */
export async function accountUserId(client: WhoopClient): Promise<number> {
  const boot = await client.get<{ user?: { id?: unknown } }>("/users-service/v2/bootstrap");
  const id = boot?.user?.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error("Couldn't read this account's WHOOP user id.");
  }
  return id;
}

export async function readHeartRate(client: WhoopClient, startMs: number, endMs: number, step: HrStep): Promise<HrPoint[]> {
  const id = await accountUserId(client);
  const raw = await client.get(`/metrics-service/v1/metrics/user/${id}`, {
    name: "heart_rate",
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    step,
    order: "t",
  });
  return hrPoints(raw);
}
