// whoop_lift_exercise_set (W!): replaces whoop_lift_custom_exercise and adds the
// 1RM manual-entry writes (SPEC.md §4.5, §5.3, S13, S20, S22).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { LiftExerciseSetOut } from "../../schemas/strength_v2.js";
import { preview } from "../../whoop/write_safety.js";
import { accountWeightUnit, convertWeight } from "../../whoop/units.js";
import { get } from "../../whoop/bff.js";
import { EXERCISE_FILTER_OPTIONS } from "../../data/exercises.js";
import { todayIso } from "../../lib/dates.js";
import { ExerciseResolver, normalizeName, type ResolvedExercise } from "../../lib/lift_catalog.js";
import { errorMessage, liftError } from "../../lib/lift_tool.js";
import { exerciseMeta, oneRepMaxEntries, type OneRepMaxEntry } from "../../projections/lift_exercise_v2.js";

const TOOL = "whoop_lift_exercise_set";
export const CUSTOM_PATH = "/weightlifting-service/v2/custom-exercise";
const v1Path = (id: string) => `/weightlifting-service/v1/exercise/${encodeURIComponent(id)}`;
export const ormPath = (id: string) => `/weightlifting-service/v3/one-rep-max/${encodeURIComponent(id)}`;
export const manualEntryPath = (entryId: string) => `/weightlifting-service/v3/one-rep-max/manual-entry/${encodeURIComponent(entryId)}`;

const VOLUME_FORMATS = ["WEIGHT", "REPS", "TIME"] as const;
const ORM_MIN = 1;
const ORM_MAX = 999;
/** The history may show a value rounded to a whole number. */
const ORM_SHOWN_TOLERANCE = 0.6;

const CustomIn = z.object({
  name: z.string().min(1).max(100).optional(),
  muscle_groups: z.array(z.enum(EXERCISE_FILTER_OPTIONS.muscle_groups)).min(1).max(8).optional(),
  equipment: z.enum(EXERCISE_FILTER_OPTIONS.equipment).optional(),
  movement_pattern: z.enum(EXERCISE_FILTER_OPTIONS.movement_patterns).optional(),
  volume_input_format: z.enum(VOLUME_FORMATS).optional().describe("How sets are measured."),
  linked_exercise: z.string().optional().describe("Catalog id or name it counts as (tracking, e1RM, muscle load)."),
  instructions: z.array(z.string().max(500)).max(20).optional(),
});

/** Same calendar day six months back ("2026-11-21" → "2026-05-21"), WHOOP's earliest 1RM date. */
export function sixMonthsBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const months = y * 12 + (m - 1) - 6;
  const yy = Math.floor(months / 12);
  const mm = (months % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function receiptExercise(row: unknown) {
  const { instructions: _ignored, ...meta } = exerciseMeta(row);
  return meta;
}

export function registerLiftExerciseSet(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: TOOL,
    description:
      "Custom exercises and 1RM entries. create_custom/edit_custom: `custom` fields; link a catalog exercise or it stays untracked (no e1RM, no muscle load). delete_custom is soft: its PR tile stays. set_1rm: value in `unit` (1–999 in the display unit), date today or up to 6 months back; entry_id edits a manual entry (ids from whoop_lift_exercise history). delete_1rm: entry_id or date. Preview unless confirm:true.",
    input: {
      action: z.enum(["create_custom", "edit_custom", "delete_custom", "set_1rm", "delete_1rm"]),
      exercise_id: z.string().optional().describe("Target exercise (custom UUID for edit/delete)."),
      exercise: z.string().optional().describe("Target by exact name, instead of exercise_id."),
      custom: CustomIn.optional().describe("create_custom/edit_custom fields; edit keeps omitted ones."),
      value: z.number().positive().optional().describe("1RM in `unit`."),
      date: z.iso.date().optional().describe("1RM date; default today."),
      entry_id: z.string().optional().describe("Manual 1RM entry to edit or delete."),
      unit: z.enum(["kg", "lb"]).optional().describe("Unit of `value`; required for set_1rm."),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async ({ action, exercise_id, exercise, custom, value, date, entry_id, unit, confirm }) => {
    const warnings: string[] = [];
    const resolver = new ExerciseResolver(client);
    const target = async (): Promise<ResolvedExercise | ReturnType<typeof liftError>> => {
      if (!exercise_id && !exercise) return liftError({ error: `${action} needs exercise_id or exercise.` });
      const r = await resolver.resolve({ exercise_id, name: exercise });
      return r.ok ? r.exercise : liftError({ error: r.error, suggestions: r.suggestions });
    };

    // ── Custom exercises ──────────────────────────────────────────────────
    if (action === "create_custom" || action === "edit_custom" || action === "delete_custom") {
      if (action !== "delete_custom" && !custom) return liftError({ error: `${action} needs custom fields.` });
      let current: Record<string, unknown> | null = null;
      let id: string;
      if (action === "create_custom") {
        id = randomUUID().toUpperCase();
      } else {
        const t = await target();
        if ("content" in t) return t;
        id = t.exercise_id;
        try {
          current = await client.get<Record<string, unknown>>(v1Path(id), {}, { fresh: true });
        } catch (e) {
          return liftError({ error: `Couldn't read exercise ${id}: ${errorMessage(e)}` });
        }
        if (current?.custom_exercise !== true) return liftError({ error: `${id} is a catalog exercise; only custom exercises can be edited or deleted.` });
        if (current.deleted === true) return liftError({ error: `Custom exercise ${id} is already deleted.` });
      }

      if (action === "delete_custom") {
        if (!confirm) {
          return respond(TOOL, LiftExerciseSetOut, preview("DELETE", `${CUSTOM_PATH}/${id}`, {
            exercise_id: id,
            name: current!.name,
            note: "Soft delete: it leaves the catalog, but its PR tile and past sessions stay.",
          }));
        }
        await client.delete(`${CUSTOM_PATH}/${encodeURIComponent(id)}`);
        let back: unknown = null;
        try {
          back = await client.get(v1Path(id), {}, { fresh: true });
        } catch (e) {
          warnings.push(`Read-back failed: ${errorMessage(e)}`);
        }
        return respond(TOOL, LiftExerciseSetOut, {
          action, exercise_id: id, exercise: back ? receiptExercise(back) : null, one_rep_max: null,
          verified: get(back, "deleted") === true, warnings,
        });
      }

      // create / edit: merge onto the current row (edit) or the linked exercise's defaults.
      let linked: ResolvedExercise | null = null;
      if (custom!.linked_exercise) {
        // Catalog ids are upper-case (BENCHPRESS_BARBELL); anything else is a name.
        const ref = custom!.linked_exercise;
        const r = await resolver.resolve(/^[A-Z0-9_()-]+$/.test(ref) ? { exercise_id: ref } : { name: ref });
        if (!r.ok) return liftError({ error: `linked_exercise: ${r.error}`, suggestions: r.suggestions });
        linked = r.exercise;
        if (linked.custom) return liftError({ error: "linked_exercise must be a catalog exercise, not a custom one." });
      }
      const from = (key: string) => (current ? current[key] : linked ? linked.row[key] : undefined);
      const currentLinked = get(current, "custom_exercise_info", "linked_exercise", "exercise_id");
      const linkId = linked?.exercise_id ?? (typeof currentLinked === "string" ? currentLinked : null);
      const body: Record<string, unknown> = {
        exercise_id: id,
        name: custom!.name ?? from("name") ?? null,
        muscle_groups: custom!.muscle_groups ?? from("muscle_groups") ?? null,
        equipment: custom!.equipment ?? from("equipment") ?? "OTHER",
        movement_pattern: custom!.movement_pattern ?? from("movement_pattern") ?? "OTHER",
        volume_input_format: custom!.volume_input_format ?? from("volume_input_format") ?? null,
      };
      if (action === "create_custom" && !custom!.name) return liftError({ error: "create_custom needs custom.name." });
      if (!Array.isArray(body.muscle_groups) || body.muscle_groups.length === 0) return liftError({ error: "Give custom.muscle_groups (or a linked_exercise to copy them from)." });
      if (!body.volume_input_format) return liftError({ error: "Give custom.volume_input_format (or a linked_exercise to copy it from)." });
      const instructions = custom!.instructions ?? (Array.isArray(current?.instructions) ? current!.instructions : undefined);
      if (instructions) body.instructions = instructions;
      if (linkId) body.custom_exercise_info = { linked_exercise: { exercise_id: linkId } };
      else warnings.push("No linked_exercise: WHOOP stores it as untracked (no e1RM, no muscle-load credit, no PR tracking).");
      if (action === "create_custom") {
        const dupes = (await resolver.customs()).filter((r) => normalizeName(r.name) === normalizeName(String(body.name)));
        if (dupes.length) warnings.push(`You already have a custom exercise named "${body.name}" (${dupes[0]!.exercise_id}).`);
      }

      if (!confirm) return respond(TOOL, LiftExerciseSetOut, preview("POST", CUSTOM_PATH, { ...body, ...(warnings.length ? { warnings } : {}) }));
      await client.post(CUSTOM_PATH, body);
      let back: unknown = null;
      try {
        back = await client.get(v1Path(id), {}, { fresh: true });
      } catch (e) {
        warnings.push(`Read-back failed: ${errorMessage(e)}`);
      }
      const stuck = back !== null
        && get(back, "name") === body.name
        && get(back, "volume_input_format") === body.volume_input_format
        && get(back, "equipment") === body.equipment
        && get(back, "movement_pattern") === body.movement_pattern
        && (!linkId || get(back, "custom_exercise_info", "linked_exercise", "exercise_id") === linkId);
      if (back !== null && !stuck) warnings.push("The exercise read back differently from what was sent.");
      return respond(TOOL, LiftExerciseSetOut, {
        action, exercise_id: id, exercise: back ? receiptExercise(back) : null, one_rep_max: null, verified: stuck, warnings,
      });
    }

    // ── One-rep max ───────────────────────────────────────────────────────
    const t = await target();
    if ("content" in t) return t;
    const id = t.exercise_id;
    const today = todayIso();
    const readEntries = async (): Promise<OneRepMaxEntry[]> => oneRepMaxEntries(await client.get(`${ormPath(id)}/history`, {}, { fresh: true }));

    if (action === "delete_1rm") {
      if (!entry_id && !date) return liftError({ error: "delete_1rm needs entry_id or date." });
      const manual = (await readEntries()).filter((e) => e.source === "manual");
      const entry = manual.find((e) => (entry_id ? e.entry_id === entry_id : e.date === date));
      if (!entry?.entry_id) {
        return liftError({ error: `No manual 1RM entry ${entry_id ?? `on ${date}`} for ${t.name}.`, manual_entries: manual.map((e) => [e.date, e.value, e.unit, e.entry_id]) });
      }
      if (!confirm) {
        return respond(TOOL, LiftExerciseSetOut, preview("DELETE", manualEntryPath(entry.entry_id), {
          exercise: t.name, date: entry.date, value: entry.value, unit: entry.unit, note: "That day's estimate reverts to WHOOP's own.",
        }));
      }
      await client.delete(manualEntryPath(entry.entry_id));
      let gone = false;
      try {
        gone = !(await readEntries()).some((e) => e.entry_id === entry.entry_id);
        if (!gone) warnings.push("The entry still reads back after the delete.");
      } catch (e) {
        warnings.push(`Read-back failed: ${errorMessage(e)}`);
      }
      return respond(TOOL, LiftExerciseSetOut, {
        action, exercise_id: id, exercise: null,
        // WHOOP's own display value, in the unit WHOOP showed it in.
        one_rep_max: { date: entry.date ?? today, value: entry.value, unit: entry.unit, sent_value: null, sent_unit: null, entry_id: entry.entry_id },
        verified: gone, warnings,
      });
    }

    // set_1rm
    if (value === undefined) return liftError({ error: "set_1rm needs value." });
    // No default unit: a bare 225 read as kg on a lb account would be stored as a 496 lb 1RM.
    if (!unit) return liftError({ error: "Say which unit the value is in: unit \"kg\" or \"lb\". Nothing is assumed." });
    const day = date ?? today;
    if (day > today) return liftError({ error: `${day} is in the future; WHOOP refuses future 1RM entries.` });
    const earliest = sixMonthsBefore(today);
    if (day < earliest) return liftError({ error: `${day} is more than 6 months back; the earliest WHOOP accepts is ${earliest}.` });
    if (t.e1rm_eligible === false) warnings.push(`${t.name} isn't e1RM-eligible: WHOOP stores the entry but won't estimate from your lifts.`);

    const entries = await readEntries();
    const manual = entries.filter((e) => e.source === "manual");
    let replacing: OneRepMaxEntry | undefined;
    if (entry_id) {
      replacing = manual.find((e) => e.entry_id === entry_id);
      if (!replacing) return liftError({ error: `No manual 1RM entry ${entry_id} for ${t.name}.`, manual_entries: manual.map((e) => [e.date, e.value, e.unit, e.entry_id]) });
    } else {
      replacing = manual.find((e) => e.date === day);
      if (replacing) warnings.push(`Replaces the manual entry on ${day} (${replacing.value} ${replacing.unit ?? ""}).`.replace(" )", ")"));
    }

    // The display unit is the last read before the write (D2): WHOOP reads the number in it.
    const account = await accountWeightUnit(client);
    const sent = Math.round(convertWeight(value, unit, account) * 10) / 10;
    if (sent < ORM_MIN || sent > ORM_MAX) return liftError({ error: `${sent} ${account} is outside WHOOP's 1RM range (${ORM_MIN}–${ORM_MAX} ${account}).` });
    const converted = unit !== account;
    /** In the caller's unit; what WHOOP received is spelled out only when it differs. */
    const stated = { value, unit, ...(converted ? { sent_value: sent, sent_unit: account } : {}) };
    const body: Record<string, unknown> = { date: day, value: sent };
    if (entry_id) body.id = entry_id;
    if (!confirm) {
      return respond(TOOL, LiftExerciseSetOut, preview("PUT", ormPath(id), {
        exercise: t.name, date: day, ...stated,
        ...(entry_id ? { id: entry_id } : {}),
        ...(replacing ? { replaces: [replacing.date, replacing.value, replacing.unit] } : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
    }
    await client.put(ormPath(id), body);
    let entryAfter: OneRepMaxEntry | undefined;
    try {
      entryAfter = (await readEntries()).find((e) => e.source === "manual" && e.date === day && (!entry_id || e.entry_id === entry_id));
      if (!entryAfter) warnings.push(`No manual entry on ${day} reads back.`);
    } catch (e) {
      warnings.push(`Read-back failed: ${errorMessage(e)}`);
    }
    // Compare in the unit WHOOP shows the entry in: the same number under another unit is a different weight.
    const shownUnit = entryAfter?.unit ?? account;
    const verified = entryAfter !== undefined && entryAfter.value !== null
      && Math.abs(entryAfter.value - convertWeight(sent, account, shownUnit)) <= ORM_SHOWN_TOLERANCE;
    if (entryAfter && !verified) {
      warnings.push(`The entry reads back as ${entryAfter.value} ${shownUnit}, but ${sent} ${account} was sent. If the unit differs, the account's unit changed during the write: fix the entry in the app or set it again.`);
    }
    return respond(TOOL, LiftExerciseSetOut, {
      action, exercise_id: id, exercise: null,
      one_rep_max: { date: day, value, unit, sent_value: converted ? sent : null, sent_unit: converted ? account : null, entry_id: entryAfter?.entry_id ?? null },
      verified, warnings,
    });
  });
}
