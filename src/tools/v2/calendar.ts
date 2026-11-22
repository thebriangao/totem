// whoop_calendar (v2): GET /home-service/v1/calendar/{pillar}?date=.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { CalendarV2Out } from "../../schemas/v2/calendar.js";
import { CALENDAR_PILLARS, projectCalendarV2 } from "../../projections/v2/calendar.js";

const NAME = "whoop_calendar";

export function registerCalendar(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "Month grid for one pillar. days has one character per day of the month (days[0] = the 1st): H/M/L = high/medium/low, '-' = data " +
        "but no score, '.' = no data. States only, no numbers; use whoop_day for a day's scores.",
      input: {
        date: z.iso.date().optional().describe("Any day in the month"),
        pillar: z.enum(CALENDAR_PILLARS).default("recovery"),
      },
      annotations: READ_ONLY,
    },
    async ({ date, pillar }) => {
      const d = date ?? todayIso();
      const raw = await client.get(`/home-service/v1/calendar/${pillar}`, { date: d });
      return respond(NAME, CalendarV2Out, projectCalendarV2(raw, pillar, d));
    },
  );
}
