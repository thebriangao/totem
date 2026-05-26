import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { TodayOut } from "../../schemas/today.js";
import { projectToday } from "../../projections/today.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerDay(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_day",
    "Composite snapshot for any past date: recovery, sleep + stages, day strain, workouts count. Same shape as whoop_today but current_state is always null (not relevant for historical days).",
    {
      date: z.iso.date().describe("YYYY-MM-DD date to fetch. Required."),
    },
    async ({ date }) => {
      const [home, sleep] = await Promise.all([
        client.get("/home-service/v1/home", { date }),
        client.get("/home-service/v1/deep-dive/sleep/last-night", { date }).catch(() => null),
      ]);
      const projected = projectToday({ home, sleep, state: null, date });
      try {
        const out = TodayOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_day", e);
        throw e;
      }
    },
  );
}
