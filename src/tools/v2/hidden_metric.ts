import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { HiddenMetricOut } from "../../schemas/settings.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerHiddenMetric(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_hidden_metric",
    "WRITE: show or hide a metric (BODY_COMP, HEALTHSPAN) on your dashboard.",
    {
      metric: z.enum(["BODY_COMP", "HEALTHSPAN"]),
      action: z.enum(["hide", "show"]),
      confirm: z.boolean().default(false),
    },
    async ({ metric, action, confirm }) => {
      const path = `/users-service/v1/hidden-metrics/${metric}`;
      const method = action === "hide" ? "POST" : "DELETE";
      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview(method, path, { metric, action })) }] };
      }
      if (action === "hide") await client.post(path, undefined);
      else await client.delete(path);
      const out = HiddenMetricOut.parse({
        updated: true as const,
        metric,
        is_hidden: action === "hide",
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
