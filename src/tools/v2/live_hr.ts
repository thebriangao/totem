import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiveHrOut } from "../../schemas/live.js";
import { projectLiveHr } from "../../projections/live_hr.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerLiveHr(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_live_hr",
    "Current heart rate from the strap. Returns is_recording:false + last-known BPM if not actively streaming. Check last_updated_at for staleness.",
    {},
    async () => {
      const raw = await client.get("/health-tab-bff/v1/health-tab");
      const projected = projectLiveHr(raw);
      try {
        const out = LiveHrOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_live_hr", e);
        throw e;
      }
    },
  );
}
