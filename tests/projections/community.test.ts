// whoop_community projections on SYNTHETIC fixtures shaped like the 2026-11 captures
// (no real people's names or ids).
import { describe, expect, it } from "vitest";
import {
  projectComments,
  projectFollowing,
  projectLeaderboard,
  projectMemberships,
  projectSnapshot,
} from "../../src/projections/community.js";
import { CommunityOut } from "../../src/schemas/community.js";
import { load } from "../tools/helpers_coach.js";

describe("community projections", () => {
  it("memberships: compact community rows with your rank", () => {
    // user_rank is a bare integer in the captures that have one (2026-05
    // baseline) and null on the throwaway account; no capture shows an object.
    const out = projectMemberships(load("community/memberships.json"));
    expect(out).toEqual({
      view: "communities",
      total: 1,
      communities: [{ id: 900001, name: "Synthetic Runners", type: "COMMUNITY", members: 455, private: true, your_rank: { rank: 518, score: null } }],
    });
    expect(projectMemberships({ offset: 0, records: [], total_count: 0 }).communities).toEqual([]);
    // No rank yet (the throwaway account's shape): the row has none, not a zero.
    const unranked = projectMemberships({ offset: 1, total_count: 1, records: [{ id: 900002, name: "Synthetic Walkers", team_type: "COMMUNITY", private: true, metadata: { member_count: 1 }, user_rank: null }] });
    expect(unranked.communities[0]!.your_rank).toBeNull();
    expect(() => CommunityOut.parse(out)).not.toThrow();
  });

  it("day recovery leaderboard: [rank, name, value] rows, the unit once, your row, next offset", () => {
    const out = projectLeaderboard({
      board: load("community/leaderboard_day_recovery.json"),
      userRow: null,
      metric: "recovery",
      window: "day",
      communityId: 900001,
      communityName: "Synthetic Runners",
      start: "2026-11-21",
      end: "2026-11-21",
      offset: 0,
    });
    expect(out.columns).toEqual(["rank", "name", "value"]);
    expect(out.unit).toBe("recovery %");
    expect(out.rows).toEqual([[1, "Avery Example", 98], [2, "Blake Sample", 95], [3, "Casey Placeholder", 91.3]]);
    expect(out).toMatchObject({ members: 455, average: 58, next_offset: 3, you: null });
    expect(() => CommunityOut.parse(out)).not.toThrow();
  });

  it("week strain leaderboard: averages rounded, last page has no next offset, your row from /user/{id}", () => {
    const board = load("community/leaderboard_week_strain.json") as { records: unknown[] };
    const out = projectLeaderboard({
      board,
      userRow: board.records[1],
      metric: "strain",
      window: "week",
      communityId: 900001,
      communityName: null,
      start: "2026-11-15",
      end: "2026-11-21",
      offset: 0,
    });
    expect(out.rows).toEqual([[1, "Avery Example", 18.7], [2, "Test User", 0]]);
    expect(out.you).toEqual([2, "Test User", 0]);
    expect(out.next_offset).toBeNull();
    expect(out.unit).toBe("day strain (0–21)");
  });

  it("following: friends' shared scores as rows; your own row split out; non-sharers are null", () => {
    const out = projectFollowing(load("community/following.json"), 200001);
    expect(out.period).toBe("Today");
    expect(out.columns).toEqual(["user_id", "name", "recovery_pct", "sleep_pct", "strain"]);
    expect(out.you).toEqual([200001, "Test User", 63, 80, 0.5]);
    expect(out.rows).toEqual([[700001, "Avery Example", 38, 68, 5], [700002, "Blake Sample", null, null, null]]);
    // Without a known own id, the HIGHLIGHTED row is still recognised.
    expect(projectFollowing(load("community/following.json"), null).you).toEqual([200001, "Test User", 63, 80, 0.5]);
  });

  it("snapshot: per-pillar score, comment snapshot id and contributor rows", () => {
    const out = projectSnapshot(load("community/snapshot.json"), 700001);
    expect(out).toMatchObject({ view: "snapshot", user_id: 700001, shared: true, name: "Avery Example", date: "2026-11-21" });
    expect(out.pillars).toEqual([
      {
        pillar: "recovery", score: 63, unit: "%", snapshot_id: "33c44c51-1111-4222-9b29-9e4fdfbc870b",
        contributors: [["HEART RATE VARIABILITY", "42", "43", "LOWER_NEGATIVE"], ["RESTING HEART RATE", "66", "66", "EQUAL"]],
      },
      { pillar: "sleep", score: 80, unit: "%", snapshot_id: "44d55d62-2222-4333-8c3a-0f5e0e0e0e0e", contributors: [["HOURS VS. NEEDED", "99%", null, null]] },
      { pillar: "strain", score: 1, unit: null, snapshot_id: "55e66e73-3333-4444-9d4b-1a6f1f1f1f1f", contributors: [] },
    ]);
    expect(() => CommunityOut.parse(out)).not.toThrow();
  });

  it("comments: empty in every capture; quick reactions listed; items read loosely", () => {
    const out = projectComments(load("community/comments.json"), "33c44c51-1111-4222-9b29-9e4fdfbc870b");
    expect(out).toEqual({ view: "comments", snapshot_id: "33c44c51-1111-4222-9b29-9e4fdfbc870b", columns: ["author", "text", "time"], comments: [], quick_reactions: ["👏", "🆗", "❤️"] });
    // Guessed item shape (none captured): a BFF node with author and text in content.
    const guessed = projectComments({ items: [{ type: "COMMENT", content: { title: "Avery Example", text: "Nice sleep!", created_at: "2026-11-21T15:00:00.000Z" } }] }, "x");
    expect(guessed.comments).toEqual([["Avery Example", "Nice sleep!", "2026-11-21T15:00:00.000Z"]]);
  });
});
