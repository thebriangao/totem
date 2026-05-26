import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { SleepNeedOut } from "../../schemas/sleep_need.js";
import { projectSleepNeed } from "../../projections/sleep_need.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerSleepNeed(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_sleep_need",
    "Recommended bedtime/wake time + sleep need breakdown (baseline + debt + strain need) + smart-alarm eligibility.",
    {},
    async () => {
      const raw = await client.get("/coaching-service/v2/sleepneed");
      const projected = projectSleepNeed(raw);
      try {
        const out = SleepNeedOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_sleep_need", e);
        throw e;
      }
    },
  );
}
