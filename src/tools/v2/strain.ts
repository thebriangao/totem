import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { StrainOut } from "../../schemas/strain.js";
import { projectStrain } from "../../projections/strain.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerStrain(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_strain",
    "Day strain deep-dive: score, calories, avg/max HR, time in 6 HR zones, workouts count, steps, strength activity time.",
    { date: z.iso.date().optional() },
    async ({ date }) => {
      const d = date ?? todayIso();
      const raw = await client.get("/home-service/v1/deep-dive/strain", { date: d });
      const projected = projectStrain(raw, d);
      try {
        const out = StrainOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_strain", e);
        throw e;
      }
    },
  );
}
