import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { BADGE_COLUMNS, MilestonesOut } from "../../schemas/milestones.js";
import {
  nearestBadges,
  projectDataStreak,
  projectMilestoneDetail,
  projectMilestonesHub,
  topBadges,
} from "../../projections/milestones.js";
import { toolError } from "../../lib/health_plans_write.js";
import { WhoopApiError } from "../../whoop/errors.js";

const BFF = "/milestones-service/v1/bff/milestones";
const strip = ({ tag: _tag, ...b }: { tag: string; type: string; name: string | null; count: number | null; status: string | null }) => b;

export function registerMilestones(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_milestones",
    description:
      "Milestone badges and the wear streak. Default: totals (total / unique / rare), the data streak (days, started, max, this week), top earned badges and the closest unearned ones. " +
      "include:[\"badges\"] adds every badge as rows (sleep, recovery, strain, healthspan, other, activities). milestone_type returns one badge's detail: count, progress to the next level, levels earned with dates.",
    input: {
      milestone_type: z.string().regex(/^[A-Z0-9_]+$/).optional().describe("e.g. HIGH_STRAIN (types come from the badge list)."),
      include: z.array(z.enum(["badges"])).default([]).describe("badges: the full badge list."),
    },
    annotations: READ_ONLY,
  }, async ({ milestone_type, include }) => {
    if (milestone_type) {
      try {
        const raw = await client.get(`${BFF}/${milestone_type}/details`);
        return respond("whoop_milestones", MilestonesOut, projectMilestoneDetail(raw, milestone_type));
      } catch (error) {
        if (error instanceof WhoopApiError && error.status === 400) {
          return toolError(`WHOOP doesn't know milestone type ${milestone_type}. Call whoop_milestones with include:["badges"] for the types.`);
        }
        throw error;
      }
    }
    const [hub, streak] = await Promise.all([
      client.get(`${BFF}/hub`),
      client.get("/streaks-service/v1/bff/streaks/data-streak").catch(() => null),
    ]);
    const { totals, badges } = projectMilestonesHub(hub);
    return respond("whoop_milestones", MilestonesOut, {
      totals,
      streak: streak === null ? null : projectDataStreak(streak),
      top: topBadges(badges).map(strip),
      in_progress: nearestBadges(badges).map(strip),
      ...((include ?? []).includes("badges")
        ? { badges: { columns: [...BADGE_COLUMNS], rows: badges.map((b) => [b.type, b.tag, b.name, b.count, b.status]) } }
        : {}),
    });
  });
}
