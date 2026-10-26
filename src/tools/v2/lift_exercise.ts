import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftExerciseOut } from "../../schemas/strength.js";
import { projectLiftExercise } from "../../projections/lift_exercise.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { resolveOfficialExercise } from "../../lib/exercise_lookup.js";
import { READ_ONLY } from "../annotations.js";

export function registerLiftExercise(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_exercise",
    "Single exercise composite: metadata + recent sessions (sets with reps/weight/medal) + PRs. Pass an ID or exact official exercise name.",
    {
      exercise_id: z.string().optional().describe("Exercise code or UUID."),
      exercise: z.string().optional().describe("Exact official exercise name; avoids a separate catalog lookup."),
    },
    READ_ONLY,
    async ({ exercise_id, exercise }) => {
      const resolvedId = exercise_id ?? (exercise ? resolveOfficialExercise(exercise) : null);
      if (!resolvedId) return { content: [{ type: "text", text: jsonOut({ error: "Provide an exercise_id or exact official exercise name." }) }], isError: true };
      const [info, history, prs] = await Promise.all([
        client.get(`/weightlifting-service/v1/exercise/${resolvedId}`),
        client.get(`/weightlifting-service/v3/exercise/${resolvedId}/exercise_history`),
        client.get(`/weightlifting-service/v3/exercise/${resolvedId}/personal_records`),
      ]);
      try {
        const projected = projectLiftExercise({ info, history, prs });
        const out = LiftExerciseOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_exercise", e);
        throw e;
      }
    },
  );
}
