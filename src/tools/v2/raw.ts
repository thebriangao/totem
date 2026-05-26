import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { RawOut } from "../../schemas/escape.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerRaw(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_raw",
    "ESCAPE HATCH: call any Whoop endpoint directly. Use only when no specific tool fits. Mutating methods require confirm:true. Look up paths via whoop_endpoints first.",
    {
      path: z.string(),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional(),
      confirm: z.boolean().default(false),
    },
    async ({ path, method, query, body, confirm }) => {
      const safePath = path.startsWith("/") ? path : `/${path}`;
      const isMutate = method !== "GET";
      if (isMutate && !confirm) {
        return {
          content: [
            { type: "text", text: jsonOut(preview(method, safePath, { query: query ?? {}, body })) },
          ],
        };
      }
      let response: unknown;
      switch (method) {
        case "GET":
          response = await client.get(safePath, query ?? {});
          break;
        case "POST":
          response = await client.post(safePath, body, query ?? {});
          break;
        case "PUT":
          response = await client.put(safePath, body, query ?? {});
          break;
        case "DELETE":
          response = await client.delete(safePath, query ?? {});
          break;
      }
      const out = RawOut.parse({ path: safePath, method, status: 200, response });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
