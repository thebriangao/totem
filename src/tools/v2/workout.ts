import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { WorkoutOut } from "../../schemas/workouts.js";
import { projectWorkout } from "../../projections/workout.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { READ_ONLY } from "../annotations.js";

export function registerWorkout(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_workout",
    "Single workout full detail: strain, HR curve, HR zone durations, calories, distance, sport. Strength workouts also include MSK summary. Note: a just-created/logged activity stays 'pending' for a while and errors here until Whoop scores it.",
    {
      activity_id: z.string().describe("Workout UUID (from whoop_workouts; must be a scored, non-pending activity)."),
    },
    READ_ONLY,
    async ({ activity_id }) => {
      const raw = await client.get("/core-details-bff/v1/cardio-details", { activityId: activity_id });
      const projected = projectWorkout(raw, activity_id);
      try {
        const out = WorkoutOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_workout", e);
        throw e;
      }
    },
  );
}
