import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { HiddenMetricOut } from "../../schemas/settings.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";

export function registerHiddenMetric(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_hidden_metric",
    "WRITE: show or hide a dashboard metric. metric: BODY_COMP or HEALTHSPAN. action: hide or show.",
    {
      metric: z.enum(["BODY_COMP", "HEALTHSPAN"]),
      action: z.enum(["hide", "show"]),
      confirm: z.boolean().default(false),
    },
    WRITE_DESTRUCTIVE,
    async ({ metric, action, confirm }) => {
      const path = `/users-service/v1/hidden-metrics/${metric}`;
      const method = action === "hide" ? "POST" : "DELETE";
      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview(method, path, { metric, action })) }] };
      }
      // This endpoint returns 200 for both states: `{ is_hidden: boolean }`.
      // Treating a successful GET as "hidden" turns an already-visible metric
      // into a needless DELETE write.
      const status = await client.get(path).catch(() => null) as { is_hidden?: unknown } | null;
      const currentlyHidden = status?.is_hidden === true;
      if (currentlyHidden === (action === "hide")) {
        const out = HiddenMetricOut.parse({ updated: false, no_change: true, metric, is_hidden: currentlyHidden });
        return { content: [{ type: "text", text: jsonOut(out) }] };
      }
      if (action === "hide") await client.post(path, undefined);
      else await client.delete(path);
      const out = HiddenMetricOut.parse({
        updated: true,
        no_change: false,
        metric,
        is_hidden: action === "hide",
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
