// whoop_recovery (v2): deep-dive recovery + today's health monitor, and the
// performance assessment merged in via include (D15).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { wallClockIso } from "../../lib/timezone.js";
import { RecoveryV2Out } from "../../schemas/v2/recovery.js";
import {
  projectAssessment, projectHealthMonitor, projectRecoveryDeepDive, type RecoveryV2,
} from "../../projections/v2/recovery.js";

const NAME = "whoop_recovery";

/** The assessment endpoint wants a timestamp (a plain date 404s); UTC with ms works. */
export function assessmentTimestamp(date: string, isToday: boolean, now: Date = new Date()): string {
  return isToday ? now.toISOString() : new Date(wallClockIso(date, 12, 0)).toISOString();
}

export function registerRecovery(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "Recovery for a cycle day (default today): score, state, calibration progress, and contributors (HRV, RHR, respiratory rate, " +
        "sleep performance) vs your baseline with WHOOP's trend verdict. For today only, the Health Monitor: SpO2 %, skin temperature as a " +
        "°F deviation from baseline (not absolute), RR, RHR, HRV and range statuses. include assessment adds WHOOP's weekly and monthly " +
        "performance assessment: recoveries counted vs required and the assessment windows.",
      input: {
        date: z.iso.date().optional().describe("Cycle day YYYY-MM-DD; defaults to today"),
        include: z.array(z.enum(["assessment"])).optional().describe("Extra sections"),
      },
      annotations: READ_ONLY,
    },
    async ({ date, include }) => {
      const today = todayIso();
      const d = date ?? today;
      const isToday = d === today;
      const ts = assessmentTimestamp(d, isToday);
      const withAssessment = include?.includes("assessment") ?? false;
      const [deepDive, monitor, week, month] = await Promise.all([
        client.get("/home-service/v1/deep-dive/recovery", { date: d }),
        // The monitor has no date parameter: it is today's cycle only.
        isToday ? client.get("/coaching-service/v1/health/bff/monitor").catch(() => null) : null,
        withAssessment ? client.get(`/coaching-service/v1/performance-assessment/WEEK/data/${ts}`).catch(() => null) : null,
        withAssessment ? client.get(`/coaching-service/v1/performance-assessment/MONTH/data/${ts}`).catch(() => null) : null,
      ]);
      const out: RecoveryV2 = { ...projectRecoveryDeepDive(deepDive, d), monitor: projectHealthMonitor(monitor) };
      if (withAssessment) out.assessment = { week: projectAssessment(week), month: projectAssessment(month) };
      return respond(NAME, RecoveryV2Out, out);
    },
  );
}
