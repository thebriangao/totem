// whoop_lift_log (W+): log a finished Strength Trainer workout, or attach sets to
// an existing activity. Ports PR #40 (set timing across the window, the 0-rep
// guard, local-date name, requested vs saved window) and PR #49 (attach via
// link-cardio-workout) by @chaotix345, reworked per SPEC.md D2/D6 and §6.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_ADDITIVE } from "../annotations.js";
import { LiftLogOutV2 } from "../../schemas/strength_v2.js";
import { preview } from "../../whoop/write_safety.js";
import { accountWeightUnit, type WeightUnit } from "../../whoop/units.js";
import { WhoopApiError, WhoopConflictError } from "../../whoop/errors.js";
import { get } from "../../whoop/bff.js";
import { assertNotFuture, isoDay } from "../../lib/dates.js";
import { ExerciseResolver } from "../../lib/lift_catalog.js";
import {
  buildActivityGroups,
  buildTemplateGroups,
  duringLiteral,
  liftTimezone,
  localTime,
  parseDuring,
  sentWeight,
  setShapeProblems,
  zeroRepWeightedSets,
  type ExerciseSets,
} from "../../lib/lift_sets.js";
import { errorMessage, liftError } from "../../lib/lift_tool.js";
import { findHistoryCard } from "../../lib/lift_history.js";
import { setScheme } from "../../projections/lift_sessions.js";

const TOOL = "whoop_lift_log";
export const LIFT_PATH = "/weightlifting-service/v2/weightlifting-workout/activity";
export const LINK_PATH = "/weightlifting-service/v2/weightlifting-workout/link-cardio-workout";
const DETAILS_PATH = "/core-details-bff/v1/cardio-details";
const DEFAULT_MINUTES = 30;
const MAX_HOURS = 12;

const SetIn = z.object({
  reps: z.number().int().min(0).max(1000).optional(),
  weight: z.number().min(0).max(2000).optional().describe("In `unit`."),
  time_seconds: z.number().int().min(1).max(86_400).optional().describe("Timed exercises."),
  performed: z.boolean().optional().describe("false = planned but skipped: no volume, not in history."),
});
const ExerciseIn = z.object({
  exercise_id: z.string().optional().describe("Catalog id or custom UUID (whoop_lift_library search)."),
  name: z.string().optional().describe("Exact exercise name, instead of exercise_id."),
  sets: z.array(SetIn).min(1).max(50),
});

function sessionSummary(items: ExerciseSets[], units: { input: WeightUnit; account: WeightUnit }) {
  return items.map(({ exercise, sets }) => {
    const timed = exercise.volume_input_format === "TIME";
    const performed = sets.filter((s) => s.performed !== false);
    return {
      id: exercise.exercise_id,
      name: exercise.name,
      sets: setScheme(performed.map((s) => (timed ? (s.time_seconds ?? null) : (s.reps ?? null))), timed ? "s" : ""),
      weights: performed.map((s) => sentWeight(s.weight, units.input, units.account)),
      ...(performed.length < sets.length ? { skipped: sets.length - performed.length } : {}),
    };
  });
}

/** Does the first exercise's history (fresh, paged, retried while WHOOP catches up) show this activity? */
async function verifyInHistory(client: WhoopClient, activityId: string, item: ExerciseSets | undefined, notBefore: string | undefined, expectedSets: number | null, warnings: string[]): Promise<boolean> {
  if (!item) return false;
  try {
    const card = await findHistoryCard(client, item.exercise.exercise_id, activityId, notBefore);
    if (!card) {
      warnings.push(`${item.exercise.name}'s history doesn't show this activity yet (WHOOP can lag ~30 s); check with whoop_lift_sessions.`);
      return false;
    }
    if (expectedSets !== null && card.sets.length !== expectedSets) warnings.push(`${item.exercise.name}: history shows ${card.sets.length} sets, ${expectedSets} were sent.`);
    return true;
  } catch (e) {
    warnings.push(`Read-back failed: ${errorMessage(e)}`);
    return false;
  }
}

export function registerLiftLog(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: TOOL,
    description:
      "Log a finished strength workout as a new Strength Trainer activity, or attach the sets to an existing activity (attach_to_activity_id; permanent: WHOOP has no unlink). Weights are converted from `unit` to the account's display unit. Sets are spread across start–end. A 409 means the window overlaps another activity: nothing is logged (delete it with whoop_activity_delete or pick another window). Refuses 0-rep weighted sets (WHOOP would award a permanent PR). Preview unless confirm:true.",
    input: {
      exercises: z.array(ExerciseIn).min(1).max(30),
      unit: z.enum(["kg", "lb"]).default("kg").describe("Unit of the weights you give."),
      start: z.iso.datetime({ offset: true }).optional().describe("Default end minus 30 min."),
      end: z.iso.datetime({ offset: true }).optional().describe("Default now; never in the future."),
      name: z.string().min(1).max(100).optional().describe("Default: the local date."),
      rpe: z.number().int().min(0).max(10).optional(),
      attach_to_activity_id: z.string().optional().describe("Add the sets to this activity instead (start/end unused)."),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_ADDITIVE,
  }, async ({ exercises, unit, start, end, name, rpe, attach_to_activity_id, confirm }) => {
    const warnings: string[] = [];
    const attach = attach_to_activity_id?.trim();

    // 1. Validate what needs no network.
    let window: { startMs: number; endMs: number } | null = null;
    if (attach) {
      if (start || end) warnings.push("start/end are ignored when attaching: the activity keeps its own window.");
      if (exercises.some((e) => e.sets.some((s) => s.performed === false))) {
        return liftError({ error: "performed:false can't be attached: every linked set counts. Leave skipped sets out." });
      }
    } else {
      const endMs = end ? Date.parse(end) : Date.now();
      const startMs = start ? Date.parse(start) : endMs - DEFAULT_MINUTES * 60_000;
      if (endMs <= startMs) return liftError({ error: "end must be after start.", start, end });
      if (endMs - startMs > MAX_HOURS * 3_600_000) return liftError({ error: `A lift longer than ${MAX_HOURS} h is almost certainly a wrong start or end.` });
      try {
        assertNotFuture(new Date(endMs).toISOString(), "end");
      } catch (e) {
        return liftError({ error: errorMessage(e) });
      }
      window = { startMs, endMs };
    }
    const zeroRep = zeroRepWeightedSets(exercises.map((e) => ({ label: e.exercise_id ?? e.name ?? "?", sets: e.sets })));
    if (zeroRep.length > 0) {
      return liftError({
        error: "Sets with weight and 0 reps are refused: WHOOP awards them a weight PR that can't be removed.",
        sets: zeroRep,
        fix: "Log only completed reps, or leave missed attempts out.",
      });
    }

    // 2. Fresh pre-reads: exercise rows (sent verbatim), display unit, attach target.
    const resolution = await new ExerciseResolver(client).resolveAll(exercises);
    if (!resolution.ok) return liftError({ error: "Unknown exercise(s).", misses: resolution.misses });
    const items: ExerciseSets[] = resolution.exercises.map((exercise, i) => ({ exercise, sets: exercises[i]!.sets }));
    const problems = setShapeProblems(items);
    if (problems.length > 0) return liftError({ error: "Some sets don't fit their exercise.", problems });
    const account = await accountWeightUnit(client);
    const units = { input: unit, account };
    const converted = unit !== account;

    if (attach) {
      let target: unknown = null;
      try {
        target = await client.get(DETAILS_PATH, { activityId: attach }, { fresh: true });
      } catch (e) {
        // 400 "Cannot view activity details for a pending activity" happens right after a create; the link still works.
        if (!(e instanceof WhoopApiError && e.status === 400)) return liftError({ error: `Couldn't read activity ${attach}: ${errorMessage(e)}` });
        warnings.push("The activity's details aren't readable yet (pending), so its sport and time aren't shown.");
      }
      const sport = get(target, "details_edit_components", "activity_type_internal_name") ?? null;
      const tz = liftTimezone();
      const activityStart = get(target, "details_edit_components", "start_time_selector", "initial_time");
      const linkName = name ?? (typeof activityStart === "string" ? isoDay(new Date(activityStart)) : isoDay());
      const body = {
        activity_id: attach,
        rpe: rpe ?? 0,
        template_id: -1,
        template: { name: linkName, source: "USER", workout_template_key: -1, workout_groups: buildTemplateGroups(items, units) },
      };
      if (!confirm) {
        return respond(TOOL, LiftLogOutV2, preview("POST", LINK_PATH, {
          attach_to: { activity_id: attach, sport, start: typeof activityStart === "string" ? localTime(Date.parse(activityStart), tz) : null },
          exercises: sessionSummary(items, units),
          unit: account,
          ...(converted ? { converted_from: unit } : {}),
          permanent: "Linking can't be undone; only deleting the activity removes these sets.",
          ...(warnings.length ? { warnings } : {}),
        }));
      }
      let linked: unknown;
      try {
        linked = await client.post(LINK_PATH, body);
      } catch (e) {
        if (e instanceof WhoopConflictError) {
          return liftError({ error: `Activity ${attach} already has Strength Trainer sets linked, and WHOOP has no unlink. Nothing was attached.`, detail: e.message });
        }
        throw e;
      }
      const meta = get(linked, "workout_metadata");
      const linkedStart = parseDuring(get(meta, "during"))?.[0];
      const notBefore = linkedStart !== undefined ? new Date(linkedStart).toISOString() : typeof activityStart === "string" ? activityStart : undefined;
      const verified = await verifyInHistory(client, attach, items[0], notBefore, null, warnings);
      return respond(TOOL, LiftLogOutV2, {
        action: "attached",
        activity_id: attach,
        saved_during: (get(meta, "during") as string | undefined) ?? null,
        score_state: (get(meta, "score_state") as string | undefined) ?? null,
        effective_volume_kg: (get(meta, "total_effective_volume_kg") as number | undefined) ?? null,
        unit: account,
        converted_from: converted ? unit : null,
        sent_weights: converted ? items.map(({ sets }) => sets.map((s) => sentWeight(s.weight, unit, account))) : null,
        verified,
        warnings,
      });
    }

    const { startMs, endMs } = window!;
    const timezone = liftTimezone();
    const requested = duringLiteral(startMs, endMs);
    const { workout_groups } = buildActivityGroups(items, window!, units);
    const body: Record<string, unknown> = {
      name: name ?? isoDay(new Date(endMs)),
      during: requested,
      timezone,
      scaled_msk_strain_score: 0,
      msk_total_volume_kg: 0,
      msk_intensity_percent: 0,
      raw_msk_strain_score: 0,
      workout_template_id: -1,
      workout_groups,
    };
    if (rpe !== undefined) body.rpe = rpe;

    if (!confirm) {
      return respond(TOOL, LiftLogOutV2, preview("POST", LIFT_PATH, {
        name: body.name,
        during: requested,
        local: `${localTime(startMs, timezone)} to ${localTime(endMs, timezone).slice(11)} ${timezone}`,
        exercises: sessionSummary(items, units),
        unit: account,
        ...(converted ? { converted_from: unit } : {}),
        ...(rpe !== undefined ? { rpe } : {}),
      }));
    }

    let receipt: unknown;
    try {
      receipt = await client.post(LIFT_PATH, body);
    } catch (e) {
      if (e instanceof WhoopConflictError) {
        return liftError({
          error: "WHOOP refused: the window overlaps an existing activity (409). Nothing was logged.",
          during: requested,
          fix: "Pick a window that doesn't overlap, or delete the other activity with whoop_activity_delete first.",
        });
      }
      if (e instanceof WhoopApiError && e.status === 422) {
        return liftError({ error: "WHOOP rejected the workout shape (422, no details). Nothing was logged.", detail: e.message });
      }
      throw e;
    }
    const activityId = get(receipt, "id");
    if (typeof activityId !== "string") throw new Error("WHOOP accepted the lift but returned no activity id; check the app before retrying.");

    const saved = (get(receipt, "during") as string | undefined) ?? null;
    const savedMs = parseDuring(saved);
    if (savedMs && (savedMs[0] < startMs || savedMs[1] > endMs)) warnings.push(`WHOOP widened the window to ${saved} (requested ${requested}).`);
    const firstPerformed = items.find((it) => it.sets.some((s) => s.performed !== false));
    let verified: boolean;
    if (firstPerformed) {
      verified = await verifyInHistory(client, activityId, firstPerformed, new Date(savedMs?.[0] ?? startMs).toISOString(), firstPerformed.sets.filter((s) => s.performed !== false).length, warnings);
    } else {
      try {
        const d = await client.get(DETAILS_PATH, { activityId }, { fresh: true });
        verified = get(d, "details_edit_components", "activity_type_internal_name") === "weightlifting_msk";
      } catch (e) {
        verified = false;
        warnings.push(`Read-back failed: ${errorMessage(e)}`);
      }
    }
    return respond(TOOL, LiftLogOutV2, {
      action: "logged",
      activity_id: activityId,
      saved_during: saved,
      score_state: (get(receipt, "score_state") as string | undefined) ?? null,
      effective_volume_kg: (get(receipt, "total_effective_volume_kg") as number | undefined) ?? null,
      unit: account,
      converted_from: converted ? unit : null,
      sent_weights: converted ? items.map(({ sets }) => sets.map((s) => sentWeight(s.weight, unit, account))) : null,
      verified,
      warnings,
    });
  });
}
