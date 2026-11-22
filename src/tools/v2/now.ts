// whoop_now (v2): replaces whoop_live_state, whoop_live_stress and
// whoop_activity_now. whoop_live_hr is dropped: live BPM has no REST source.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { NowV2Out } from "../../schemas/v2/now.js";
import { projectNow } from "../../projections/v2/now.js";

const NAME = "whoop_now";

export function registerNow(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "Live snapshot: activity state (idle, workout, sleep…) with sport and minutes so far, when WHOOP last processed strap data, " +
        "current stress, and today's recovery, sleep, strain, calories and HRV. Never cached. There is no live heart-rate (BPM) source.",
      input: {},
      annotations: READ_ONLY,
    },
    async () => {
      // None of these three paths is cached by the client (freshness-sensitive).
      const [state, stress, widget] = await Promise.all([
        client.get("/activities-service/v1/user-state"),
        client.get(`/health-service/v2/stress-bff/${todayIso()}`).catch(() => null),
        client.get("/home-service/v1/widget/overview", { widgetSize: "MEDIUM" }).catch(() => null),
      ]);
      const fetchedAt = Date.now();
      const projected = projectNow(state, stress, widget, fetchedAt);
      const metricsAt = projected.latest_metrics_at ? Date.parse(projected.latest_metrics_at) : NaN;
      return respond(NAME, NowV2Out, {
        ...projected,
        fetched_at: new Date(fetchedAt).toISOString(),
        // How stale the strap data is (a strap that has not synced for hours makes "now" old).
        metrics_age_min: Number.isFinite(metricsAt) ? Math.max(0, Math.round((fetchedAt - metricsAt) / 60_000)) : null,
      });
    },
  );
}
