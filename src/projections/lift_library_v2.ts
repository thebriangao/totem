// whoop_lift_library projections (PR #42 by @chaotix345 fixed the list fields:
// my_workouts_list[].workout_template_key, whoop_workouts_list[].title with string ids).
import { get, parseNumber, str } from "../whoop/bff.js";
import { setScheme } from "./lift_sessions.js";

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** GET /weightlifting-service/v3/workout-library → short rows; AI drafts hidden. */
export function libraryRows(raw: unknown): { my: Array<Array<number | string>>; whoop: Array<Array<number | string | null>> } {
  const my = arr(get(raw, "my_workouts_list"))
    .filter((w) => get(w, "is_draft") !== true && typeof get(w, "workout_template_key") === "number")
    .map((w) => {
      const row: Array<number | string> = [get(w, "workout_template_key") as number, String(get(w, "name") ?? "")];
      if (get(w, "source") === "AI") row.push("AI");
      return row;
    });
  const whoop = arr(get(raw, "whoop_workouts_list"))
    .filter((w) => get(w, "id") !== undefined && get(w, "id") !== null)
    .map((w) => [String(get(w, "id")), String(get(w, "title") ?? ""), parseNumber(get(w, "paragraph"))]);
  return { my, whoop };
}

interface GroupExercise {
  id: string;
  name: string | null;
  timed: boolean;
  sets: Array<{ reps: number | null; weight: number | null; time: number | null }>;
}

/** workout_groups[].workout_exercises[] → exercises (supersets flattened in order). */
export function groupExercises(groups: unknown): GroupExercise[] {
  return arr(groups).flatMap((g) => arr(get(g, "workout_exercises"))).map((we) => {
    const details = get(we, "exercise_details");
    return {
      id: String(get(details, "exercise_id") ?? ""),
      name: str(get(details, "name")),
      timed: get(details, "volume_input_format") === "TIME",
      sets: arr(get(we, "sets")).map((s) => ({
        reps: parseNumber(get(s, "number_of_reps")),
        weight: parseNumber(get(s, "weight")),
        time: parseNumber(get(s, "time_in_seconds")),
      })),
    };
  });
}

/** GET /weightlifting-service/v2/workout-template/{key} → sets as [weight, reps] ([weight, seconds] if timed). */
export function templateDetail(raw: unknown, unit: "kg" | "lb" | null) {
  return {
    key: Number(get(raw, "workout_template_key")),
    name: String(get(raw, "name") ?? ""),
    source: str(get(raw, "source")),
    unit,
    exercises: groupExercises(get(raw, "workout_groups")).map((e) => ({
      id: e.id,
      name: e.name,
      sets: e.sets.map((s) => [s.weight, e.timed ? s.time : s.reps]),
    })),
  };
}

/** GET /weightlifting-service/v2/prebuilt-workout-template/{id} → summary with set schemes (weights are 0). */
export function prebuiltDetail(raw: unknown, id: string) {
  const tiles = arr(get(raw, "prebuilt_template_details_header", "title_metric_tiles"));
  const duration = tiles.find((t) => /DURATION/i.test(String(get(t, "metric_subtitle_display") ?? "")));
  return {
    id,
    title: str(get(raw, "prebuilt_template_details_header", "workout_title_display")) ?? str(get(raw, "workout_template", "name")),
    summary: str(get(raw, "workout_summary_display")),
    minutes: parseNumber(get(duration, "metric_value_display")),
    exercises: groupExercises(get(raw, "workout_template", "workout_groups")).map((e) => ({
      id: e.id,
      name: e.name,
      sets: setScheme(e.sets.map((s) => (e.timed ? s.time : s.reps)), e.timed ? "s" : ""),
    })),
  };
}
