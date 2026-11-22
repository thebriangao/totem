// whoop_now (v2): replaces whoop_live_state, whoop_live_stress, whoop_activity_now
// and whoop_live_hr. The heart rate is the newest reading WHOOP's servers hold,
// which is as fresh as the strap's last sync (true live BPM is Bluetooth only).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { NowV2Out } from "../../schemas/v2/now.js";
import { projectNow } from "../../projections/v2/now.js";
import { accountUserId, readHeartRate } from "../../lib/heart_rate.js";
import { latestHr } from "../../projections/v2/heart_rate.js";

/**
 * The newest reading sits right at the moment WHOOP last processed strap data,
 * so a few minutes around that are enough. With no such moment (a strap that
 * never synced), look at the last quarter of an hour.
 */
async function newestHeartRate(client: WhoopClient, latestMetricsAt: string | null, now: number): Promise<{ bpm: number; at: string } | null> {
  const anchor = latestMetricsAt ? Date.parse(latestMetricsAt) : NaN;
  const [from, to] = Number.isFinite(anchor) ? [anchor - 3 * 60_000, anchor + 30_000] : [now - 15 * 60_000, now];
  return latestHr(await readHeartRate(client, from, to, 6));
}

const NAME = "whoop_now";

export function registerNow(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "Live snapshot: activity state (idle, workout, sleep…) with sport and minutes so far, when WHOOP last processed strap data and " +
        "the heart rate at that moment, current stress, and today's recovery, sleep, strain, calories and HRV.",
      input: {},
      annotations: READ_ONLY,
    },
    async () => {
      // Warm the user id the heart-rate read needs while the snapshot loads.
      accountUserId(client).catch(() => undefined);
      // None of these three paths is cached by the client (freshness-sensitive).
      const [state, stress, widget] = await Promise.all([
        client.get("/activities-service/v1/user-state"),
        client.get(`/health-service/v2/stress-bff/${todayIso()}`).catch(() => null),
        client.get("/home-service/v1/widget/overview", { widgetSize: "MEDIUM" }).catch(() => null),
      ]);
      const fetchedAt = Date.now();
      const projected = projectNow(state, stress, widget, fetchedAt);
      // Optional on purpose: the snapshot must not fail because the series could not be read.
      const hr = await newestHeartRate(client, projected.latest_metrics_at, fetchedAt).catch(() => null);
      const metricsAt = projected.latest_metrics_at ? Date.parse(projected.latest_metrics_at) : NaN;
      return respond(NAME, NowV2Out, {
        ...projected,
        hr,
        fetched_at: new Date(fetchedAt).toISOString(),
        // How stale the strap data is (a strap that has not synced for hours makes "now" old).
        metrics_age_min: Number.isFinite(metricsAt) ? Math.max(0, Math.round((fetchedAt - metricsAt) / 60_000)) : null,
      });
    },
  );
}
