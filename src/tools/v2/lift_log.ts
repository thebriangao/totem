import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftLogOut } from "../../schemas/strength.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { buildExerciseGroups } from "../../whoop/build_lift_body.js";
import { resolveOfficialExercise } from "../../lib/exercise_lookup.js";
import { canonicalUtc } from "../../lib/dates.js";
import { WRITE_ADDITIVE } from "../annotations.js";

const PATH = "/weightlifting-service/v2/weightlifting-workout/activity";

function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function registerLiftLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_log",
    "WRITE: log a finished strength workout — pass exercises by ID or exact name, each with sets (reps and/or weight in kg and/or time_seconds). Preview unless confirm:true.",
    {
      name: z.string().optional(),
      start: z.iso.datetime({ offset: true }).optional(),
      end: z.iso.datetime({ offset: true }).optional(),
      exercises: z.array(z.object({
        exercise_id: z.string().optional(),
        exercise: z.string().optional().describe("Exact exercise name or ID; avoids a separate catalog lookup."),
        sets: z.array(z.object({
          reps: z.number().int().min(0),
          weight: z.number().min(0).optional(),
          time_seconds: z.number().int().min(0).optional(),
          strap_location: z.enum(["LEFT", "RIGHT", "BOTH"]).default("LEFT"),
        })).min(1),
      })).min(1),
      confirm: z.boolean().default(false),
    },
    WRITE_ADDITIVE,
    async ({ name, start, end, exercises, confirm }) => {
      const endTs = end ? new Date(end).getTime() : Date.now();
      const startTs = start ? new Date(start).getTime() : endTs - 30 * 60 * 1000;
      if (endTs <= startTs) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Strength workout end must be after start." }) }],
          isError: true,
        };
      }
      const resolvedExercises = exercises.map((exercise) => ({
        ...exercise,
        exercise_id: exercise.exercise_id ?? (exercise.exercise ? resolveOfficialExercise(exercise.exercise) ?? undefined : undefined),
      }));
      if (resolvedExercises.some((exercise) => !exercise.exercise_id)) {
        return { content: [{ type: "text", text: jsonOut({ error: "Each exercise needs an exercise_id or exact exercise name." }) }], isError: true };
      }
      const { workout_groups, set_count, unknown_exercises } = buildExerciseGroups(resolvedExercises as Array<{ exercise_id: string; sets: typeof exercises[number]["sets"] }>, startTs);
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
      // Whoop's body wants an IANA zone name. Prefer WHOOP_TIMEZONE when it's an
      // IANA name (cloud hosts run in UTC, so the system zone would mislabel the
      // logged workout); else fall back to the system zone (correct for local
      // stdio use). Never send a bare numeric offset.
      const tzEnv = process.env.WHOOP_TIMEZONE;
      const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const timezone = tzEnv && tzEnv.includes("/") && isValidIanaTimezone(tzEnv)
        ? tzEnv
        : isValidIanaTimezone(systemTimezone) ? systemTimezone : "UTC";
      const body = {
        name: name ?? new Date(endTs).toISOString().slice(0, 10),
        during: `['${canonicalUtc(startTs)}','${canonicalUtc(endTs)}')`,
        timezone,
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
                  exercise_count: resolvedExercises.length,
                  set_count,
                  exercise_list: resolvedExercises.map((e) => ({ name: e.exercise_id, set_count: e.sets.length })),
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
        exercise_count: resolvedExercises.length,
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
