import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CalendarOut } from "../../schemas/calendar.js";
import { projectCalendar } from "../../projections/calendar.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { READ_ONLY } from "../annotations.js";

export function registerCalendar(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_calendar",
    "Month-at-a-glance calendar grid for the month containing the given date: each day's recovery STATE — GREEN (high), YELLOW (medium), or RED (low). The grid only exposes the state, not numeric recovery/sleep/strain scores; for a specific day's numbers use whoop_day.",
    {
      date: z.iso.date().optional().describe("Any date in the target month. Defaults to today."),
    },
    READ_ONLY,
    async ({ date }) => {
      const d = date ?? todayIso();
      // Both endpoints contain the same state grid. Prefer recovery and only
      // pay for overview when that endpoint is unavailable.
      let recovery: unknown = null;
      let overview: unknown = null;
      try {
        recovery = await client.get("/home-service/v1/calendar/recovery", { date: d });
      } catch {
        overview = await client.get("/home-service/v1/calendar/overview", { date: d });
      }
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
