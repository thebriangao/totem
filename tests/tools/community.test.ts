import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhoopClient } from "../../src/whoop/client.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { registerCommunity } from "../../src/tools/v2/community.js";
import { todayIso } from "../../src/lib/dates.js";
import { body, closeAll, connect, errorText, load } from "./helpers_coach.js";

const savedUserId = process.env.WHOOP_USER_ID;
beforeEach(() => { delete process.env.WHOOP_USER_ID; });
afterEach(async () => {
  if (savedUserId === undefined) delete process.env.WHOOP_USER_ID;
  else process.env.WHOOP_USER_ID = savedUserId;
  await closeAll();
});

const CS = "/community-service/v1";
const FS = "/followers-service/v1";
const BOARD = `${CS}/leaderboards/communities/900001`;

/** Routes community GETs; bootstrap gives own user id 200001. */
function whoop(routes: Record<string, unknown | ((query: Record<string, unknown>) => unknown)>) {
  const get = vi.fn(async (path: string, query: Record<string, unknown> = {}) => {
    if (path === "/users-service/v2/bootstrap") return load("bootstrap.json");
    if (!(path in routes)) throw new Error(`unexpected GET ${path}`);
    const r = routes[path];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? (r as (q: Record<string, unknown>) => unknown)(query) : r;
  });
  return { client: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as WhoopClient, get };
}

const notFound = (path: string) => new WhoopApiError(404, path, "No everyday stats available for user 700002", "No everyday stats available for user 700002");

describe("whoop_community", () => {
  it("says it returns other people's names and scores, and is read-only", async () => {
    const client = await connect((s) => registerCommunity(s, whoop({}).client));
    const { tools } = await client.listTools();
    expect(tools[0]!.description).toMatch(/OTHER PEOPLE'S names and scores/);
    expect(tools[0]!.description).toMatch(/never cached/);
    expect(tools[0]!.description!.length).toBeLessThanOrEqual(600);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("communities: the app's memberships query with your user id, read fresh", async () => {
    const w = whoop({ [`${CS}/communities/memberships`]: load("community/memberships.json") });
    const client = await connect((s) => registerCommunity(s, w.client));
    const out = body(await client.callTool({ name: "whoop_community", arguments: {} }));
    expect(w.get).toHaveBeenCalledWith(`${CS}/communities/memberships`, {
      userId: 200001, includeOwnerDetails: true, offset: 0, limit: 50, teamType: "ALL",
      includeUserRank: true, leaderboardType: "recovery", startDate: todayIso(),
    }, { fresh: true });
    expect(out).toMatchObject({ view: "communities", total: 1 });
  });

  it("leaderboard (day): resolves your first community, pages by offset/limit, and fetches your row", async () => {
    const day = "2026-11-21";
    const w = whoop({
      [`${CS}/communities/memberships`]: load("community/memberships.json"),
      [`${BOARD}/${day}/recovery/score`]: load("community/leaderboard_day_recovery.json"),
      [`${BOARD}/${day}/recovery/score/user/200001`]: notFound(`${BOARD}/${day}/recovery/score/user/200001`),
    });
    const client = await connect((s) => registerCommunity(s, w.client));
    const out = body(await client.callTool({ name: "whoop_community", arguments: { view: "leaderboard", date: day } }));
    expect(w.get).toHaveBeenCalledWith(`${BOARD}/${day}/recovery/score`, { offset: 0, limit: 10, teamType: "COMMUNITY" }, { fresh: true });
    expect(w.get).toHaveBeenCalledWith(`${BOARD}/${day}/recovery/score/user/200001`, { teamType: "COMMUNITY" }, { fresh: true });
    expect(out).toMatchObject({ view: "leaderboard", community: "Synthetic Runners", unit: "recovery %", next_offset: 3 });
    expect(out.you ?? null).toBeNull();
    expect((out.rows as unknown[][])[0]).toEqual([1, "Avery Example", 98]);
  });

  it("leaderboard (week): the average path with the app's compliance params and the 7-day window", async () => {
    const end = "2026-11-21";
    const board = load("community/leaderboard_week_strain.json") as { records: unknown[] };
    const scope = { teamType: "COMMUNITY", startDate: "2026-11-15", endDate: end, includeCompliance: true, complianceCutoff: 70 };
    const w = whoop({
      [`${CS}/communities/memberships`]: load("community/memberships.json"),
      [`${BOARD}/average/week/strain/day_strain`]: board,
      [`${BOARD}/average/week/strain/day_strain/user/200001`]: board.records[1],
    });
    const client = await connect((s) => registerCommunity(s, w.client));
    const out = body(await client.callTool({ name: "whoop_community", arguments: { view: "leaderboard", metric: "strain", window: "week", date: end, community_id: 900001, limit: 25, offset: 0 } }));
    expect(w.get).toHaveBeenCalledWith(`${BOARD}/average/week/strain/day_strain`, { offset: 0, limit: 25, ...scope }, { fresh: true });
    expect(w.get).toHaveBeenCalledWith(`${BOARD}/average/week/strain/day_strain/user/200001`, scope, { fresh: true });
    expect(out).toMatchObject({ start: "2026-11-15", end, you: [2, "Test User", 0] });
  });

  it("leaderboard: a clear error with no communities, and future dates refused", async () => {
    const w = whoop({ [`${CS}/communities/memberships`]: { offset: 0, records: [], total_count: 0 } });
    const client = await connect((s) => registerCommunity(s, w.client));
    const none = await client.callTool({ name: "whoop_community", arguments: { view: "leaderboard" } });
    expect(none.isError).toBe(true);
    expect(errorText(none)).toContain("aren't in any WHOOP community");
    const future = await client.callTool({ name: "whoop_community", arguments: { view: "leaderboard", date: "2999-01-01" } });
    expect(future.isError).toBe(true);
  });

  it("following: friends' shared scores, uncached", async () => {
    const w = whoop({ [`${FS}/followers-home/following`]: load("community/following.json") });
    const client = await connect((s) => registerCommunity(s, w.client));
    const out = body(await client.callTool({ name: "whoop_community", arguments: { view: "following" } }));
    expect(w.get).toHaveBeenCalledWith(`${FS}/followers-home/following`, {}, { fresh: true });
    expect(out).toMatchObject({ view: "following", you: [200001, "Test User", 63, 80, 0.5] });
  });

  it("snapshot: a person's daily stats, and shared:false on WHOOP's 404 when they share nothing", async () => {
    const w = whoop({
      [`${FS}/snapshots/daily/700001`]: load("community/snapshot.json"),
      [`${FS}/snapshots/daily/700002`]: notFound(`${FS}/snapshots/daily/700002`),
    });
    const client = await connect((s) => registerCommunity(s, w.client));
    const shared = body(await client.callTool({ name: "whoop_community", arguments: { view: "snapshot", user_id: 700001 } }));
    expect(w.get).toHaveBeenCalledWith(`${FS}/snapshots/daily/700001`, { period: "TODAY", sortBy: "NAME" }, { fresh: true });
    expect(shared).toMatchObject({ shared: true, name: "Avery Example" });
    const none = body(await client.callTool({ name: "whoop_community", arguments: { view: "snapshot", user_id: 700002 } }));
    expect(none).toMatchObject({ view: "snapshot", user_id: 700002, shared: false });
    expect(none.pillars ?? []).toEqual([]);
  });

  it("snapshot defaults to your own user id", async () => {
    const w = whoop({ [`${FS}/snapshots/daily/200001`]: load("community/snapshot.json") });
    const client = await connect((s) => registerCommunity(s, w.client));
    const out = body(await client.callTool({ name: "whoop_community", arguments: { view: "snapshot" } }));
    expect(out.user_id).toBe(200001);
  });

  it("comments: needs a snapshot_id and reads it fresh", async () => {
    const sid = "33c44c51-1111-4222-9b29-9e4fdfbc870b";
    const w = whoop({ [`${FS}/snapshots/${sid}/comments`]: load("community/comments.json") });
    const client = await connect((s) => registerCommunity(s, w.client));
    const missing = await client.callTool({ name: "whoop_community", arguments: { view: "comments" } });
    expect(missing.isError).toBe(true);
    const out = body(await client.callTool({ name: "whoop_community", arguments: { view: "comments", snapshot_id: sid } }));
    expect(w.get).toHaveBeenCalledWith(`${FS}/snapshots/${sid}/comments`, {}, { fresh: true });
    expect(out).toMatchObject({ view: "comments", quick_reactions: ["👏", "🆗", "❤️"] });
  });

  it("uses WHOOP_USER_ID when set instead of reading bootstrap", async () => {
    process.env.WHOOP_USER_ID = "4242";
    const w = whoop({ [`${FS}/snapshots/daily/4242`]: load("community/snapshot.json") });
    const client = await connect((s) => registerCommunity(s, w.client));
    await client.callTool({ name: "whoop_community", arguments: { view: "snapshot" } });
    expect(w.get.mock.calls.some((c) => c[0] === "/users-service/v2/bootstrap")).toBe(false);
  });
});
