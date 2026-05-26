import { z } from "zod";

export const CalendarOut = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  days: z.array(z.object({
    date: z.iso.date(),
    recovery_score: z.number().nullable(),
    recovery_state: z.enum(["GREEN", "YELLOW", "RED"]).nullable(),
    sleep_score: z.number().nullable(),
    day_strain: z.number().nullable(),
  })),
});
export type CalendarOutT = z.infer<typeof CalendarOut>;
