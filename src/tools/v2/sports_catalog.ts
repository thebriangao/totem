import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SPORTS } from "../../data/sports.js";
import { jsonOut } from "../../whoop/json_out.js";
import { READ_ONLY } from "../annotations.js";

export function registerSportsCatalog(server: McpServer, _client: unknown): void {
  server.tool(
    "whoop_sports_catalog",
    "Search the 203-sport catalog (numeric sport_id ↔ name) to get the exact sport_id for whoop_activity_create. Filter by a substring of the sport name and read the id straight from the result rather than guessing one.",
    {
      search: z.string().optional().describe("Case-insensitive substring match on name."),
      limit: z.number().int().min(1).max(203).default(100),
    },
    READ_ONLY,
    async ({ search, limit }) => {
      const s = search?.toLowerCase();
      const matches = SPORTS.filter((sp) => (s ? sp.name.toLowerCase().includes(s) : true));
      return {
        content: [{
          type: "text",
          text: jsonOut({
            total_in_catalog: SPORTS.length,
            matched: matches.length,
            truncated: matches.length > limit,
            sports: matches.slice(0, limit),
          }),
        }],
      };
    },
  );
}
