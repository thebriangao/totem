import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftExerciseOut } from "../../schemas/strength.js";
import { projectLiftExercise } from "../../projections/lift_exercise.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { gateError } from "../../whoop/session_state.js";

export function registerLiftExercise(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_exercise",
    "Single exercise composite: metadata + recent sessions (sets with reps/weight/medal) + PRs. Requires calling whoop_lift_catalog first.",
    {
      exercise_id: z.string().describe("Exercise code (upper-snake) or UUID from whoop_lift_catalog."),
    },
    async ({ exercise_id }) => {
      const gate = gateError("exercises", "whoop_lift_catalog");
      if (gate) return { content: [{ type: "text", text: JSON.stringify(gate, null, 2) }], isError: true };
      const [info, history, prs] = await Promise.all([
        client.get(`/weightlifting-service/v1/exercise/${exercise_id}`),
        client.get(`/weightlifting-service/v3/exercise/${exercise_id}/exercise_history`),
        client.get(`/weightlifting-service/v3/exercise/${exercise_id}/personal_records`),
      ]);
      const projected = projectLiftExercise({ info, history, prs });
      try {
        const out = LiftExerciseOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_exercise", e);
        throw e;
      }
    },
  );
}
