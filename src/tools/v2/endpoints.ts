import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EndpointsOut } from "../../schemas/escape.js";
import { ENDPOINTS } from "../../data/endpoints.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerEndpoints(server: McpServer, _client: unknown): void {
  server.tool(
    "whoop_endpoints",
    "Search the bundled catalog of Whoop iOS API endpoints. Call before whoop_raw to discover paths.",
    {
      filter: z.string().optional(),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async ({ filter, method, limit }) => {
      const f = filter?.toLowerCase();
      const matches = ENDPOINTS.filter((line) => {
        if (method && !line.startsWith(method + " ")) return false;
        if (f && !line.toLowerCase().includes(f)) return false;
        return true;
      });
      const out = EndpointsOut.parse({
        total_in_catalog: ENDPOINTS.length,
        matched: matches.length,
        truncated: matches.length > limit,
        endpoints: matches.slice(0, limit),
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
