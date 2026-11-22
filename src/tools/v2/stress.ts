// whoop_stress (v2): GET /health-service/v2/stress-bff/{date}.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { StressV2Out } from "../../schemas/v2/stress.js";
import { projectStressV2 } from "../../projections/v2/stress.js";

const NAME = "whoop_stress";

export function registerStress(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "Stress Monitor for a day (default today): state, current level (0–3 scale) and label, the day's min and peak, minutes in " +
        "low/medium/high stress, and calibration progress. include timeline adds the mean level per 30 minutes.",
      input: {
        date: z.iso.date().optional().describe("YYYY-MM-DD; defaults to today"),
        include: z.array(z.enum(["timeline"])).optional().describe("Extra sections"),
      },
      annotations: READ_ONLY,
    },
    async ({ date, include }) => {
      const d = date ?? todayIso();
      const raw = await client.get(`/health-service/v2/stress-bff/${d}`);
      return respond(NAME, StressV2Out, projectStressV2(raw, d, include?.includes("timeline") ?? false));
    },
  );
}
