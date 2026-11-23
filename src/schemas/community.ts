import { z } from "zod";

// whoop_community (D9: full exposure). Replaces whoop_communities and
// whoop_leaderboard, and adds the WHOOP Humans read views. Shapes come from the
// 2026-11 app captures (community-service, followers-service); none of these
// reads were probed live. Rows are positional arrays with `columns` stated once.

const Cell = z.union([z.string(), z.number(), z.null()]);
const Row = z.array(Cell);

export const CommunityMembership = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.string().nullable(),
  members: z.number().int().nullable(),
  private: z.boolean().nullable(),
  your_rank: z.object({ rank: z.number().int().nullable(), score: z.number().nullable() }).nullable(),
});
export type CommunityMembershipT = z.infer<typeof CommunityMembership>;

export const SnapshotPillar = z.object({
  pillar: z.string(),
  score: z.number().nullable(),
  unit: z.string().nullable(),
  snapshot_id: z.string().nullable(),
  /** [title, value, usual, trend] display values. */
  contributors: z.array(Row),
});
export type SnapshotPillarT = z.infer<typeof SnapshotPillar>;

export const CommunityOut = z.discriminatedUnion("view", [
  z.object({
    view: z.literal("communities"),
    total: z.number().int(),
    communities: z.array(CommunityMembership),
  }),
  z.object({
    view: z.literal("leaderboard"),
    community_id: z.number().int(),
    community: z.string().nullable(),
    metric: z.enum(["recovery", "sleep", "strain"]),
    window: z.enum(["day", "week", "month"]),
    start: z.string(),
    end: z.string(),
    unit: z.string(),
    columns: z.array(z.string()),
    rows: z.array(Row),
    you: Row.nullable(),
    members: z.number().int().nullable(),
    average: z.number().nullable(),
    next_offset: z.number().int().nullable(),
  }),
  z.object({
    view: z.literal("following"),
    period: z.string().nullable(),
    columns: z.array(z.string()),
    rows: z.array(Row),
    you: Row.nullable(),
  }),
  z.object({
    view: z.literal("snapshot"),
    user_id: z.number().int(),
    shared: z.boolean(),
    name: z.string().nullable(),
    date: z.string().nullable(),
    pillars: z.array(SnapshotPillar),
    note: z.string().nullable(),
  }),
  z.object({
    view: z.literal("comments"),
    snapshot_id: z.string(),
    columns: z.array(z.string()),
    comments: z.array(Row),
    quick_reactions: z.array(z.string()),
  }),
]);
export type CommunityOutT = z.infer<typeof CommunityOut>;
