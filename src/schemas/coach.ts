import { z } from "zod";
import { withPreview } from "./primitives.js";

export const CoachAskOut = withPreview(z.object({
  conversation_id: z.string(),
  turn_id: z.string(),
  response_text: z.string().nullable(),
  turn_status: z.string(),
  polled_iterations: z.number().int(),
  timed_out: z.boolean(),
}));
