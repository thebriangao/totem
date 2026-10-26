import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { projectToday } from "../../projections/today.js";
import { projectStrain } from "../../projections/strain.js";
import { projectSleepNeed } from "../../projections/sleep_need.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { DailyBriefOut } from "../../schemas/compact.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { READ_ONLY } from "../annotations.js";

const SECTIONS = ["recovery", "sleep", "strain", "sleep_plan", "activity"] as const;

/** Compact, intent-oriented daily context so a model need not orchestrate 3–5 tools. */
export function registerDailyBrief(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_daily_brief",
    "Compact daily context. Request only the recovery, sleep, strain, sleep_plan, and activity sections needed; avoids heavy timelines and shares source reads.",
    {
      date: z.iso.date().optional().describe("Defaults to today. sleep_plan and activity are available only for today."),
      sections: z.array(z.enum(SECTIONS)).min(1).refine((v) => new Set(v).size === v.length, "sections must not contain duplicates").default(["recovery", "sleep", "strain", "sleep_plan"]),
      detail: z.enum(["compact", "standard"]).default("compact"),
    },
    READ_ONLY,
    async ({ date, sections, detail }) => {
      const d = date ?? todayIso();
      const isToday = d === todayIso();
      if (!isToday && (sections.includes("sleep_plan") || sections.includes("activity"))) {
        return { content: [{ type: "text", text: jsonOut({ error: "sleep_plan and activity are only available for today." }) }], isError: true };
      }
      const coreNeeded = sections.some((section) => ["recovery", "sleep", "activity"].includes(section));
      const [core, strain, sleepPlan] = await Promise.all([
        coreNeeded
          ? Promise.all([
              client.get("/home-service/v1/home", { date: d }),
              client.get("/developer/v2/activity/sleep", { limit: "5" }).catch(() => null),
              client.get("/home-service/v1/deep-dive/recovery", { date: d }).catch(() => null),
              sections.includes("activity") ? client.get("/activities-service/v1/user-state").catch(() => null) : Promise.resolve(null),
            ]).then(([home, sleep, recovery, state]) => projectToday({ home, sleep, recovery, state, date: d }))
          : Promise.resolve(null),
        sections.includes("strain") ? client.get("/home-service/v1/deep-dive/strain", { date: d }).then((raw) => projectStrain(raw, d)) : Promise.resolve(null),
        sections.includes("sleep_plan") ? client.get("/coaching-service/v2/sleepneed").then(projectSleepNeed) : Promise.resolve(null),
      ]);
      const out: Record<string, unknown> = { date: d };
      if (sections.includes("recovery") && core) out.recovery = core.recovery;
      if (sections.includes("sleep") && core) {
        out.sleep = detail === "compact"
          ? { performance_pct: core.sleep.performance_pct, total_sleep_ms: core.sleep.total_sleep_ms, efficiency_pct: core.sleep.efficiency_pct, started_at: core.sleep.started_at, ended_at: core.sleep.ended_at }
          : core.sleep;
      }
      if (sections.includes("activity") && core) out.activity = core.current_state;
      if (sections.includes("strain")) out.strain = strain;
      if (sections.includes("sleep_plan")) out.sleep_plan = sleepPlan;
      try {
        return { content: [{ type: "text", text: jsonOut(DailyBriefOut.parse(out)) }] };
      } catch (error) {
        if (error instanceof z.ZodError) throw new WhoopProjectionError("whoop_daily_brief", error);
        throw error;
      }
    },
  );
}
