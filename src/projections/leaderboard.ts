import type { LeaderboardOutT } from "../schemas/leaderboard.js";
import { isObject, asArray, asNumber, asString } from "../lib/walk.js";

interface ProjectLeaderboardInput {
  community_id: number;
  community_name: string | null;
  window: "day" | "week" | "month";
  metric: "recovery" | "sleep" | "strain";
  date: string;
  board: unknown;
  user_row: unknown | null;
}

export function projectLeaderboard(input: ProjectLeaderboardInput): LeaderboardOutT {
  const board = isObject(input.board) ? input.board as Record<string, unknown> : {};
  const records = asArray(board.records)
    .map((r) => {
      if (!isObject(r)) return null;
      const score = asNumber(r.score ?? r.day_strain ?? r.duration);
      return {
        rank: asNumber(r.rank) ?? 0,
        user_id: asNumber(r.user_id) ?? 0,
        first_name: asString(r.first_name) ?? "",
        last_name: asString(r.last_name) ?? "",
        value: score,
        secondary_value: asNumber(r.hrv ?? r.performance ?? r.calories),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const userRow = input.user_row && isObject(input.user_row) ? input.user_row as Record<string, unknown> : null;

  return {
    community_id: input.community_id,
    community_name: input.community_name,
    window: input.window,
    metric: input.metric,
    date_label: input.date,
    average: asNumber(board.average),
    total_compliant: asNumber(board.total_compliant),
    total_empty: asNumber(board.total_empty),
    records,
    your_position: {
      rank: userRow ? asNumber(userRow.rank) : null,
      value: userRow ? asNumber(userRow.score ?? userRow.day_strain ?? userRow.duration) : null,
      in_window: userRow !== null,
    },
  };
}
