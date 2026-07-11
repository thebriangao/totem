import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { TodayOut } from "../../schemas/today.js";
import { projectToday } from "../../projections/today.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerToday(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_today",
    "Composite snapshot for today: recovery score, sleep performance + stages, day strain so far, workouts logged today, current activity state.",
    {},
    async () => {
      const date = todayIso();
      const [home, sleep, recovery, state] = await Promise.all([
        client.get("/home-service/v1/home", { date }),
        // Light sleep summary (~1 KB) — the full hypnogram lives in whoop_sleep.
        client.get("/developer/v2/activity/sleep", { limit: "5" }).catch(() => null),
        // HRV / RHR from the date-aligned deep-dive recovery tile. (The /home gauge
        // only carries the score; matching /developer/v2/recovery by created_at is
        // off-by-one for non-UTC users because created_at is UTC.)
        client.get("/home-service/v1/deep-dive/recovery", { date }).catch(() => null),
        client.get("/activities-service/v1/user-state").catch(() => null),
      ]);
      const projected = projectToday({ home, sleep, recovery, state, date });
      try {
        const out = TodayOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_today", e);
        throw e;
      }
    },
  );
}
