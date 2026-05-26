import { z } from "zod";

// ─── Exercise info (clean /v1/exercise/{id}) ──────────────────────────────
export const ExerciseInfoSchema = z.object({
  exercise_id: z.string(),
  name: z.string(),
  muscle_groups: z.array(z.string()),
  translated_muscle_groups: z.string(),
  equipment: z.string(),
  translated_equipment: z.string(),
  exercise_type: z.string(),
  laterality: z.string(),
  movement_pattern: z.string(),
  translated_movement_pattern: z.string(),
  instructions: z.array(z.string()),
  image_url: z.string().nullable(),
  video_url: z.string().nullable(),
  volume_input_format: z.string(),
  custom_exercise: z.boolean(),
  deleted: z.boolean(),
  trackable: z.boolean(),
});
export type ExerciseInfo = z.infer<typeof ExerciseInfoSchema>;

// ─── User bootstrap ───────────────────────────────────────────────────────
export const BootstrapSchema = z.object({
  account: z.object({
    id: z.number(),
    username: z.string(),
    email: z.string(),
    type: z.string(),
    user_id: z.number(),
  }),
  user: z.object({
    id: z.number(),
    first_name: z.string(),
    last_name: z.string(),
    country: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
  }),
  profile: z
    .object({
      user_id: z.number(),
      height: z.number().nullable(),
      weight: z.number().nullable(),
      gender: z.string().nullable(),
      unit_system: z.string(),
      fitness_level: z.string().nullable().optional(),
      birthday: z.string().nullable().optional(),
      timezone_offset: z.string(),
    })
    .nullable()
    .optional(),
  bio_data: z
    .object({
      max_heart_rate: z.number(),
      min_heart_rate: z.number().nullable().optional(),
      resting_heart_rate: z.number(),
      recovery_count: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  membership: z.object({
    status: z.string(),
    in_effect: z.boolean(),
  }),
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;

// ─── Journal draft (current journal entry for a date) ─────────────────────
export const JournalDraftSchema = z.object({
  integrations: z.unknown().nullable(),
  journal: z.object({
    tracked_behaviors: z.array(
      z.object({
        behavior_id: z.string(),
        value: z.unknown(),
        recorded_at: z.string().optional(),
      }),
    ),
    user_id: z.number(),
    cycle_id: z.number(),
    journal_entry_id: z.string().nullable(),
    notes: z.string().nullable(),
    user_reviewed: z.boolean().nullable(),
  }),
  metadata: z.unknown(),
});
export type JournalDraft = z.infer<typeof JournalDraftSchema>;
