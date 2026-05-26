import { z } from "zod";
import { WritePreviewSchema } from "./primitives.js";

export const RawOut = z.union([
  WritePreviewSchema,
  z.object({
    path: z.string(),
    method: z.string(),
    status: z.number().int(),
    response: z.unknown(),
  }),
]);
export type RawOutT = z.infer<typeof RawOut>;

export const EndpointsOut = z.object({
  total_in_catalog: z.number().int(),
  matched: z.number().int(),
  truncated: z.boolean(),
  endpoints: z.array(z.string()),
});
export type EndpointsOutT = z.infer<typeof EndpointsOut>;
