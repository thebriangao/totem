import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftLogOut } from "../../schemas/strength.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { buildExerciseGroups } from "../../whoop/build_lift_body.js";
import { gateError } from "../../whoop/session_state.js";

const PATH = "/weightlifting-service/v2/weightlifting-workout/activity";

export function registerLiftLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_log",
    "WRITE: log a finished strength workout. Requires calling whoop_lift_catalog first to see valid exercise IDs. Pass exercises with sets (reps/weight/time). Preview unless confirm:true.",
    {
      name: z.string().optional(),
      start: z.iso.datetime({ offset: true }).optional(),
      end: z.iso.datetime({ offset: true }).optional(),
      exercises: z.array(z.object({
        exercise_id: z.string(),
        sets: z.array(z.object({
          reps: z.number().int().min(0),
          weight: z.number().min(0).optional(),
          time_seconds: z.number().int().min(0).optional(),
          strap_location: z.enum(["LEFT", "RIGHT", "BOTH"]).default("LEFT"),
        })).min(1),
      })).min(1),
      confirm: z.boolean().default(false),
    },
    async ({ name, start, end, exercises, confirm }) => {
      const gate = gateError("exercises", "whoop_lift_catalog");
      if (gate) return { content: [{ type: "text", text: JSON.stringify(gate, null, 2) }], isError: true };
      const endTs = end ? new Date(end).getTime() : Date.now();
      const startTs = start ? new Date(start).getTime() : endTs - 30 * 60 * 1000;
      const { workout_groups, set_count, unknown_exercises } = buildExerciseGroups(exercises, startTs);
      if (unknown_exercises.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut({
                error: "Unknown exercise IDs",
                unknown_exercises,
                hint: "Use whoop_lift_catalog or whoop_lift_custom_exercise",
              }),
            },
          ],
          isError: true,
        };
      }
      const body = {
        name: name ?? new Date(endTs).toISOString().slice(0, 10),
        during: `['${new Date(startTs).toISOString()}','${new Date(endTs).toISOString()}')`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scaled_msk_strain_score: 0,
        msk_total_volume_kg: 0,
        msk_intensity_percent: 0,
        raw_msk_strain_score: 0,
        workout_groups,
      };
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("POST", PATH, {
                  exercise_count: exercises.length,
                  set_count,
                  exercise_list: exercises.map((e) => ({ name: e.exercise_id, set_count: e.sets.length })),
                }),
              ),
            },
          ],
        };
      }
      const receipt = await client.post<{ id: string }>(PATH, body);
      const projected = {
        logged: true as const,
        activity_id: receipt.id,
        exercise_count: exercises.length,
        set_count,
        total_volume_kg: null,
      };
      try {
        const out = LiftLogOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_log", e);
        throw e;
      }
    },
  );
}
