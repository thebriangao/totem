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
      // Window the target date so we catch the sleep that *ends* on it.
      const dayMs = Date.parse(`${date}T00:00:00.000Z`);
      const start = new Date(dayMs - 86_400_000).toISOString();
      const end = new Date(dayMs + 2 * 86_400_000).toISOString();
      const [home, sleep, recovery] = await Promise.all([
        client.get("/home-service/v1/home", { date }),
        // Light sleep summary (~1 KB) — the full hypnogram lives in whoop_sleep.
        client.get("/developer/v2/activity/sleep", { start, end, limit: "10" }).catch(() => null),
        // Deep-dive recovery is date-aligned; the /developer/v2/recovery records
        // match by UTC created_at, which is off-by-one on historical lookups.
        client.get("/home-service/v1/deep-dive/recovery", { date }).catch(() => null),
      ]);
      const projected = projectToday({ home, sleep, recovery, state: null, date });
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
