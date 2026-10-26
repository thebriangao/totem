import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { RawOut } from "../../schemas/escape.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";

export function registerRaw(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_raw",
    "ESCAPE HATCH: call any Whoop endpoint directly — use only when no specific tool fits, and look up the exact path with whoop_endpoints first. Mutating methods (POST/PUT/DELETE) require confirm:true.",
    {
      path: z.string(),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional(),
      confirm: z.boolean().default(false),
    },
    WRITE_DESTRUCTIVE,
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
      if (isMutate) client.invalidateAll();
      // The client throws on non-2xx, so reaching here means success; it doesn't
      // surface the exact code, so 200 stands in for any 2xx (incl. 201/204).
      const out = RawOut.parse({ path: safePath, method, status: 200, response });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
