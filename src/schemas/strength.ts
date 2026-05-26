import { z } from "zod";
import { withPreview } from "./primitives.js";

// ─── Catalog row schema (used by src/data/exercises.ts) ─────────────────────
export const OfficialExerciseSchema = z.object({
  exercise_id: z.string(),
  name: z.string(),
  muscle_groups: z.array(z.string()),
  primary_muscle: z.string(),
  equipment: z.string(),
  movement_pattern: z.string(),
  laterality: z.string(),
  raw_equipment: z.string(),
  raw_movement_pattern: z.string(),
});
export type OfficialExercise = z.infer<typeof OfficialExerciseSchema>;

// ─── Set + session primitives ───────────────────────────────────────────────
export const LiftSetSchema = z.object({
  reps: z.number().int(),
  weight: z.number().nullable(),
  units: z.string().nullable(),
  time_seconds: z.number().int().nullable(),
  medal: z.enum(["GOLD", "SILVER", "BRONZE"]).nullable(),
});
export type LiftSetT = z.infer<typeof LiftSetSchema>;

export const LiftSessionSchema = z.object({
  date: z.string(),
  top_set: z.object({
    reps: z.number().int(),
    weight: z.number().nullable(),
    units: z.string().nullable(),
    medal: z.enum(["GOLD", "SILVER", "BRONZE"]).nullable(),
  }),
  sets: z.array(LiftSetSchema),
  total_volume: z.number().nullable(),
  total_volume_units: z.string().nullable(),
  activity_id: z.string().nullable(),
});

// ─── Read tool outputs ──────────────────────────────────────────────────────
export const LiftPrsOut = z.array(z.object({
  exercise_id: z.string(),
  name: z.string(),
  muscle_groups: z.array(z.string()),
  equipment: z.string(),
  pr_value: z.number().nullable(),
  pr_units: z.string().nullable(),
  pr_date: z.string().nullable(),
  medal: z.enum(["GOLD", "SILVER", "BRONZE"]).nullable(),
  custom_exercise: z.boolean(),
}));
export type LiftPrsOutT = z.infer<typeof LiftPrsOut>;

export const LiftExerciseOut = z.object({
  exercise: z.object({
    id: z.string(),
    name: z.string(),
    muscle_groups: z.array(z.string()),
    equipment: z.string(),
    movement_pattern: z.string(),
    laterality: z.string(),
    custom: z.boolean(),
    volume_input_format: z.string(),
    instructions: z.array(z.string()),
    video_url: z.string().nullable(),
  }),
  recent_sessions: z.array(LiftSessionSchema),
  personal_records: z.array(LiftSessionSchema),
});
export type LiftExerciseOutT = z.infer<typeof LiftExerciseOut>;

export const LiftProgressionOut = z.object({
  exercise_id: z.string(),
  end_date: z.iso.date(),
  segments: z.array(z.object({
    label: z.enum(["week", "month", "six_month", "year"]),
    start_date: z.string(),
    end_date: z.string(),
    avg_volume: z.number().nullable(),
    delta_pct: z.number().nullable(),
    unit: z.string().nullable(),
    points: z.array(z.object({
      date: z.string(),
      volume: z.number().nullable(),
      reps: z.number().int().nullable(),
      top_weight: z.number().nullable(),
    })),
  })),
});
export type LiftProgressionOutT = z.infer<typeof LiftProgressionOut>;

export const LiftHistoryOut = z.array(z.object({
  activity_id: z.string(),
  date: z.string(),
  name: z.string().nullable(),
  duration_ms: z.number().int(),
  strain: z.number().nullable(),
  msk_total_volume_kg: z.number().nullable(),
  msk_intensity_pct: z.number().nullable(),
  exercise_count: z.number().int(),
  set_count: z.number().int(),
  // Per-set detail (reps/weight per set) is NOT in /cardio-details — Whoop
  // only exposes aggregate per-exercise. The `sets` array stays empty here;
  // for per-set numbers, call whoop_lift_exercise on a specific exercise_id
  // which uses /v3/exercise/{id}/exercise_history.
  exercises: z.array(z.object({
    exercise_id: z.string(),
    name: z.string().nullable(),
    set_count: z.number().int().nullable(),
    total_reps: z.number().int().nullable(),
    tonnage: z.number().nullable(),
    tonnage_units: z.string().nullable(),
    achievements: z.array(z.string()),
    sets: z.array(LiftSetSchema),
  })),
}));
export type LiftHistoryOutT = z.infer<typeof LiftHistoryOut>;

export const LiftLibraryOut = z.union([
  z.object({
    mode: z.literal("list"),
    my_workouts: z.array(z.object({
      template_id: z.number().int(),
      name: z.string(),
      exercise_count: z.number().int(),
      last_used: z.string().nullable(),
    })),
    whoop_workouts: z.array(z.object({
      template_id: z.number().int(),
      name: z.string(),
      exercise_count: z.number().int(),
    })),
  }),
  z.object({
    mode: z.literal("single"),
    template_id: z.number().int(),
    name: z.string(),
    exercises: z.array(z.object({
      exercise_id: z.string(),
      name: z.string(),
      sets: z.array(z.object({
        reps: z.number().int().nullable(),
        weight: z.number().nullable(),
        time_seconds: z.number().int().nullable(),
      })),
    })),
  }),
]);
export type LiftLibraryOutT = z.infer<typeof LiftLibraryOut>;

export const LiftCatalogOut = z.object({
  total_in_catalog: z.literal(372),
  matched: z.number().int(),
  truncated: z.boolean(),
  exercises: z.array(z.object({
    exercise_id: z.string(),
    name: z.string(),
    muscle_groups: z.array(z.string()),
    primary_muscle: z.string(),
    equipment: z.string(),
    movement_pattern: z.string(),
    laterality: z.string(),
  })),
});
export type LiftCatalogOutT = z.infer<typeof LiftCatalogOut>;

// ─── Write tool outputs ─────────────────────────────────────────────────────
export const LiftLogOut = withPreview(z.object({
  logged: z.literal(true),
  activity_id: z.string(),
  exercise_count: z.number().int(),
  set_count: z.number().int(),
  total_volume_kg: z.number().nullable(),
}));

export const LiftTemplateSaveOut = withPreview(z.object({
  created: z.literal(true),
  template_id: z.number().int(),
  name: z.string(),
  exercise_count: z.number().int(),
}));

export const LiftCustomExerciseOut = withPreview(z.object({
  created: z.literal(true),
  exercise_id: z.string(),
  name: z.string(),
}));
