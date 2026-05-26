import type { LiftLibraryOutT } from "../schemas/strength.js";
import { isObject, asArray, asNumber, asString } from "../lib/walk.js";

export function projectLibraryList(raw: unknown): LiftLibraryOutT {
  const root = isObject(raw) ? raw : {};
  const my = asArray(root.my_workouts_list)
    .map((w) => {
      if (!isObject(w)) return null;
      const tid = asNumber(w.template_id ?? w.id);
      if (tid === null) return null;
      return {
        template_id: tid,
        name: asString(w.name) ?? "",
        exercise_count: asNumber(w.exercise_count) ?? 0,
        last_used: asString(w.last_used),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const whoop = asArray(root.whoop_workouts_list)
    .map((w) => {
      if (!isObject(w)) return null;
      const tid = asNumber(w.template_id ?? w.id);
      if (tid === null) return null;
      return {
        template_id: tid,
        name: asString(w.name) ?? "",
        exercise_count: asNumber(w.exercise_count) ?? 0,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return { mode: "list" as const, my_workouts: my, whoop_workouts: whoop };
}

export function projectLibrarySingle(raw: unknown): LiftLibraryOutT {
  const root = isObject(raw) ? raw : {};
  const exercises: Array<{
    exercise_id: string;
    name: string;
    sets: { reps: number | null; weight: number | null; time_seconds: number | null }[];
  }> = [];
  for (const g of asArray(root.workout_groups)) {
    if (!isObject(g)) continue;
    for (const we of asArray(g.workout_exercises)) {
      if (!isObject(we)) continue;
      const ex = isObject(we.exercise_details) ? we.exercise_details as Record<string, unknown> : {};
      const sets = asArray(we.sets)
        .map((s) => {
          if (!isObject(s)) return null;
          const t = asNumber(s.time_in_seconds);
          return {
            reps: asNumber(s.number_of_reps),
            weight: asNumber(s.weight),
            time_seconds: t !== null ? Math.round(t) : null,
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);
      exercises.push({
        exercise_id: asString(ex.exercise_id) ?? "",
        name: asString(ex.name) ?? "",
        sets,
      });
    }
  }
  return {
    mode: "single" as const,
    template_id: asNumber(root.workout_template_key ?? root.template_id) ?? 0,
    name: asString(root.name) ?? "",
    exercises,
  };
}
