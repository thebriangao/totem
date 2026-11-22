// whoop_strain (v2): GET /home-service/v1/deep-dive/strain?date=.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { StrainV2Out } from "../../schemas/v2/strain.js";
import { projectStrainV2 } from "../../projections/v2/strain.js";

const NAME = "whoop_strain";

export function registerStrain(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "Day strain for a cycle day (default today): score (0–21), target and optimal band (null while calibrating), and contributors " +
        "vs your 30-day baseline (minutes in HR zones 1–3 and 4–5, strength training minutes, steps), plus the day's CARDIO activities " +
        "with strain and workouts_count. RECOVERY activities (sauna, meditation…) don't count toward strain and aren't listed; " +
        "see whoop_day.",
      input: { date: z.iso.date().optional().describe("Cycle day YYYY-MM-DD; defaults to today") },
      annotations: READ_ONLY,
    },
    async ({ date }) => {
      const d = date ?? todayIso();
      const raw = await client.get("/home-service/v1/deep-dive/strain", { date: d });
      return respond(NAME, StrainV2Out, projectStrainV2(raw, d));
    },
  );
}
