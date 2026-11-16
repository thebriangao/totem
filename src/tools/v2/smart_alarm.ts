import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { SmartAlarmOut } from "../../schemas/smart_alarm.js";
import { projectSmartAlarm } from "../../projections/smart_alarm.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerSmartAlarm(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_smart_alarm",
    "Smart Alarm server state: recurring schedules plus current preferences. Top-level enabled is the recurring schedule switch; preferences.enabled is the current alarm switch. Inspect preferences.alarm_bounds and day_of_week for the actual date. Server state does not confirm strap delivery or physical vibration.",
    {},
    async () => {
      const [schedules, preferences] = await Promise.all([
        client.get("/smart-alarm-bff/v1/schedule/all"),
        client.get("/smart-alarm-service/v1/smartalarm/preferences").catch(() => null),
      ]);
      const projected = projectSmartAlarm({ schedules, preferences });
      try {
        const out = SmartAlarmOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_smart_alarm", e);
        throw e;
      }
    },
  );
}
