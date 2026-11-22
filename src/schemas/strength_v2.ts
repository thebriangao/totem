// Output schemas for the v2 Strength Trainer tools. Shapes are compact by design
// (BUILD-AGENTS "Token efficiency"): one weight unit stated once per response,
// sets as [weight, reps] rows, short lists as arrays. jsonOut drops null/empty
// properties on the wire, so optional pieces are nullable here.
import { z } from "zod";
import { IsoDateTime } from "./primitives.js";
import { withPreview } from "../whoop/write_safety.js";

const MedalT = z.enum(["GOLD", "SILVER", "BRONZE"]);
const UnitT = z.enum(["kg", "lb"]);
const Warnings = z.array(z.string());
/** [weight, reps] — [weight, seconds] for timed exercises; sessions may append pct_1rm, avg_hr. */
const SetRow = z.array(z.number().nullable());

// ─── whoop_lift_sessions ──────────────────────────────────────────────────
export const SessionExerciseOut = z.object({
  id: z.string(),
  /** "3x5", "5/5/3", "2x300s" for timed exercises, or "skipped". */
  sets: z.string(),
  /** Heaviest set [weight, reps] (rep exercises with weight). */
  top: SetRow.nullable(),
  volume: z.number().nullable(),
  /** Best medal won in this exercise. */
  medal: MedalT.nullable(),
  rows: z.array(SetRow).optional(),
});
export type SessionExerciseOutT = z.infer<typeof SessionExerciseOut>;

export const LiftSessionOut = z.object({
  id: z.string(),
  sport: z.string().nullable(),
  start: IsoDateTime.nullable(),
  end: IsoDateTime.nullable(),
  strain: z.number().nullable(),
  /** details = scored (cardio-details: per-set HR, %1RM); history = unscored (exercise history); none = no sets found. */
  src: z.enum(["details", "history", "none"]),
  volume: z.number().nullable(),
  msk_pct: z.number().nullable(),
  /** Only when it differs from the response's unit. */
  unit: UnitT.nullable(),
  exercises: z.array(SessionExerciseOut),
});
export type LiftSessionOutT = z.infer<typeof LiftSessionOut>;

export const LiftSessionsOut = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  unit: UnitT.nullable(),
  sessions: z.array(LiftSessionOut),
  more: z.boolean(),
  warnings: Warnings,
});
export type LiftSessionsOutT = z.infer<typeof LiftSessionsOut>;

// ─── whoop_lift_exercise ──────────────────────────────────────────────────
export const ExerciseMetaOut = z.object({
  id: z.string(),
  name: z.string(),
  custom: z.boolean(),
  deleted: z.boolean(),
  format: z.string().nullable(),
  e1rm: z.boolean().nullable(),
  trackable: z.boolean().nullable(),
  muscles: z.array(z.string()),
  equipment: z.string().nullable(),
  pattern: z.string().nullable(),
  linked: z.string().nullable(),
  instructions: z.array(z.string()).optional(),
});
export type ExerciseMetaOutT = z.infer<typeof ExerciseMetaOut>;

export const HistorySessionOut = z.object({
  date: z.iso.date().nullable(),
  activity_id: z.string().nullable(),
  sets: z.array(SetRow),
  medal: MedalT.nullable(),
});

export const OneRepMaxOut = z.object({
  value: z.number().nullable(),
  source: z.enum(["estimated", "manual"]).nullable(),
  date: z.iso.date().nullable(),
  /** [date, value, "manual"|"estimated", entry_id?] — entry_id only on manual rows. */
  history: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).optional(),
});
export type OneRepMaxOutT = z.infer<typeof OneRepMaxOut>;

export const ProgressionRowOut = z.object({
  window: z.string(),
  metric: z.string().nullable(),
  value: z.number().nullable(),
  prev: z.number().nullable(),
  change: z.number().nullable(),
  unit: z.string().nullable(),
});

export const LiftExerciseOutV2 = z.union([
  z.object({
    mode: z.literal("prs"),
    cols: z.array(z.string()),
    prs: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
    next: z.string().nullable(),
    warnings: Warnings,
  }),
  z.object({
    mode: z.literal("exercise"),
    exercise: ExerciseMetaOut,
    unit: UnitT.nullable(),
    history: z.object({ sessions: z.array(HistorySessionOut), next: z.string().nullable() }).optional(),
    record_unit: z.string().nullable().optional(),
    records: z.array(z.object({ medal: MedalT.nullable(), date: z.iso.date().nullable(), value: z.number().nullable() })).optional(),
    one_rep_max: OneRepMaxOut.nullable().optional(),
    progression: z.array(ProgressionRowOut).nullable().optional(),
    warnings: Warnings,
  }),
]);

// ─── whoop_lift_library ───────────────────────────────────────────────────
export const LiftLibraryOutV2 = z.object({
  /** [template_key, name] (+ "AI" for coach-made templates). */
  my: z.array(z.array(z.union([z.number(), z.string()]))).optional(),
  /** [prebuilt_id, title, minutes]. */
  whoop: z.array(z.array(z.union([z.number(), z.string(), z.null()]))).optional(),
  template: z.object({
    key: z.number().int(),
    name: z.string(),
    source: z.string().nullable(),
    unit: UnitT.nullable(),
    exercises: z.array(z.object({ id: z.string(), name: z.string().nullable(), sets: z.array(SetRow) })),
  }).optional(),
  prebuilt: z.object({
    id: z.string(),
    title: z.string().nullable(),
    summary: z.string().nullable(),
    minutes: z.number().nullable(),
    exercises: z.array(z.object({ id: z.string(), name: z.string().nullable(), sets: z.string() })),
  }).optional(),
  search: z.object({
    matches: z.array(z.object({ id: z.string(), name: z.string() })),
    more: z.number().int(),
  }).optional(),
  warnings: Warnings,
});
export type LiftLibraryOutV2T = z.infer<typeof LiftLibraryOutV2>;

// ─── Writes ───────────────────────────────────────────────────────────────
export const LiftLogReceipt = z.object({
  action: z.enum(["logged", "attached"]),
  activity_id: z.string(),
  saved_during: z.string().nullable(),
  score_state: z.string().nullable(),
  /** WHOOP's own total_effective_volume_kg (its effective-load formula, not sets x reps x weight). */
  effective_volume_kg: z.number().nullable(),
  /** Unit the weights were sent in (the account's display unit). */
  unit: UnitT,
  converted_from: UnitT.nullable(),
  /** Per exercise, the weights actually sent (only when converted). */
  sent_weights: z.array(z.array(z.number())).nullable(),
  verified: z.boolean(),
  warnings: Warnings,
});
export const LiftLogOutV2 = withPreview(LiftLogReceipt);

export const LiftTemplateReceipt = z.object({
  action: z.enum(["created", "edited", "copied", "deleted"]),
  template_key: z.number().int(),
  name: z.string().nullable(),
  exercises: z.number().int(),
  sets: z.number().int(),
  unit: UnitT.nullable(),
  converted_from: UnitT.nullable(),
  verified: z.boolean(),
  warnings: Warnings,
});
export const LiftTemplateOut = withPreview(LiftTemplateReceipt);

export const LiftExerciseSetReceipt = z.object({
  action: z.enum(["create_custom", "edit_custom", "delete_custom", "set_1rm", "delete_1rm"]),
  exercise_id: z.string(),
  exercise: ExerciseMetaOut.omit({ instructions: true }).nullable(),
  one_rep_max: z.object({
    date: z.iso.date(),
    value: z.number().nullable(),
    unit: UnitT.nullable(),
    entry_id: z.string().nullable(),
  }).nullable(),
  verified: z.boolean(),
  warnings: Warnings,
});
export const LiftExerciseSetOut = withPreview(LiftExerciseSetReceipt);
