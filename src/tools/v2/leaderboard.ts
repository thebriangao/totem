import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LeaderboardOut } from "../../schemas/leaderboard.js";
import { projectLeaderboard } from "../../projections/leaderboard.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerLeaderboard(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_leaderboard",
    "Community leaderboard ranking + your position. Auto-discovers your first community if community_id omitted.",
    {
      community_id: z.number().int().optional(),
      date: z.iso.date().optional(),
      window: z.enum(["day", "week", "month"]).default("day"),
      metric: z.enum(["recovery", "sleep", "strain"]).default("recovery"),
    },
    async ({ community_id, date, window, metric }) => {
      let cId = community_id;
      let cName: string | null = null;
      if (cId === undefined) {
        const memberships = await client.get<{ records?: { id: number; name?: string }[] }>(
          "/community-service/v1/communities/memberships",
        );
        const first = memberships.records?.[0];
        if (!first) {
          return {
            content: [{ type: "text", text: jsonOut({ error: "no community memberships found" }) }],
            isError: true,
          };
        }
        cId = first.id;
        cName = first.name ?? null;
      }
      const d = date ?? todayIso();
      const stat = metric === "recovery" ? "score" : metric === "sleep" ? "performance" : "day_strain";
      const windowSeg = window === "day" ? d : `average/${window}`;
      const userId = process.env.WHOOP_USER_ID;
      // week/month leaderboards require startDate, endDate, and teamType params.
      // Compute the window's date range.
      function windowRange(): { startDate: string; endDate: string } {
        const end = new Date(d + "T00:00:00Z");
        const start = new Date(end);
        if (window === "week") start.setUTCDate(end.getUTCDate() - 6);
        else if (window === "month") start.setUTCDate(end.getUTCDate() - 29);
        return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
      }
      const params: Record<string, string> = { teamType: "COMMUNITY" };
      if (window !== "day") {
        const { startDate, endDate } = windowRange();
        params.startDate = startDate;
        params.endDate = endDate;
        params.includeCompliance = "true";
        params.complianceCutoff = "70";
      }

      const [board, userRow] = await Promise.all([
        client.get(
          `/community-service/v1/leaderboards/communities/${cId}/${windowSeg}/${metric}/${stat}`,
          params,
        ),
        userId
          ? client
              .get(
                `/community-service/v1/leaderboards/communities/${cId}/${windowSeg}/${metric}/${stat}/user/${userId}`,
                params,
              )
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      const projected = projectLeaderboard({
        community_id: cId,
        community_name: cName,
        window,
        metric,
        date: d,
        board,
        user_row: userRow,
      });
      try {
        const out = LeaderboardOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_leaderboard", e);
        throw e;
      }
    },
  );
}
