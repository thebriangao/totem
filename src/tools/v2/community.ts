import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { CommunityOut } from "../../schemas/community.js";
import {
  LEADERBOARD,
  projectComments,
  projectFollowing,
  projectLeaderboard,
  projectMemberships,
  projectSnapshot,
} from "../../projections/community.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { get } from "../../whoop/bff.js";
import { todayIso } from "../../lib/dates.js";

const TOOL = "whoop_community";
const CS = "/community-service/v1";
const FS = "/followers-service/v1";
// D9: other people's data is never cached (the client has no policy for these
// services either); `fresh` also skips sharing an in-flight read.
const LIVE = { fresh: true } as const;

export const communityInput = {
  view: z.enum(["communities", "leaderboard", "following", "snapshot", "comments"]).default("communities"),
  community_id: z.number().int().positive().optional().describe("leaderboard: which community (default your first)"),
  metric: z.enum(["recovery", "sleep", "strain"]).default("recovery").describe("leaderboard metric"),
  window: z.enum(["day", "week", "month"]).default("day").describe("leaderboard: one day, or a 7/30-day average"),
  date: z.iso.date().optional().describe("leaderboard: the day, or the window's last day (default today)"),
  limit: z.number().int().min(1).max(50).default(10).describe("leaderboard rows per page"),
  offset: z.number().int().min(0).default(0).describe("leaderboard: next_offset from the previous page"),
  user_id: z.number().int().positive().optional().describe("snapshot: whose daily stats, from view following (default you)"),
  snapshot_id: z.uuid().optional().describe("comments: a snapshot_id from view snapshot"),
};

type Input = z.infer<z.ZodObject<typeof communityInput>>;

/** The member's own user id: WHOOP_USER_ID, else bootstrap. */
async function ownUserId(client: WhoopClient): Promise<number | null> {
  const env = Number(process.env.WHOOP_USER_ID);
  if (Number.isInteger(env) && env > 0) return env;
  const boot = await client.get("/users-service/v2/bootstrap").catch(() => null);
  const id = get(boot, "user", "id") ?? get(boot, "account", "user_id") ?? get(boot, "profile", "user_id");
  return typeof id === "number" ? id : null;
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function memberships(client: WhoopClient, input: Input, ownId: number | null) {
  return client.get(`${CS}/communities/memberships`, {
    userId: ownId ?? undefined,
    includeOwnerDetails: true,
    offset: 0,
    limit: 50,
    teamType: "ALL",
    includeUserRank: true,
    leaderboardType: input.metric,
    startDate: todayIso(),
  }, LIVE);
}

async function leaderboard(client: WhoopClient, input: Input, ownId: number | null) {
  const end = input.date ?? todayIso();
  if (end > todayIso()) throw new Error(`${end} is in the future.`);
  const mine = projectMemberships(await memberships(client, input, ownId)).communities;
  const community = input.community_id === undefined ? mine[0] : mine.find((c) => c.id === input.community_id);
  const communityId = input.community_id ?? community?.id;
  if (communityId === undefined) throw new Error("You aren't in any WHOOP community, so there's no leaderboard.");
  const start = input.window === "day" ? end : shiftDay(end, input.window === "week" ? -6 : -29);
  const { stat } = LEADERBOARD[input.metric];
  const base = `${CS}/leaderboards/communities/${communityId}/${input.window === "day" ? end : `average/${input.window}`}/${input.metric}/${stat}`;
  const scope: Record<string, string | number | boolean> = { teamType: community?.type ?? "COMMUNITY" };
  if (input.window !== "day") Object.assign(scope, { startDate: start, endDate: end, includeCompliance: true, complianceCutoff: 70 });
  const [board, userRow] = await Promise.all([
    client.get(base, { offset: input.offset, limit: input.limit, ...scope }, LIVE),
    // Your own row; 404 when you have no data in the window.
    ownId === null
      ? Promise.resolve(null)
      : client.get(`${base}/user/${ownId}`, scope, LIVE).catch((e: unknown) => {
        if (e instanceof WhoopApiError && e.status === 404) return null;
        throw e;
      }),
  ]);
  return projectLeaderboard({
    board, userRow, metric: input.metric, window: input.window, communityId,
    communityName: community?.name ?? null, start, end, offset: input.offset,
  });
}

async function snapshot(client: WhoopClient, input: Input, ownId: number | null) {
  const userId = input.user_id ?? ownId;
  if (userId === null) throw new Error("Couldn't resolve your user id; pass user_id.");
  try {
    const raw = await client.get(`${FS}/snapshots/daily/${userId}`, { period: "TODAY", sortBy: "NAME" }, LIVE);
    return projectSnapshot(raw, userId);
  } catch (e) {
    // "No everyday stats available for user N": they share nothing with you.
    if (e instanceof WhoopApiError && e.status === 404) {
      return { view: "snapshot" as const, user_id: userId, shared: false, name: null, date: null, pillars: [], note: "This person shares no daily stats with you." };
    }
    throw e;
  }
}

export function registerCommunity(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: TOOL,
      description:
        "WHOOP community and friends data. Returns OTHER PEOPLE'S names and scores, read live (never cached). communities: your teams and your rank. leaderboard: a community's ranking as [rank, name, value] rows plus your row, for a day or a 7/30-day average, paged by offset. following: people you follow with the recovery, sleep and strain they share (user_id for snapshot). snapshot: one person's (or your) daily scores and contributors. comments: a snapshot's comments. Social writes aren't available here.",
      input: communityInput,
      annotations: READ_ONLY,
    },
    async (input) => {
      if (input.view === "comments") {
        if (!input.snapshot_id) throw new Error("view comments needs a snapshot_id from view snapshot.");
        const raw = await client.get(`${FS}/snapshots/${input.snapshot_id}/comments`, {}, LIVE);
        return respond(TOOL, CommunityOut, projectComments(raw, input.snapshot_id));
      }
      const ownId = await ownUserId(client);
      if (input.view === "leaderboard") return respond(TOOL, CommunityOut, await leaderboard(client, input, ownId));
      if (input.view === "snapshot") return respond(TOOL, CommunityOut, await snapshot(client, input, ownId));
      if (input.view === "following") {
        const raw = await client.get(`${FS}/followers-home/following`, {}, LIVE);
        return respond(TOOL, CommunityOut, projectFollowing(raw, ownId));
      }
      return respond(TOOL, CommunityOut, projectMemberships(await memberships(client, input, ownId)));
    },
  );
}
