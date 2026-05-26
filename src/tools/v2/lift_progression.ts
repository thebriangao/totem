import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftProgressionOut } from "../../schemas/strength.js";
import { projectLiftProgression } from "../../projections/lift_progression.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { gateError } from "../../whoop/session_state.js";

export function registerLiftProgression(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_progression",
    "Multi-window volume trend for a single exercise: 30-day, 6-month, year segments with avg volume + change % + per-session points. Requires calling whoop_lift_catalog first.",
    {
      exercise_id: z.string().describe("From whoop_lift_catalog."),
      end_date: z.iso.date().optional(),
    },
    async ({ exercise_id, end_date }) => {
      const gate = gateError("exercises", "whoop_lift_catalog");
      if (gate) return { content: [{ type: "text", text: JSON.stringify(gate, null, 2) }], isError: true };
      const d = end_date ?? todayIso();
      const raw = await client.get(`/progression-service/v3/exercise/${exercise_id}`, { endDate: d });
      const projected = projectLiftProgression(raw, exercise_id, d);
      try {
        const out = LiftProgressionOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_progression", e);
        throw e;
      }
    },
  );
}
