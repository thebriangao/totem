// Set building for the v2 lift writes (whoop_lift_log, whoop_lift_template).
// Set timing, the 0-rep guard and the requested/saved window come from PR #40 by
// @chaotix345; units follow SPEC.md D2 (weights are read in the account's display
// unit at write time).
import { randomUUID } from "node:crypto";
import { canonicalUtc, parsePgRange } from "./dates.js";
import { convertWeight, type WeightUnit } from "../whoop/units.js";
import type { ResolvedExercise } from "./lift_catalog.js";

export interface SetInput {
  reps?: number | undefined;
  weight?: number | undefined;
  time_seconds?: number | undefined;
  performed?: boolean | undefined;
}

export interface ExerciseSets {
  exercise: ResolvedExercise;
  sets: SetInput[];
}

/**
 * Split [start, end) into n back-to-back set slots, the last ending exactly at
 * `end`, so the saved window (WHOOP keeps the union of `during` and every set's
 * `during`) is exactly the requested one.
 */
export function setSlots(startMs: number, endMs: number, n: number): Array<[number, number]> {
  if (n <= 0) return [];
  const slot = Math.floor((endMs - startMs) / n);
  return Array.from({ length: n }, (_, i) => [startMs + i * slot, i === n - 1 ? endMs : startMs + (i + 1) * slot]);
}

export function duringLiteral(startMs: number, endMs: number): string {
  return `['${canonicalUtc(startMs)}','${canonicalUtc(endMs)}')`;
}

/** "['a','b')" → [ms, ms], or null. */
export function parseDuring(during: unknown): [number, number] | null {
  if (typeof during !== "string") return null;
  try {
    const r = parsePgRange(during);
    const a = Date.parse(r.start);
    const b = r.end ? Date.parse(r.end) : NaN;
    return Number.isNaN(a) || Number.isNaN(b) ? null : [a, b];
  } catch {
    return null;
  }
}

/**
 * Sets with weight but 0 reps. WHOOP awards a weight PR for them (a 0×300 set
 * won a permanent gold PR, and `v3/prs` tiles survive deleting the activity), so
 * they are refused. Only a timed exercise may carry weight with no reps (a
 * weighted hold): pass `timed` once the exercise is resolved. While it is
 * unknown, a set with time_seconds gets the benefit of the doubt.
 */
export function zeroRepWeightedSets(items: Array<{ label: string; sets: SetInput[]; timed?: boolean }>): Array<{ exercise: string; set_number: number; weight: number }> {
  const bad: Array<{ exercise: string; set_number: number; weight: number }> = [];
  for (const it of items) {
    it.sets.forEach((s, i) => {
      const timedSet = it.timed !== false && Boolean(s.time_seconds);
      if ((s.reps ?? 0) === 0 && (s.weight ?? 0) > 0 && !timedSet) bad.push({ exercise: it.label, set_number: i + 1, weight: s.weight! });
    });
  }
  return bad;
}

/** Shape problems a model can fix: TIME exercises need time_seconds, the others need reps. */
export function setShapeProblems(items: ExerciseSets[]): string[] {
  const problems: string[] = [];
  for (const { exercise, sets } of items) {
    const time = exercise.volume_input_format === "TIME";
    sets.forEach((s, i) => {
      if (time && !(s.time_seconds && s.time_seconds > 0)) problems.push(`${exercise.name} is timed: set ${i + 1} needs time_seconds.`);
      if (!time && s.reps === undefined) problems.push(`${exercise.name}: set ${i + 1} needs reps.`);
    });
  }
  return problems;
}

/** Weight in the input unit → the account's display unit (WHOOP reads it that way). */
export function sentWeight(weight: number | undefined, input: WeightUnit, account: WeightUnit): number {
  return weight === undefined ? 0 : convertWeight(weight, input, account);
}

/**
 * workout_groups for POST /weightlifting-service/v2/weightlifting-workout/activity.
 * Performed sets get a slot of the window; `performed:false` sets carry no
 * `during` (WHOOP's "not performed": no volume, absent from history).
 */
export function buildActivityGroups(
  items: ExerciseSets[],
  window: { startMs: number; endMs: number },
  units: { input: WeightUnit; account: WeightUnit },
  uuid: () => string = () => randomUUID().toUpperCase(),
): { workout_groups: unknown[]; performed_sets: number; slots: Array<[number, number]> } {
  const performed = items.reduce((n, it) => n + it.sets.filter((s) => s.performed !== false).length, 0);
  const slots = setSlots(window.startMs, window.endMs, performed);
  let k = 0;
  const workout_groups = items.map(({ exercise, sets }) => ({
    workout_exercises: [{
      exercise_details: exercise.row,
      sets: sets.map((s) => {
        const set: Record<string, unknown> = {
          weightlifting_workout_set_id: uuid(),
          number_of_reps: s.reps ?? 0,
          weight: sentWeight(s.weight, units.input, units.account),
        };
        if (s.time_seconds !== undefined) set.time_in_seconds = s.time_seconds;
        if (s.performed !== false) {
          const [a, b] = slots[k++]!;
          set.during = duringLiteral(a, b);
        }
        return set;
      }),
    }],
  }));
  return { workout_groups, performed_sets: performed, slots };
}

/**
 * workout_groups for templates and link-cardio-workout: sets carry only
 * {number_of_reps, weight, time_in_seconds} (WHOOP drops anything else).
 */
export function buildTemplateGroups(items: ExerciseSets[], units: { input: WeightUnit; account: WeightUnit }): unknown[] {
  return items.map(({ exercise, sets }) => ({
    workout_exercises: [{
      exercise_details: exercise.row,
      sets: sets.map((s) => {
        const set: Record<string, unknown> = {
          number_of_reps: s.reps ?? 0,
          weight: sentWeight(s.weight, units.input, units.account),
        };
        if (s.time_seconds !== undefined) set.time_in_seconds = s.time_seconds;
        return set;
      }),
    }],
  }));
}

function isIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * The IANA zone sent with a lift. WHOOP_TIMEZONE when it is an IANA name (cloud
 * hosts run in UTC), else the system zone, else UTC. Never a bare offset.
 */
export function liftTimezone(): string {
  const env = process.env.WHOOP_TIMEZONE;
  if (env && env.includes("/") && isIana(env)) return env;
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isIana(system) ? system : "UTC";
}

/** "2026-11-21 09:00:00" in the given zone. */
export function localTime(ms: number, timezone: string): string {
  return new Date(ms).toLocaleString("sv-SE", { timeZone: timezone });
}
