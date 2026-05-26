import { z } from "zod";

export const ProfileOut = z.object({
  user_id: z.number().int(),
  account_id: z.number().int(),
  email: z.string(),
  username: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  birthday: z.iso.date().nullable(),
  gender: z.string().nullable(),
  height: z.object({
    m: z.number().nullable(),
    cm: z.number().int().nullable(),
    ft: z.number().nullable(),
  }),
  weight: z.object({
    kg: z.number().nullable(),
    lb: z.number().nullable(),
  }),
  city: z.string().nullable(),
  country: z.string().nullable(),
  timezone_offset: z.string(),
  bio_data: z.object({
    max_hr_bpm: z.number().int(),
    resting_hr_bpm: z.number().int(),
    min_hr_bpm: z.number().int().nullable(),
  }),
  fitness_level: z.string().nullable(),
  membership: z.object({
    status: z.string(),
    in_effect: z.boolean(),
  }),
  privacy: z.object({
    stealth_mode: z.boolean(),
    body_comp_hidden: z.boolean(),
    healthspan_hidden: z.boolean(),
  }),
});
export type ProfileOutT = z.infer<typeof ProfileOut>;
