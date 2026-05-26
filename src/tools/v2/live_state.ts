import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiveStateOut } from "../../schemas/live.js";
import { projectLiveState } from "../../projections/live_state.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerLiveState(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_live_state",
    "Are you currently in a tracked workout, sleep, or idle? Returns sport name + start time if active.",
    {},
    async () => {
      const raw = await client.get("/activities-service/v1/user-state");
      const projected = projectLiveState(raw);
      try {
        const out = LiveStateOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_live_state", e);
        throw e;
      }
    },
  );
}
