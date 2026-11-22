// Pure projections for whoop_community: community memberships and leaderboards
// (community-service) and the WHOOP Humans views (followers-service). D9: these
// include other members' names and scores. Shapes from the 2026-11 captures.
import { byType, get, parseNumber, str, type Node } from "../whoop/bff.js";
import type { CommunityMembershipT, CommunityOutT, SnapshotPillarT } from "../schemas/community.js";

type Obj = Record<string, unknown>;
type Cell = string | number | null;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : num(v);
  return n === null ? null : Math.trunc(n);
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const round = (v: number | null, digits: number): number | null => (v === null ? null : Number(v.toFixed(digits)));

function personName(o: unknown): string | null {
  const name = str(get(o, "name"));
  if (name) return name;
  const parts = [str(get(o, "first_name")), str(get(o, "last_name"))].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" ") : null;
}

function projectRank(raw: unknown): CommunityMembershipT["your_rank"] {
  if (typeof raw === "number") return { rank: Math.trunc(raw), score: null };
  if (!isObj(raw)) return null;
  const rank = int(raw.rank ?? raw.position ?? raw.place);
  const score = round(num(raw.score ?? raw.value ?? raw.day_strain ?? raw.performance ?? raw.average), 1);
  return rank === null && score === null ? null : { rank, score };
}

/** GET /community-service/v1/communities/memberships → `{total_count, offset, records[]}`. */
export function projectMemberships(raw: unknown): Extract<CommunityOutT, { view: "communities" }> {
  const communities: CommunityMembershipT[] = arr(get(raw, "records")).flatMap((r) => {
    const id = int(get(r, "id"));
    const name = str(get(r, "name"));
    if (id === null || name === null) return [];
    return [{
      id,
      name,
      type: str(get(r, "team_type")),
      members: int(get(r, "metadata", "member_count") ?? get(r, "member_count")),
      private: bool(get(r, "private")),
      your_rank: projectRank(get(r, "user_rank")),
    }];
  });
  return { view: "communities", total: int(get(raw, "total_count")) ?? communities.length, communities };
}

export type LeaderboardMetric = "recovery" | "sleep" | "strain";

/** The leaderboard's stat path segment, value field and unit per metric. */
export const LEADERBOARD: Record<LeaderboardMetric, { stat: string; field: string; unit: string }> = {
  recovery: { stat: "score", field: "score", unit: "recovery %" },
  sleep: { stat: "performance", field: "performance", unit: "sleep performance %" },
  strain: { stat: "day_strain", field: "day_strain", unit: "day strain (0–21)" },
};

export const LEADERBOARD_COLUMNS = ["rank", "name", "value"];

/** One leaderboard record as [rank, name, value]. */
export function leaderboardRow(r: unknown, metric: LeaderboardMetric): Cell[] | null {
  if (!isObj(r)) return null;
  return [int(r.rank), personName(r), round(num(r[LEADERBOARD[metric].field]), 1)];
}

export function projectLeaderboard(input: {
  board: unknown;
  userRow: unknown | null;
  metric: LeaderboardMetric;
  window: "day" | "week" | "month";
  communityId: number;
  communityName: string | null;
  start: string;
  end: string;
  offset: number;
}): Extract<CommunityOutT, { view: "leaderboard" }> {
  const rows = arr(get(input.board, "records"))
    .map((r) => leaderboardRow(r, input.metric))
    .filter((r): r is Cell[] => r !== null);
  const total = int(get(input.board, "total_count"));
  const seen = input.offset + rows.length;
  return {
    view: "leaderboard",
    community_id: input.communityId,
    community: input.communityName,
    metric: input.metric,
    window: input.window,
    start: input.start,
    end: input.end,
    unit: LEADERBOARD[input.metric].unit,
    columns: LEADERBOARD_COLUMNS,
    rows,
    you: input.userRow ? leaderboardRow(input.userRow, input.metric) : null,
    members: total,
    average: round(num(get(input.board, "average")), 1),
    next_offset: rows.length > 0 && total !== null && seen < total ? seen : null,
  };
}

export const FOLLOWING_COLUMNS = ["user_id", "name", "recovery_pct", "sleep_pct", "strain"];

/** GET /followers-service/v1/followers-home/following → COMMUNITY_FOLLOWER rows (yours is HIGHLIGHTED). */
export function projectFollowing(raw: unknown, ownId: number | null): Extract<CommunityOutT, { view: "following" }> {
  const rows: Cell[][] = [];
  let you: Cell[] | null = null;
  for (const node of byType(raw, "COMMUNITY_FOLLOWER") as Node[]) {
    const c = node.content;
    const userId = int(get(c, "id"));
    const row: Cell[] = [
      userId,
      str(get(c, "title")),
      parseNumber(get(c, "recovery_score")),
      parseNumber(get(c, "sleep_score")),
      parseNumber(get(c, "day_strain")),
    ];
    if ((ownId !== null && userId === ownId) || get(c, "background_style") === "HIGHLIGHTED") you = row;
    else rows.push(row);
  }
  return { view: "following", period: str(get(raw, "data_period")), columns: FOLLOWING_COLUMNS, rows, you };
}

const SNAPSHOT_ID = /snapshots\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/comments/i;

/** GET /followers-service/v1/snapshots/daily/{user_id}: a FLOW with one COMMUNITY_SNAPSHOT_CONTAINER per pillar. */
export function projectSnapshot(raw: unknown, userId: number): Extract<CommunityOutT, { view: "snapshot" }> {
  const pillars: SnapshotPillarT[] = byType(raw, "COMMUNITY_SNAPSHOT_CONTAINER").map((node) => {
    const c = node.content;
    const id = str(get(c, "id")) ?? "";
    const gauge = byType(get(c, "items"), "SCORE_GAUGE")[0];
    const path = byType(get(c, "footer_overlay_items"), "REACTIONS_ARCH_MINI")
      .map((n) => str(get(n, "content", "path")))
      .find((p): p is string => p !== null);
    const contributors = byType(get(c, "items"), "CONTRIBUTORS_TILE").flatMap((tile) =>
      arr(get(tile, "content", "metrics")).map((m): Cell[] => [
        str(get(m, "title")),
        str(get(m, "status")),
        str(get(m, "status_subtitle")),
        str(get(m, "status_type")),
      ]),
    );
    return {
      pillar: id.replace(/^everyday_stats_/, "") || (str(get(gauge, "content", "score_display_title"))?.toLowerCase() ?? "unknown"),
      score: parseNumber(get(gauge, "content", "score_display")),
      unit: str(get(gauge, "content", "score_display_suffix")),
      snapshot_id: path?.match(SNAPSHOT_ID)?.[1] ?? null,
      contributors,
    };
  });
  const flowId = str(get(raw, "content", "flow_id"));
  return {
    view: "snapshot",
    user_id: userId,
    shared: true,
    name: str(get(byType(raw, "SNAPSHOT_HEADER")[0], "content", "title")),
    date: flowId?.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? null,
    pillars,
    note: pillars.length && pillars.every((p) => p.contributors.length === 0)
      ? "Scores only: no contributor details are shared."
      : pillars.length ? "contributors: [title, value, usual, trend]" : null,
  };
}

function firstString(node: unknown, keys: string[]): string | null {
  for (const scope of [node, get(node, "content")]) {
    for (const k of keys) {
      const v = str(get(scope, k));
      if (v) return v;
    }
  }
  return null;
}

/** GET /followers-service/v1/snapshots/{id}/comments. Items were empty in every capture, so read them loosely. */
export function projectComments(raw: unknown, snapshotId: string): Extract<CommunityOutT, { view: "comments" }> {
  const comments = arr(get(raw, "items")).map((it): Cell[] => [
    firstString(it, ["author_name", "user_name", "name", "title"]),
    firstString(it, ["text", "body", "comment", "message", "subtitle"]),
    firstString(it, ["created_at", "timestamp", "time", "time_ago", "date"]),
  ]);
  const quick = arr(get(raw, "quick_reactions"))
    .map((q) => str(get(q, "emoji")))
    .filter((e): e is string => e !== null);
  return { view: "comments", snapshot_id: snapshotId, columns: ["author", "text", "time"], comments, quick_reactions: quick };
}
