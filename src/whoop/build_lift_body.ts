// Build the workout_groups[].workout_exercises[].sets[] body for lift_log + template_save.
// Denormalizes EXERCISES_BY_ID into each workout_exercises[].exercise_details.
import { randomUUID } from "node:crypto";
import { EXERCISES_BY_ID } from "../data/exercises.js";

export interface InputSet {
  reps: number;
  weight?: number | undefined;
  time_seconds?: number | undefined;
  strap_location?: "LEFT" | "RIGHT" | "BOTH" | undefined;
}

export interface InputExercise {
  exercise_id: string;
  sets: InputSet[];
}

export interface BuildResult {
  workout_groups: unknown[];
  set_count: number;
  unknown_exercises: string[];
}

export function setSlots(startMs: number, endMs: number | undefined, n: number): Array<[number, number]> {
  const slot = endMs !== undefined && endMs > startMs ? Math.floor((endMs - startMs) / n) : 100;
  return Array.from({ length: n }, (_, i) => [
    startMs + i * slot,
    endMs !== undefined && endMs > startMs && i === n - 1 ? endMs : startMs + (i + 1) * slot,
  ]);
}

export function buildExerciseGroups(exercises: InputExercise[], startMs: number, endMs?: number): BuildResult {
  const groups: unknown[] = [];
  const unknown: string[] = [];
  const known = exercises.filter((ex) => EXERCISES_BY_ID.has(ex.exercise_id));
  const slots = setSlots(startMs, endMs, known.reduce((n, ex) => n + ex.sets.length, 0));
  let setCount = 0;
  for (const ex of exercises) {
    const meta = EXERCISES_BY_ID.get(ex.exercise_id);
    if (!meta) {
      unknown.push(ex.exercise_id);
      continue;
    }
    const sets = ex.sets.map((s) => {
      const [a, b] = slots[setCount]!;
      const setStart = new Date(a).toISOString();
      const setEnd = new Date(b).toISOString();
      setCount++;
      const baseSet: Record<string, unknown> = {
        during: `['${setStart}','${setEnd}')`,
        msk_total_volume_kg: 0,
        weight: s.weight ?? 0,
        number_of_reps: s.reps,
        strap_location: "1",
        strap_location_laterality: s.strap_location ?? "LEFT",
        weightlifting_workout_set_id: randomUUID().toUpperCase(),
      };
      if (s.time_seconds !== undefined) baseSet.time_in_seconds = s.time_seconds;
      return baseSet;
    });
    groups.push({
      workout_exercises: [
        {
          sets,
          exercise_details: {
            push_core_name: meta.exercise_id,
            name: meta.name,
            muscle_groups: meta.muscle_groups,
            trackable: true,
            // Whoop's POST validates these as non-empty ISO timestamps.
            // The values don't drive any logic on the server side — they reflect
            // when the exercise was added to Whoop's catalog.
            updated_at: "2025-01-01T00:00:00.000Z",
            created_at: "2022-01-01T00:00:00.000Z",
            training_types: [],
            translated_equipment: meta.equipment,
            translated_muscle_groups: meta.primary_muscle,
            translated_movement_pattern: meta.movement_pattern,
            equipment: meta.raw_equipment,
            exercise_id: meta.exercise_id,
            movement_pattern: meta.raw_movement_pattern,
            laterality: meta.laterality,
            deleted: false,
            volume_input_format: "REPS",
            exercise_type: "STRENGTH",
            instructions: [],
          },
        },
      ],
    });
  }
  return { workout_groups: groups, set_count: setCount, unknown_exercises: unknown };
}
