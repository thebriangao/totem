// whoop_lift_template (W!): replaces whoop_lift_template_save; closes issue #5
// (update + delete). SPEC.md D4: POST v3 with an existing key edits in place, but
// an unknown or deleted key silently creates a new template, so edits are
// existence-checked first; copy = GET + POST without a key.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { LiftTemplateOut } from "../../schemas/strength_v2.js";
import { preview } from "../../whoop/write_safety.js";
import { accountWeightUnit } from "../../whoop/units.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { get } from "../../whoop/bff.js";
import { ExerciseResolver } from "../../lib/lift_catalog.js";
import { buildTemplateGroups, sentWeight, setShapeProblems, type ExerciseSets } from "../../lib/lift_sets.js";
import { errorMessage, liftError } from "../../lib/lift_tool.js";
import { groupExercises } from "../../projections/lift_library_v2.js";

const TOOL = "whoop_lift_template";
export const TEMPLATE_POST = "/weightlifting-service/v3/workout-template";
export const templatePath = (key: number | string) => `/weightlifting-service/v2/workout-template/${encodeURIComponent(String(key))}`;
const prebuiltPath = (id: string) => `/weightlifting-service/v2/prebuilt-workout-template/${encodeURIComponent(id)}`;

const SetIn = z.object({
  reps: z.number().int().min(0).max(1000).optional(),
  weight: z.number().min(0).max(2000).optional(),
  time_seconds: z.number().int().min(1).max(86_400).optional(),
});
const ExerciseIn = z.object({
  exercise_id: z.string().optional(),
  name: z.string().optional().describe("Or the exact name"),
  sets: z.array(SetIn).min(1).max(50),
});

const is404 = (e: unknown) => e instanceof WhoopApiError && e.status === 404;

/** Re-send groups as read: the verbatim exercise rows with sets cut to the three fields WHOOP keeps. */
function cleanGroups(groups: unknown): unknown[] {
  const list = Array.isArray(groups) ? groups : [];
  return list.map((g) => ({
    workout_exercises: ((get(g, "workout_exercises") ?? []) as unknown[]).map((we) => ({
      exercise_details: get(we, "exercise_details"),
      sets: ((get(we, "sets") ?? []) as unknown[]).map((s) => {
        const set: Record<string, unknown> = { number_of_reps: get(s, "number_of_reps") ?? 0 };
        if (typeof get(s, "weight") === "number") set.weight = get(s, "weight");
        if (typeof get(s, "time_in_seconds") === "number") set.time_in_seconds = get(s, "time_in_seconds");
        return set;
      }),
    })),
  }));
}

function shape(groups: unknown): { ids: string[]; sets: number } {
  const ex = groupExercises(groups);
  return { ids: ex.map((e) => e.id), sets: ex.reduce((n, e) => n + e.sets.length, 0) };
}

type Exercises = ReturnType<typeof groupExercises>;

/** Same exercises in the same order, and every set's reps, weight and time as sent. */
function sameSets(sent: Exercises, back: Exercises): boolean {
  return sent.length === back.length && sent.every((e, i) => {
    const b = back[i]!;
    return e.id === b.id && e.sets.length === b.sets.length && e.sets.every((s, k) => {
      const t = b.sets[k]!;
      return (s.reps ?? 0) === (t.reps ?? 0) && Math.abs((s.weight ?? 0) - (t.weight ?? 0)) <= 0.05 && (s.time ?? 0) === (t.time ?? 0);
    });
  });
}

export function registerLiftTemplate(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: TOOL,
    description:
      "Manage your Strength Trainer templates. create: name and exercises. edit: template_key with a new name and/or exercises (the " +
      "whole list is replaced). copy: copy_from (your template_key or a WHOOP prebuilt_id) into a new template. delete: template_key. " +
      "Weights need unit. Keys: whoop_lift_library. Previews unless confirm:true.",
    input: {
      action: z.enum(["create", "edit", "copy", "delete"]),
      template_key: z.number().int().optional(),
      copy_from: z.union([z.number().int(), z.string()]).optional(),
      name: z.string().min(1).max(100).optional(),
      exercises: z.array(ExerciseIn).min(1).max(30).optional(),
      unit: z.enum(["kg", "lb"]).optional(),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async ({ action, template_key, copy_from, name, exercises, unit, confirm }) => {
    const warnings: string[] = [];

    // 1. Validate.
    if ((action === "edit" || action === "delete") && template_key === undefined) return liftError({ error: `${action} needs template_key.` });
    if (action === "create" && (!name || !exercises)) return liftError({ error: "create needs name and exercises." });
    if (action === "copy" && copy_from === undefined) return liftError({ error: "copy needs copy_from." });
    if (action === "edit" && !name && !exercises) return liftError({ error: "edit needs a new name and/or exercises." });
    if (action === "delete" && (name || exercises)) return liftError({ error: "delete takes only template_key." });
    // No default unit: a bare 225 read as kg on a lb account would be saved as 496 lb.
    if (!unit && exercises?.some((e) => e.sets.some((s) => (s.weight ?? 0) > 0))) {
      return liftError({ error: "Say which unit the weights are in: unit \"kg\" or \"lb\". Nothing is assumed." });
    }

    // 2. Fresh pre-reads.
    let current: unknown = null;
    let copiedFrom: string | null = null;
    if (action === "edit" || action === "delete") {
      try {
        current = await client.get(templatePath(template_key!), {}, { fresh: true });
      } catch (e) {
        if (is404(e)) return liftError({ error: `No template ${template_key}. List yours with whoop_lift_library.` });
        throw e;
      }
    }
    if (action === "copy") {
      const key = String(copy_from);
      try {
        current = await client.get(templatePath(key), {}, { fresh: true });
        copiedFrom = `template ${key}`;
      } catch (e) {
        if (!is404(e)) throw e;
        try {
          current = get(await client.get(prebuiltPath(key), {}, { fresh: true }), "workout_template");
          copiedFrom = `WHOOP workout ${key}`;
        } catch (e2) {
          if (is404(e2)) return liftError({ error: `copy_from ${key} is neither your template nor a WHOOP workout.` });
          throw e2;
        }
      }
    }

    let items: ExerciseSets[] | null = null;
    if (exercises) {
      const resolution = await new ExerciseResolver(client).resolveAll(exercises);
      if (!resolution.ok) return liftError({ error: "Unknown exercise(s).", misses: resolution.misses });
      items = resolution.exercises.map((exercise, i) => ({ exercise, sets: exercises[i]!.sets }));
      const problems = setShapeProblems(items);
      if (problems.length > 0) return liftError({ error: "Some sets don't fit their exercise.", problems });
    }

    if (action === "delete") {
      const currentName = String(get(current, "name") ?? "");
      if (!confirm) {
        return respond(TOOL, LiftTemplateOut, preview("DELETE", templatePath(template_key!), { template_key, name: currentName, ...shape(get(current, "workout_groups")) }));
      }
      await client.delete(templatePath(template_key!));
      let gone = false;
      try {
        await client.get(templatePath(template_key!), {}, { fresh: true });
        warnings.push("The template still reads back after the delete.");
      } catch (e) {
        gone = is404(e);
        if (!gone) warnings.push(`Read-back failed: ${errorMessage(e)}`);
      }
      const s = shape(get(current, "workout_groups"));
      return respond(TOOL, LiftTemplateOut, {
        action: "deleted", template_key: template_key!, name: currentName, exercises: s.ids.length, sets: s.sets,
        unit: null, sent_unit: null, verified: gone, warnings,
      });
    }

    // The display unit is the last read before the write (D2). Without new sets the
    // weights are re-sent exactly as read, so no unit is involved.
    const account = items ? await accountWeightUnit(client) : null;
    const input = unit ?? account;
    const converted = account !== null && input !== account;
    const groups = items ? buildTemplateGroups(items, { input: input!, account: account! }) : cleanGroups(get(current, "workout_groups"));
    const finalName = name ?? (action === "copy" ? `${String(get(current, "name") ?? "Workout")} (copy)` : String(get(current, "name") ?? ""));
    const body: Record<string, unknown> = { name: finalName, workout_groups: groups };
    if (action === "edit") {
      body.workout_template_key = template_key;
      const source = get(current, "source");
      if (source === "USER" || source === "AI") body.source = source;
    }
    const sent = shape(groups);

    if (!confirm) {
      const was = shape(get(current, "workout_groups"));
      return respond(TOOL, LiftTemplateOut, preview("POST", TEMPLATE_POST, {
        action,
        ...(action === "edit" ? { template_key, was: String(get(current, "name") ?? "") } : {}),
        ...(copiedFrom ? { copy_of: copiedFrom } : {}),
        name: finalName,
        // New sets: weights as the caller gave them, plus `sent` (the account's unit) when converted.
        // Unchanged sets (rename, copy): counts only; whoop_lift_library shows them with their unit.
        ...(items
          ? {
              exercises: items.map(({ exercise, sets }) => ({
                id: exercise.exercise_id,
                sets: sets.map((s) => [s.weight ?? 0, exercise.volume_input_format === "TIME" ? (s.time_seconds ?? null) : (s.reps ?? null)]),
                ...(converted ? { sent: sets.map((s) => sentWeight(s.weight, input!, account!)) } : {}),
              })),
              unit: input,
              ...(converted ? { sent_unit: account } : {}),
              ...(action === "edit" ? { replaces: { exercises: was.ids.length, sets: was.sets } } : {}),
            }
          : { exercises: sent.ids.length, sets: sent.sets, ...(action === "edit" ? { note: "Exercises unchanged." } : {}) }),
      }));
    }

    const receipt = await client.post(TEMPLATE_POST, body);
    const key = get(receipt, "workout_template_key");
    if (typeof key !== "number") throw new Error("WHOOP saved the template but returned no workout_template_key; check whoop_lift_library.");
    // An edit must come back under the same key. A different one means WHOOP created a
    // new template (the key vanished after the existence check), so nothing was edited.
    const strayed = action === "edit" && key !== template_key;
    if (strayed) warnings.push(`WHOOP created template ${key} instead of editing ${template_key} (it no longer exists). Delete ${key} if it isn't wanted.`);

    let verified = false;
    try {
      const back = await client.get(templatePath(key), {}, { fresh: true });
      const same = get(back, "name") === finalName && sameSets(groupExercises(groups), groupExercises(get(back, "workout_groups")));
      if (!same) warnings.push("The template read back differently from what was sent.");
      verified = same && !strayed;
    } catch (e) {
      warnings.push(`Read-back failed: ${errorMessage(e)}`);
    }
    return respond(TOOL, LiftTemplateOut, {
      action: action === "create" || strayed ? "created" : action === "edit" ? "edited" : "copied",
      template_key: key,
      name: finalName,
      exercises: sent.ids.length,
      sets: sent.sets,
      unit: items ? input : null,
      sent_unit: converted ? account : null,
      verified,
      warnings,
    });
  });
}
