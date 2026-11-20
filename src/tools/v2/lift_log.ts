import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftLogOut, LiftAttachOut } from "../../schemas/strength.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { buildExerciseGroups, setSlots, type InputExercise } from "../../whoop/build_lift_body.js";
import { resolveOfficialExercise } from "../../lib/exercise_lookup.js";
import { canonicalUtc, isoDay } from "../../lib/dates.js";

const PATH = "/weightlifting-service/v2/weightlifting-workout/activity";
const WORKOUTS_PATH = "/developer/v2/activity/workout";
const DELETE_PATH = "/core-details-bff/v1/cardio-details";
// An activity that started up to a day earlier can still overlap the window.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const TEMPLATE_PATH = "/weightlifting-service/v3/workout-template";
const LINK_PATH = "/weightlifting-service/v2/weightlifting-workout/link-cardio-workout";
const TEMPLATE_DELETE_PATH = "/weightlifting-service/v2/workout-template";

export interface LinkTarget {
  linkable: boolean;
  sport_name: string | null;
  start: string | null;
  end: string | null;
}

// cardio-details for the target activity: whether the app would offer
// "Calculate Muscular Load" for it, plus its sport and window.
export function linkTarget(raw: unknown): LinkTarget {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const edit = r.details_edit_components && typeof r.details_edit_components === "object"
    ? (r.details_edit_components as Record<string, unknown>)
    : {};
  const t = (k: string) => {
    const sel = edit[k];
    const v = sel && typeof sel === "object" ? (sel as Record<string, unknown>).initial_time : null;
    return typeof v === "string" ? v : null;
  };
  return {
    linkable: r.link_workout_option_enabled === true,
    sport_name: typeof edit.activity_type_internal_name === "string" ? edit.activity_type_internal_name : null,
    start: t("start_time_selector"),
    end: t("end_time_selector"),
  };
}

// The link body carries sets as {weight, number_of_reps, time_in_seconds?}
// alongside each exercise's exercise_details.
export function linkWorkoutGroups(workoutGroups: unknown[], exercises: InputExercise[]): unknown[] {
  return workoutGroups.map((g, i) => {
    const details = (g as { workout_exercises: Array<{ exercise_details: unknown }> }).workout_exercises[0]!.exercise_details;
    return {
      workout_exercises: [{
        sets: exercises[i]!.sets.map((s) => ({
          weight: s.weight ?? 0,
          number_of_reps: s.reps,
          ...(s.time_seconds !== undefined ? { time_in_seconds: s.time_seconds } : {}),
        })),
        exercise_details: details,
      }],
    };
  });
}

function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export interface Overlap {
  activity_id: string;
  sport_name: string | null;
  start: string;
  end: string;
}

export function resolveWindow(
  start: string | undefined,
  end: string | undefined,
  nowMs: number,
): { startTs: number; endTs: number } | { error: string } {
  const endTs = end ? new Date(end).getTime() : nowMs;
  const startTs = start ? new Date(start).getTime() : endTs - 30 * 60 * 1000;
  if (endTs <= startTs) return { error: "Strength workout end must be after start." };
  return { startTs, endTs };
}

export function duringLiteral(startTs: number, endTs: number): string {
  return `['${canonicalUtc(startTs)}','${canonicalUtc(endTs)}')`;
}

export function parseDuring(during: unknown): [number, number] | null {
  if (typeof during !== "string") return null;
  const m = during.match(/^[[(]'?([^',]+)'?,\s*'?([^',)\]]+)'?[)\]]$/);
  if (!m) return null;
  const a = Date.parse(m[1]!);
  const b = Date.parse(m[2]!);
  return Number.isNaN(a) || Number.isNaN(b) ? null : [a, b];
}

export function zeroRepWeightedSets(exercises: InputExercise[]): Array<{ exercise_id: string; set_number: number; weight: number }> {
  const bad: Array<{ exercise_id: string; set_number: number; weight: number }> = [];
  for (const ex of exercises) {
    ex.sets.forEach((s, i) => {
      if (s.reps === 0 && (s.weight ?? 0) > 0 && s.time_seconds === undefined) {
        bad.push({ exercise_id: ex.exercise_id, set_number: i + 1, weight: s.weight! });
      }
    });
  }
  return bad;
}

export function findOverlaps(raw: unknown, startTs: number, endTs: number): Overlap[] {
  const records = raw && typeof raw === "object" && Array.isArray((raw as { records?: unknown }).records)
    ? (raw as { records: unknown[] }).records
    : [];
  const out: Overlap[] = [];
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.start !== "string" || typeof rec.end !== "string") continue;
    const s = Date.parse(rec.start);
    const e = Date.parse(rec.end);
    if (s < endTs && e > startTs) {
      out.push({
        activity_id: rec.id,
        sport_name: typeof rec.sport_name === "string" ? rec.sport_name : null,
        start: rec.start,
        end: rec.end,
      });
    }
  }
  return out;
}

function localTime(ts: number, timezone: string): string {
  return new Date(ts).toLocaleString("sv-SE", { timeZone: timezone });
}

function overlapList(overlaps: Overlap[], timezone: string) {
  return overlaps.map((o) => ({
    ...o,
    start_local: localTime(Date.parse(o.start), timezone),
    end_local: localTime(Date.parse(o.end), timezone),
  }));
}

function errorOut(payload: unknown) {
  return { content: [{ type: "text" as const, text: jsonOut(payload) }], isError: true };
}

export function registerLiftLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_log",
    "WRITE: log a finished strength workout - pass exercises by ID or exact name, each with sets (reps and/or weight in kg and/or time_seconds). Preview unless confirm:true. Refuses if the window overlaps an existing activity unless replace_overlapping:true, which deletes the overlapping activities first. Sets with weight but reps:0 are rejected (missed lifts would be awarded weight PRs).",
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
      replace_overlapping: z.boolean().default(false).describe("Delete any existing activity overlapping start..end before logging. Destructive; the deleted activities are listed in the response."),
      attach_to_activity_id: z.string().optional().describe("Attach the sets to this existing strap-recorded activity (the app's 'Calculate Muscular Load') instead of creating a new one. Keeps its sport, HR, strain and time window; start/end are ignored. Whoop requires a template for this; it's deleted afterwards unless keep_template:true."),
      keep_template: z.boolean().default(false).describe("With attach_to_activity_id: keep the template Whoop requires in My Workouts instead of deleting it."),
      confirm: z.boolean().default(false),
    },
    async ({ name, start, end, exercises: rawExercises, replace_overlapping, attach_to_activity_id, keep_template, confirm }) => {
      const resolved = rawExercises.map((e) => ({
        ...e,
        exercise_id: e.exercise_id ?? (e.exercise ? resolveOfficialExercise(e.exercise) ?? undefined : undefined),
      }));
      if (resolved.some((e) => !e.exercise_id)) {
        return errorOut({ error: "Each exercise needs an exercise_id or exact exercise name." });
      }
      const exercises = resolved as InputExercise[];
      const window = resolveWindow(start, end, Date.now());
      if ("error" in window) return errorOut({ error: window.error, start, end });
      const { startTs, endTs } = window;
      const zeroRep = zeroRepWeightedSets(exercises);
      if (zeroRep.length > 0) {
        return errorOut({
          error: "Sets with weight > 0 and reps: 0 are rejected.",
          sets: zeroRep,
          reason: "Whoop awards weight PRs and medals without checking reps, so a missed lift logged as reps:0 becomes a PR, and individual sets can't be deleted in the app afterwards.",
          hint: "Leave missed attempts out, or log only the completed reps.",
        });
      }
      const { workout_groups, set_count, unknown_exercises } = buildExerciseGroups(exercises, startTs, endTs);
      if (unknown_exercises.length > 0) {
        return errorOut({
          error: "Unknown exercise IDs",
          unknown_exercises,
          hint: "Use whoop_lift_catalog or whoop_lift_custom_exercise",
        });
      }
      if (attach_to_activity_id) {
        if (replace_overlapping) return errorOut({ error: "attach_to_activity_id and replace_overlapping can't be combined." });
        let target: LinkTarget;
        try {
          target = linkTarget(await client.get(DELETE_PATH, { activityId: attach_to_activity_id }));
        } catch (e) {
          return errorOut({
            error: `Could not read activity ${attach_to_activity_id}, so nothing was attached.`,
            detail: e instanceof Error ? e.message : String(e),
          });
        }
        const activity = { activity_id: attach_to_activity_id, sport_name: target.sport_name, start: target.start, end: target.end };
        if (!target.linkable) {
          return errorOut({
            error: "Whoop doesn't allow attaching strength sets to this activity (link_workout_option_enabled is false). It may already have sets attached, or its sport isn't MSK-linkable.",
            activity,
          });
        }
        const templateName = name ?? (target.start ?? new Date().toISOString()).slice(0, 10);
        if (!confirm) {
          return {
            content: [{
              type: "text",
              text: jsonOut(preview("POST", LINK_PATH, {
                attach_to: activity,
                steps: [
                  `POST ${TEMPLATE_PATH} (saves "${templateName}" to My Workouts)`,
                  `POST ${LINK_PATH}`,
                  ...(keep_template ? [] : [`DELETE ${TEMPLATE_DELETE_PATH}/{template_id}`]),
                ],
                exercise_count: exercises.length,
                set_count,
                exercise_list: exercises.map((e) => ({ name: e.exercise_id, set_count: e.sets.length })),
              })),
            }],
          };
        }
        // link-cardio-workout 422s without a template_id, so save one first.
        const tpl = await client.post<{ workout_template_key?: number; id?: number }>(TEMPLATE_PATH, { name: templateName, workout_groups });
        const templateId = tpl.workout_template_key ?? tpl.id;
        if (typeof templateId !== "number") {
          return errorOut({ error: "Template save returned no workout_template_key; nothing was attached." });
        }
        // The sets stay on the activity after the template is deleted.
        const deleteTemplate = async (): Promise<boolean> => {
          try {
            await client.delete(`${TEMPLATE_DELETE_PATH}/${templateId}`);
            return true;
          } catch {
            return false;
          }
        };
        let linked: { original_activity_type?: string; workout_metadata?: Record<string, unknown> };
        try {
          linked = await client.post<{ original_activity_type?: string; workout_metadata?: Record<string, unknown> }>(LINK_PATH, {
            template: {
              workout_groups: linkWorkoutGroups(workout_groups, exercises),
              name: templateName,
              source: "USER",
              workout_template_key: templateId,
            },
            rpe: 0,
            template_id: templateId,
            activity_id: attach_to_activity_id,
          });
        } catch (e) {
          if (!keep_template) await deleteTemplate();
          throw e;
        }
        const templateDeleted = keep_template ? false : await deleteTemplate();
        const meta = linked.workout_metadata ?? {};
        const out = LiftAttachOut.parse({
          attached: true,
          activity_id: attach_to_activity_id,
          template_id: templateId,
          template_deleted: templateDeleted,
          original_activity_type: linked.original_activity_type ?? null,
          type: typeof meta.type === "string" ? meta.type : null,
          during: typeof meta.during === "string" ? meta.during : null,
          exercise_count: exercises.length,
          set_count,
          total_volume_kg: typeof meta.total_effective_volume_kg === "number" ? meta.total_effective_volume_kg : null,
        });
        return { content: [{ type: "text", text: jsonOut(out) }] };
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
      const during = duringLiteral(startTs, endTs);
      const body = {
        name: name ?? isoDay(new Date(endTs)),
        during,
        timezone,
        scaled_msk_strain_score: 0,
        msk_total_volume_kg: 0,
        msk_intensity_percent: 0,
        raw_msk_strain_score: 0,
        workout_groups,
      };
      const timeRange = {
        during,
        start_local: localTime(startTs, timezone),
        end_local: localTime(endTs, timezone),
        timezone,
        duration_minutes: Math.round((endTs - startTs) / 600) / 100,
      };

      // Whoop no longer rejects an overlapping log: it removes the existing
      // activity and saves the new one. Check first and make the caller choose.
      let overlaps: Overlap[];
      try {
        const raw = await client.get(WORKOUTS_PATH, {
          start: new Date(startTs - LOOKBACK_MS).toISOString(),
          end: new Date(endTs).toISOString(),
          limit: 25,
        });
        overlaps = findOverlaps(raw, startTs, endTs);
      } catch (e) {
        return errorOut({
          error: "Could not check for overlapping activities, so nothing was logged.",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      const clashing = overlapList(overlaps, timezone);

      if (!confirm) {
        const slots = setSlots(startTs, endTs, set_count);
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("POST", PATH, {
                  time_range: timeRange,
                  set_timing: set_count > 0
                    ? {
                        first_set_start: new Date(slots[0]![0]).toISOString(),
                        last_set_end: new Date(slots[set_count - 1]![1]).toISOString(),
                        seconds_per_set: Math.round((slots[0]![1] - slots[0]![0]) / 1000),
                      }
                    : null,
                  exercise_count: exercises.length,
                  set_count,
                  exercise_list: exercises.map((e) => ({ name: e.exercise_id, set_count: e.sets.length })),
                  overlapping_activities: clashing,
                  overlap_action: clashing.length === 0
                    ? "none"
                    : replace_overlapping
                      ? "will DELETE the overlapping activities listed above, then log"
                      : "will refuse: pass replace_overlapping:true to delete them, or pick a window that doesn't overlap",
                }),
              ),
            },
          ],
        };
      }

      if (clashing.length > 0 && !replace_overlapping) {
        return errorOut({
          error: "The requested window overlaps an existing activity. Nothing was logged.",
          requested: timeRange,
          overlapping_activities: clashing,
          hint: "Pick a window that doesn't overlap, pass attach_to_activity_id to add the sets to the existing activity (keeps its HR and strain), or pass replace_overlapping:true to delete the overlapping activities and log over the full window.",
        });
      }

      const deleted: typeof clashing = [];
      for (const o of clashing) {
        try {
          await client.delete(DELETE_PATH, { activityId: o.activity_id });
          deleted.push(o);
        } catch (e) {
          return errorOut({
            error: `Failed to delete overlapping activity ${o.activity_id}. Nothing was logged.`,
            deleted_before_failure: deleted,
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }

      let receipt: { id: string; during?: unknown };
      try {
        receipt = await client.post<{ id: string; during?: unknown }>(PATH, body);
      } catch (e) {
        if (deleted.length === 0) throw e;
        return errorOut({
          error: "Overlapping activities were deleted but the log POST failed.",
          deleted_overlapping: deleted,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      const saved = parseDuring(receipt.during);
      const projected = {
        logged: true as const,
        activity_id: receipt.id,
        exercise_count: exercises.length,
        set_count,
        total_volume_kg: null,
        requested_during: during,
        saved_during: typeof receipt.during === "string" ? receipt.during : null,
        ...(saved && (saved[0] !== startTs || saved[1] !== endTs)
          ? { warning: "Whoop saved a different time window than was requested; check the activity in the app." }
          : {}),
        ...(deleted.length > 0 ? { deleted_overlapping: deleted } : {}),
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
