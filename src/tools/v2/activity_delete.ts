import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { ActivityDeleteOut } from "../../schemas/workouts.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerActivityDelete(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_activity_delete",
    "WRITE / DESTRUCTIVE: delete a workout/activity. Preview unless confirm:true.",
    {
      activity_id: z.string(),
      confirm: z.boolean().default(false),
    },
    async ({ activity_id, confirm }) => {
      const path = "/core-details-bff/v1/cardio-details";
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut(preview("DELETE", `${path}?activityId=${activity_id}`, { activity_id })),
            },
          ],
        };
      }
      await client.delete(path, { activityId: activity_id });
      const out = ActivityDeleteOut.parse({ deleted: true as const, activity_id });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
