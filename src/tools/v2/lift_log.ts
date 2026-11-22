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
import { findHistoryCard, weightMismatch } from "../../lib/lift_history.js";
import { readActivityAs } from "../../lib/activity_records.js";
import { overlappingTiles } from "../../lib/activity_list.js";
import { setScheme } from "../../projections/lift_sessions.js";

const TOOL = "whoop_lift_log";
export const LIFT_PATH = "/weightlifting-service/v2/weightlifting-workout/activity";
export const LINK_PATH = "/weightlifting-service/v2/weightlifting-workout/link-cardio-workout";
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

/** Per exercise, what will be logged: weights as the caller gave them, plus `sent` (the account's unit) when converted. */
function sessionSummary(items: ExerciseSets[], units: { input: WeightUnit; account: WeightUnit }) {
  return items.map(({ exercise, sets }) => {
    const timed = exercise.volume_input_format === "TIME";
    const performed = sets.filter((s) => s.performed !== false);
    return {
      id: exercise.exercise_id,
      name: exercise.name,
      sets: setScheme(performed.map((s) => (timed ? (s.time_seconds ?? null) : (s.reps ?? null))), timed ? "s" : ""),
      weights: performed.map((s) => s.weight ?? 0),
      ...(units.input !== units.account ? { sent: performed.map((s) => sentWeight(s.weight, units.input, units.account)) } : {}),
      ...(performed.length < sets.length ? { skipped: sets.length - performed.length } : {}),
    };
  });
}

/**
 * Does the first exercise's history (fresh, paged, retried while WHOOP catches
 * up) show this activity with the weights that were sent? History is the only
 * read that shows a lift's sets with their unit, so this is the check that
 * catches a weight WHOOP read in another unit than the one it was converted to.
 */
async function verifyInHistory(
  client: WhoopClient,
  activityId: string,
  item: ExerciseSets | undefined,
  notBefore: string | undefined,
  sent: { weights: number[]; unit: WeightUnit },
  warnings: string[],
): Promise<boolean> {
  if (!item) return false;
  const name = item.exercise.name;
  try {
    const card = await findHistoryCard(client, item.exercise.exercise_id, activityId, notBefore);
    if (!card) {
      // History lags; the raw activity record answers at once and says whether the write landed at all.
      const record = await readActivityAs(client, activityId, "CARDIO").catch(() => null);
      warnings.push(record
        ? `The activity exists, but ${name}'s history doesn't show its sets yet (WHOOP can lag ~30 s), so the weights are unconfirmed. Don't log it again; check whoop_lift_exercise history.`
        : `${name}'s history doesn't show this activity yet (WHOOP can lag ~30 s); check whoop_lift_exercise history before logging again.`);
      return false;
    }
    let ok = true;
    if (card.sets.length !== sent.weights.length) {
      warnings.push(`${name}: history shows ${card.sets.length} sets, ${sent.weights.length} were sent.`);
      ok = false;
    }
    const off = weightMismatch(card, sent.weights, sent.unit);
    if (off) {
      warnings.push(`${name}: WHOOP shows ${off.shown.join("/")} ${off.unit} where ${off.expected.join("/")} ${off.unit} was sent. The account's weight unit may have changed during the write: delete activity ${activityId} (whoop_activity_delete) and log it again.`);
      ok = false;
    }
    return ok;
  } catch (e) {
    warnings.push(`Read-back failed: ${errorMessage(e)}`);
    return false;
  }
}

export function registerLiftLog(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: TOOL,
    description:
      "Log a finished strength workout as a new Strength Trainer activity, or attach the sets to an existing activity (attach_to_activity_id; permanent: WHOOP has no unlink). Weights are converted from `unit` to the account's display unit. Sets are spread across start–end. Refuses a window that overlaps another activity (WHOOP 409s such a lift yet keeps its sets, undeletable): pick another window or delete that activity with whoop_activity_delete. Refuses 0-rep weighted sets (WHOOP would award a permanent PR). Preview unless confirm:true.",
    input: {
      exercises: z.array(ExerciseIn).min(1).max(30),
      unit: z.enum(["kg", "lb"]).optional().describe("Unit of the weights you give; required when any set has weight."),
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
    // No default unit: a bare 225 read as kg on a lb account logs 496 lb and a PR that can't be removed.
    if (!unit && exercises.some((e) => e.sets.some((s) => (s.weight ?? 0) > 0))) {
      return liftError({ error: "Say which unit the weights are in: unit \"kg\" or \"lb\". Nothing is assumed." });
    }
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
    const refuseZeroRep = (sets: ReturnType<typeof zeroRepWeightedSets>) => liftError({
      error: "Sets with weight and 0 reps are refused: WHOOP awards them a weight PR that can't be removed.",
      sets,
      fix: "Log only completed reps, or leave missed attempts out.",
    });
    const zeroRep = zeroRepWeightedSets(exercises.map((e) => ({ label: e.exercise_id ?? e.name ?? "?", sets: e.sets })));
    if (zeroRep.length > 0) return refuseZeroRep(zeroRep);

    // 2. Fresh pre-reads: exercise rows (sent verbatim), display unit, attach target.
    const resolution = await new ExerciseResolver(client).resolveAll(exercises);
    if (!resolution.ok) return liftError({ error: "Unknown exercise(s).", misses: resolution.misses });
    const items: ExerciseSets[] = resolution.exercises.map((exercise, i) => ({ exercise, sets: exercises[i]!.sets }));
    // Again now that the exercises are known: time_seconds only excuses 0 reps on a timed exercise.
    const zeroRepResolved = zeroRepWeightedSets(items.map(({ exercise, sets }) => ({ label: exercise.name, sets, timed: exercise.volume_input_format === "TIME" })));
    if (zeroRepResolved.length > 0) return refuseZeroRep(zeroRepResolved);
    const problems = setShapeProblems(items);
    if (problems.length > 0) return liftError({ error: "Some sets don't fit their exercise.", problems });
    // A new lift must not be sent into an occupied window. WHOOP answers 409 and creates
    // no activity, but it keeps the workout: live 2026-11-21, all seven 409'd lifts left
    // their sets in exercise history with no activity to delete them through, where they
    // win medals, set the PR tile and feed e1RM. This is a refusal, not PR #40's
    // replace_overlapping (D6): nothing is deleted.
    if (window) {
      const clash = await overlappingTiles(client, new Date(window.startMs).toISOString(), new Date(window.endMs).toISOString());
      if (clash.tiles.length > 0) {
        return liftError({
          error: "The window overlaps an existing activity, so nothing was sent. (WHOOP refuses an overlapping lift with a 409 yet keeps its sets in exercise history, where they can't be deleted.)",
          overlaps: clash.tiles.map((t) => ({ activity_id: t.activity_id, type: t.internal_name, start: t.start, end: t.end })),
          fix: "Pick a window that doesn't overlap, or delete the other activity with whoop_activity_delete first.",
        });
      }
      if (!clash.complete) {
        return liftError({ error: "Couldn't read the day's activities to rule out an overlap, so nothing was sent: WHOOP keeps an overlapping lift's sets with no way to delete them. Try again." });
      }
    }

    // The attach target: the raw record answers in every state; cardio-details (the
    // fallback) 400s for the first seconds after a create, and the link still works then.
    let target: Awaited<ReturnType<typeof readActivityAs>> = null;
    if (attach) {
      try {
        target = await readActivityAs(client, attach, "CARDIO");
        if (!target) return liftError({ error: `No activity ${attach}.` });
      } catch (e) {
        if (!(e instanceof WhoopApiError && e.status === 400)) return liftError({ error: `Couldn't read activity ${attach}: ${errorMessage(e)}` });
        warnings.push("The activity's details aren't readable yet (pending), so its sport and time aren't shown.");
      }
    }

    // The display unit is the last read before the write (D2): WHOOP reads the
    // numbers in whatever unit the account shows at that moment.
    const account = await accountWeightUnit(client);
    const units = { input: unit ?? account, account };
    const converted = units.input !== account;
    const sentWeights = (sets: ExerciseSets["sets"]) => sets.map((s) => sentWeight(s.weight, units.input, account));
    /** Receipt fields: `unit` is the caller's; what WHOOP received is spelled out only when it differs. */
    const unitFields = {
      unit: units.input,
      sent_unit: converted ? account : null,
      sent_weights: converted ? items.map(({ sets }) => sentWeights(sets)) : null,
    };

    if (attach) {
      const sport = target?.type ?? null;
      const tz = liftTimezone();
      const activityStart = target?.start ?? null;
      const linkName = name ?? (activityStart ? isoDay(new Date(activityStart)) : isoDay());
      const body = {
        activity_id: attach,
        rpe: rpe ?? 0,
        template_id: -1,
        template: { name: linkName, source: "USER", workout_template_key: -1, workout_groups: buildTemplateGroups(items, units) },
      };
      if (!confirm) {
        return respond(TOOL, LiftLogOutV2, preview("POST", LINK_PATH, {
          attach_to: { activity_id: attach, sport, start: activityStart ? localTime(Date.parse(activityStart), tz) : null },
          exercises: sessionSummary(items, units),
          unit: units.input,
          ...(converted ? { sent_unit: account } : {}),
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
      const notBefore = linkedStart !== undefined ? new Date(linkedStart).toISOString() : (activityStart ?? undefined);
      const verified = await verifyInHistory(client, attach, items[0], notBefore, { weights: sentWeights(items[0]!.sets), unit: account }, warnings);
      return respond(TOOL, LiftLogOutV2, {
        action: "attached",
        activity_id: attach,
        saved_during: (get(meta, "during") as string | undefined) ?? null,
        score_state: (get(meta, "score_state") as string | undefined) ?? null,
        effective_volume_kg: (get(meta, "total_effective_volume_kg") as number | undefined) ?? null,
        ...unitFields,
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
        unit: units.input,
        ...(converted ? { sent_unit: account } : {}),
        ...(rpe !== undefined ? { rpe } : {}),
      }));
    }

    let receipt: unknown;
    try {
      receipt = await client.post(LIFT_PATH, body);
    } catch (e) {
      if (e instanceof WhoopConflictError) {
        return liftError({
          error: "WHOOP refused the lift (409): the window overlaps an activity the pre-check didn't see. No activity was created, but WHOOP keeps the sets: they now show in each exercise's history without an activity, count toward PRs and e1RM, and can't be deleted. Don't send these sets again unless you mean to log them twice.",
          during: requested,
          fix: "Find the overlapping activity (whoop_workouts for that day), then pick a clear window or delete it with whoop_activity_delete.",
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
      const performed = firstPerformed.sets.filter((s) => s.performed !== false);
      verified = await verifyInHistory(client, activityId, firstPerformed, new Date(savedMs?.[0] ?? startMs).toISOString(), { weights: sentWeights(performed), unit: account }, warnings);
    } else {
      // Nothing performed, so nothing reaches history. The raw activity record answers in
      // every state; cardio-details 400s for the first seconds after a create.
      try {
        verified = (await readActivityAs(client, activityId, "CARDIO"))?.type === "weightlifting_msk";
        if (!verified) warnings.push("The new activity doesn't read back as a Strength Trainer workout.");
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
      ...unitFields,
      verified,
      warnings,
    });
  });
}
