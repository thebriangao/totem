import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { SleepOut } from "../../schemas/sleep.js";
import { projectSleep } from "../../projections/sleep.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { projectActivitySleepSummary } from "../../projections/today.js";
import { READ_ONLY } from "../annotations.js";

export function registerSleep(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_sleep",
    "Last night's sleep deep-dive: all 4 stages (REM/light/SWS/wake) with durations + percentages, the full per-stage hypnogram, efficiency, performance, consistency, disturbances, and in-sleep heart rate. (Sleep HRV, respiratory rate, debt, and latency aren't exposed by this endpoint and return null.)",
    { date: z.iso.date().optional() },
    READ_ONLY,
    async ({ date }) => {
      const d = date ?? todayIso();
      const [raw, activitySleep] = await Promise.all([
        client.get("/home-service/v1/deep-dive/sleep/last-night", { date: d }),
        // This is WHOOP's scored per-sleep record, the authoritative source
        // for sleep performance. The deep-dive's "Hours vs. Needed" card is a
        // related but distinct, sometimes different metric.
        client.get("/developer/v2/activity/sleep", { limit: "5" }).catch(() => null),
      ]);
      const projected = projectSleep(raw, d);
      const performance = projectActivitySleepSummary(activitySleep, d)?.performance_pct;
      if (performance !== null && performance !== undefined) projected.performance_pct = performance;
      try {
        const out = SleepOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_sleep", e);
        throw e;
      }
    },
  );
}
