import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftCustomExerciseOut } from "../../schemas/strength.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { EXERCISES_BY_ID } from "../../data/exercises.js";
import { gateError } from "../../whoop/session_state.js";

const PATH = "/weightlifting-service/v2/custom-exercise";

export function registerLiftCustomExercise(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_custom_exercise",
    "WRITE: create a custom Strength Trainer exercise based on an existing official one. Requires calling whoop_lift_catalog first.",
    {
      name: z.string(),
      push_core_name: z.string().describe("exercise_id of the official exercise this is based on."),
      muscle_groups: z
        .array(z.enum(["ARMS", "BACK", "CHEST", "CORE", "FULL_BODY", "LEGS", "OTHER", "SHOULDERS"]))
        .min(1)
        .describe("Whoop's API only accepts these 8 muscle groups. There is no GLUTES/HAMSTRINGS/QUADS/BICEPS/TRICEPS — use LEGS or ARMS."),
      equipment: z.enum(["MACHINE", "DUMBBELL", "BARBELL", "BODY", "OTHER", "KETTLEBELL"]).default("OTHER"),
      movement_pattern: z
        .enum([
          "SQUAT",
          "HINGE",
          "HORIZONTAL_PRESS",
          "VERTICAL_PRESS",
          "HORIZONTAL_PULL",
          "VERTICAL_PULL",
          "LUNGE",
          "JUMP",
          "OTHER",
        ])
        .default("OTHER")
        .describe("Whoop's API rejects OLYMPIC_LIFT, ROTATION, GAIT, CARRY despite them being plausible — use OTHER for those."),
      laterality: z
        .enum(["BILATERAL", "UNILATERAL_LEFT", "UNILATERAL_RIGHT", "ALTERNATING"])
        .default("BILATERAL"),
      volume_input_format: z.enum(["REPS", "TIME"]).default("REPS"),
      exercise_type: z.enum(["STRENGTH", "POWER"]).default("STRENGTH"),
      instructions: z.array(z.string()).default([]),
      trackable: z.boolean().default(true),
      confirm: z.boolean().default(false),
    },
    async (args) => {
      const gate = gateError("exercises", "whoop_lift_catalog");
      if (gate) return { content: [{ type: "text", text: JSON.stringify(gate, null, 2) }], isError: true };
      const linked = EXERCISES_BY_ID.get(args.push_core_name);
      if (!linked) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut({
                error: `push_core_name ${args.push_core_name} not in catalog`,
                hint: "Use whoop_lift_catalog to find a valid exercise_id",
              }),
            },
          ],
          isError: true,
        };
      }
      const newId = randomUUID().toUpperCase();
      const body = {
        created_at: "",
        updated_at: "",
        exercise_id: newId,
        laterality: args.laterality,
        exercise_type: args.exercise_type,
        push_core_name: args.push_core_name,
        training_types: [],
        custom_exercise_info: {
          linked_exercise: {
            name: linked.name,
            exercise_id: linked.exercise_id,
            image_url: `https://dh6o7n168ts9.cloudfront.net/exercises/${linked.exercise_id}.jpg`,
          },
        },
        trackable: args.trackable,
        movement_pattern: args.movement_pattern,
        instructions: args.instructions,
        equipment: args.equipment,
        name: args.name,
        volume_input_format: args.volume_input_format,
        muscle_groups: args.muscle_groups,
      };
      if (!args.confirm) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("POST", PATH, {
                  name: args.name,
                  push_core_name: args.push_core_name,
                  will_create_id: newId,
                }),
              ),
            },
          ],
        };
      }
      await client.post(PATH, body);
      const out = LiftCustomExerciseOut.parse({
        created: true as const,
        exercise_id: newId,
        name: args.name,
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
