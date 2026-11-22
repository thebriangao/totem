import { z } from "zod";

export const CalendarV2Out = z.object({
  pillar: z.enum(["recovery", "strain", "sleep"]),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  days: z.string().regex(/^[HML?.-]*$/),
  key: z.record(z.string(), z.string()),
});
