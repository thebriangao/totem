// Small shared pieces of the v2 strength tool handlers.
import type { ToolResult } from "../tools/define.js";
import { jsonOut } from "../whoop/json_out.js";
import type { WhoopClient } from "../whoop/client.js";
import type { WeightUnit } from "../whoop/units.js";

/** A tool error the model can act on (suggestions, the fix), as isError output. */
export function liftError(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: jsonOut(payload) }], isError: true };
}

/** The display unit for labelling reads (cached bootstrap); null if it can't be read. */
export async function displayUnitForReads(client: WhoopClient): Promise<WeightUnit | null> {
  try {
    const boot = await client.get<{ profile?: { unit_system?: string } }>("/users-service/v2/bootstrap");
    const system = boot?.profile?.unit_system;
    return system === "metric" ? "kg" : system === "imperial" ? "lb" : null;
  } catch {
    return null;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
