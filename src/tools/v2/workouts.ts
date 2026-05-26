import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { WorkoutListOut } from "../../schemas/workouts.js";
import { projectWorkoutsList } from "../../projections/workouts.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { rangeFromDays } from "../../lib/dates.js";

export function registerWorkouts(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_workouts",
    "Recent workouts: list with sport, start/end, duration, strain, avg/max HR, calories. Use whoop_workout(activity_id) for full detail.",
    {
      start: z.iso.datetime({ offset: true }).optional().describe("ISO timestamp lower bound. Default: 30 days ago."),
      end: z.iso.datetime({ offset: true }).optional().describe("ISO timestamp upper bound. Default: now."),
      sport: z.string().optional().describe("Case-insensitive substring match on sport_name."),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ start, end, sport, limit }) => {
      const window = start && end ? { start, end } : rangeFromDays(30);
      const raw = await client.get("/developer/v2/activity/workout", {
        start: start ?? window.start,
        end: end ?? window.end,
        limit: Math.min(limit + 10, 25),
      });
      const projected = projectWorkoutsList(raw, sport, limit);
      try {
        const out = WorkoutListOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_workouts", e);
        throw e;
      }
    },
  );
}
