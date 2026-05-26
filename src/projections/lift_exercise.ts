import type { LiftExerciseOutT } from "../schemas/strength.js";
import { ExerciseInfoSchema } from "../whoop/types.js";
import { extractSessions } from "../lib/walk.js";

interface ProjectLiftExerciseInput {
  info: unknown;
  history: unknown;
  prs: unknown;
}

export function projectLiftExercise(input: ProjectLiftExerciseInput): LiftExerciseOutT {
  const info = ExerciseInfoSchema.parse(input.info);
  return {
    exercise: {
      id: info.exercise_id,
      name: info.name,
      muscle_groups: info.muscle_groups,
      equipment: info.equipment,
      movement_pattern: info.movement_pattern,
      laterality: info.laterality,
      custom: info.custom_exercise,
      volume_input_format: info.volume_input_format,
      instructions: info.instructions,
      video_url: info.video_url,
    },
    recent_sessions: extractSessions(input.history),
    personal_records: extractSessions(input.prs),
  };
}
