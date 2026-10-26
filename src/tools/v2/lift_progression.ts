import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftProgressionOut } from "../../schemas/strength.js";
import { projectLiftProgression } from "../../projections/lift_progression.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { resolveOfficialExercise } from "../../lib/exercise_lookup.js";
import { READ_ONLY } from "../annotations.js";

export function registerLiftProgression(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_progression",
    "Multi-window volume trend for a single exercise: 30-day, 6-month, year segments with avg volume + change % + per-session points. Pass an ID or exact official exercise name.",
    {
      exercise_id: z.string().optional().describe("Exercise code or UUID."),
      exercise: z.string().optional().describe("Exact official exercise name; avoids a separate catalog lookup."),
      end_date: z.iso.date().optional(),
    },
    READ_ONLY,
    async ({ exercise_id, exercise, end_date }) => {
      const resolvedId = exercise_id ?? (exercise ? resolveOfficialExercise(exercise) : null);
      if (!resolvedId) return { content: [{ type: "text", text: jsonOut({ error: "Provide an exercise_id or exact official exercise name." }) }], isError: true };
      const d = end_date ?? todayIso();
      const raw = await client.get(`/progression-service/v3/exercise/${resolvedId}`, { endDate: d });
      const projected = projectLiftProgression(raw, resolvedId, d);
      try {
        const out = LiftProgressionOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_progression", e);
        throw e;
      }
    },
  );
}
