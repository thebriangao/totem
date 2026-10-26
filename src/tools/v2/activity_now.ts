import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { projectLiveHr } from "../../projections/live_hr.js";
import { projectLiveState } from "../../projections/live_state.js";
import { projectLiveStress } from "../../projections/live_stress.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { ActivityNowOut } from "../../schemas/compact.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { READ_ONLY } from "../annotations.js";

const FIELDS = ["state", "heart_rate", "stress"] as const;

function liveFreshness(sourceUpdatedAt: string | null): {
  fetched_at: string;
  source_updated_at: string | null;
  source_age_ms: number | null;
  completed_cache: "bypassed";
} {
  const fetchedAt = new Date();
  const sourceMs = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : NaN;
  return {
    fetched_at: fetchedAt.toISOString(),
    source_updated_at: sourceUpdatedAt,
    source_age_ms: Number.isFinite(sourceMs) ? Math.max(0, fetchedAt.getTime() - sourceMs) : null,
    completed_cache: "bypassed",
  };
}

export function registerActivityNow(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_activity_now",
    "Fresh live activity snapshot. Select state, heart_rate, and/or stress; no completed live value is cached.",
    { include: z.array(z.enum(FIELDS)).min(1).refine((v) => new Set(v).size === v.length, "include must not contain duplicates").default(["state"]) },
    READ_ONLY,
    async ({ include }) => {
      const date = todayIso();
      const [state, heartRate, stress] = await Promise.all([
        include.includes("state") ? client.get("/activities-service/v1/user-state").then(projectLiveState) : Promise.resolve(null),
        include.includes("heart_rate") ? client.get("/health-tab-bff/v1/health-tab").then(projectLiveHr) : Promise.resolve(null),
        include.includes("stress") ? client.get(`/health-service/v2/stress-bff/${date}`).then((raw) => projectLiveStress(raw, date)) : Promise.resolve(null),
      ]);
      const out = {
        state: state ? { ...state, freshness: liveFreshness(state.latest_metrics_at) } : null,
        heart_rate: heartRate ? { ...heartRate, freshness: liveFreshness(heartRate.last_updated_at) } : null,
        stress: stress ? { ...stress, freshness: liveFreshness(stress.last_updated_at) } : null,
      };
      try {
        return { content: [{ type: "text", text: jsonOut(ActivityNowOut.parse(out)) }] };
      } catch (error) {
        if (error instanceof z.ZodError) throw new WhoopProjectionError("whoop_activity_now", error);
        throw error;
      }
    },
  );
}
