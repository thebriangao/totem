import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SPORTS } from "../../data/sports.js";
import { jsonOut } from "../../whoop/json_out.js";
import { markConsulted } from "../../whoop/session_state.js";

export function registerSportsCatalog(server: McpServer, _client: unknown): void {
  server.tool(
    "whoop_sports_catalog",
    "Browse the 203-sport catalog (numeric sport_id ↔ name). Used to find valid sport_ids for whoop_activity_create.",
    {
      search: z.string().optional().describe("Case-insensitive substring match on name."),
      limit: z.number().int().min(1).max(203).default(100),
    },
    async ({ search, limit }) => {
      markConsulted("sports");
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
