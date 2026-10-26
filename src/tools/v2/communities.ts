import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CommunitiesOut } from "../../schemas/communities.js";
import { projectCommunities } from "../../projections/communities.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { READ_ONLY } from "../annotations.js";

// Compute the date range for the given period, ending today. Used for the
// leaderboard segment of the memberships query.
function dateRange(period: "day" | "week" | "month"): { startDate: string; endDate: string } {
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today);
  if (period === "week") start.setUTCDate(today.getUTCDate() - 6);
  else if (period === "month") start.setUTCDate(today.getUTCDate() - 29);
  return { startDate: start.toISOString().slice(0, 10), endDate: end };
}

export function registerCommunities(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_communities",
    "Lists the communities you belong to (teams, friend groups) with member count and optionally your rank, controlled by team_type (ALL, COMMUNITY, TEAM, BUSINESS), metric (strain, sleep, recovery), and period (day, week, month). Use this to discover community IDs, then whoop_leaderboard to drill into one.",
    {
      team_type: z.enum(["ALL", "COMMUNITY", "TEAM", "BUSINESS"]).default("ALL").describe("Filter by community type. ALL returns everything."),
      metric: z.enum(["strain", "sleep", "recovery"]).default("strain").describe("Which leaderboard ranking to fetch your rank against."),
      period: z.enum(["day", "week", "month"]).default("week").describe("Rolling window for the rank lookup."),
      include_rank: z.boolean().default(true).describe("If false, skip fetching your rank in each community (faster, fewer fields)."),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    },
    READ_ONLY,
    async ({ team_type, metric, period, include_rank, limit, offset }) => {
      const userId = process.env.WHOOP_USER_ID;
      const { startDate, endDate } = dateRange(period);
      const params: Record<string, string> = {
        teamType: team_type,
        includeOwnerDetails: "true",
        includeUserRank: include_rank ? "true" : "false",
        leaderboardType: metric,
        period,
        startDate,
        endDate,
        offset: String(offset),
        limit: String(limit),
      };
      if (userId) params.userId = userId;

      const raw = await client.get("/community-service/v1/communities/memberships", params);
      const projected = projectCommunities({
        raw,
        team_type,
        leaderboard_metric: metric,
        period,
      });

      try {
        const out = CommunitiesOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_communities", e);
        throw e;
      }
    },
  );
}
