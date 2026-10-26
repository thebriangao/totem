import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftTemplateSaveOut } from "../../schemas/strength.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { buildExerciseGroups, type InputExercise } from "../../whoop/build_lift_body.js";
import { resolveOfficialExercise } from "../../lib/exercise_lookup.js";
import { WRITE_ADDITIVE } from "../annotations.js";

const PATH = "/weightlifting-service/v3/workout-template";

export function registerLiftTemplateSave(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_template_save",
    "WRITE: create or save-as a Strength Trainer workout template from exercises by ID or exact name; sets can specify reps and/or weight (kg) and/or time_seconds. Preview unless confirm:true.",
    {
      name: z.string(),
      base_template_key: z.number().int().optional().describe("If provided, saves as derivative of an existing template."),
      exercises: z.array(z.object({
        exercise_id: z.string().optional(),
        exercise: z.string().optional().describe("Exact exercise name or ID; avoids a separate catalog lookup."),
        sets: z.array(z.object({
          // All optional — a template set can prescribe just reps, just weight,
          // a time, or nothing. Omit the keys you don't need.
          reps: z.number().int().nullable().optional(),
          weight: z.number().nullable().optional(),
          time_seconds: z.number().int().nullable().optional(),
        })).min(1),
      })).min(1),
      confirm: z.boolean().default(false),
    },
    WRITE_ADDITIVE,
    async ({ name, base_template_key, exercises, confirm }) => {
      const inputExercises: InputExercise[] = exercises.map((e) => ({
        exercise_id: e.exercise_id ?? (e.exercise ? resolveOfficialExercise(e.exercise) ?? "" : ""),
        sets: e.sets.map((s) => ({
          reps: s.reps ?? 0,
          weight: s.weight ?? undefined,
          time_seconds: s.time_seconds ?? undefined,
        })),
      }));
      if (inputExercises.some((exercise) => !exercise.exercise_id)) {
        return { content: [{ type: "text", text: jsonOut({ error: "Each exercise needs an exercise_id or exact exercise name." }) }], isError: true };
      }
      const { workout_groups, unknown_exercises } = buildExerciseGroups(inputExercises, 0);
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
      const body: Record<string, unknown> = { name, workout_groups };
      if (base_template_key !== undefined) body.workout_template_key = base_template_key;
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("POST", PATH, { name, exercise_count: exercises.length, base_template_key }),
              ),
            },
          ],
        };
      }
      const receipt = await client.post<{ workout_template_key?: number; id?: number }>(PATH, body);
      const projected = {
        created: true as const,
        template_id: receipt.workout_template_key ?? receipt.id ?? 0,
        name,
        exercise_count: exercises.length,
      };
      try {
        const out = LiftTemplateSaveOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_template_save", e);
        throw e;
      }
    },
  );
}
