import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CalendarOut } from "../../schemas/calendar.js";
import { projectCalendar } from "../../projections/calendar.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerCalendar(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_calendar",
    "Per-day recovery/sleep/strain scores for the month containing the given date.",
    {
      date: z.iso.date().optional().describe("Any date in the target month. Defaults to today."),
    },
    async ({ date }) => {
      const d = date ?? todayIso();
      const [overview, recovery] = await Promise.all([
        client.get("/home-service/v1/calendar/overview", { date: d }),
        client.get("/home-service/v1/calendar/recovery", { date: d }).catch(() => null),
      ]);
      const projected = projectCalendar({ overview, recovery, date: d });
      try {
        const out = CalendarOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_calendar", e);
        throw e;
      }
    },
  );
}
