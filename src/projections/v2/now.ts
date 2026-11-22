// whoop_now: GET /activities-service/v1/user-state, today's stress-bff gauge, and
// GET /home-service/v1/widget/overview (the cheapest score read). There is no
// REST source for live heart rate (it is Bluetooth), so whoop_live_hr is gone.
import { displayNumber, get, isNode, isoInstant, str } from "./core_common.js";

const KNOWN_STATES = ["workout", "sleep", "idle", "recovery"] as const;

export interface NowV2 {
  state: (typeof KNOWN_STATES)[number] | "unknown";
  sport_name: string | null;
  activity_id: string | null;
  started_at: string | null;
  duration_min: number | null;
  tracked_sleep: boolean;
  /** When WHOOP last processed sensor data from the strap (epoch ms on the wire). */
  latest_metrics_at: string | null;
  stress: { level: number | null; label: string | null; state: string | null } | null;
  scores: {
    recovery_pct: number | null;
    sleep_pct: number | null;
    strain: number | null;
    calories: number | null;
    hrv_ms: number | null;
  } | null;
}

export function projectNow(userState: unknown, stress: unknown, widget: unknown, now: number = Date.now()): NowV2 {
  const u = isNode(userState) ? userState : {};
  const raw = str(u.state)?.toLowerCase() ?? "";
  const state = (KNOWN_STATES as readonly string[]).includes(raw) ? (raw as NowV2["state"]) : "unknown";
  const activity = isNode(u.activity) ? u.activity : null;
  const startedAt = isoInstant(u.startAt);
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  return {
    state,
    sport_name: activity ? str(activity.sport_name) : null,
    activity_id: activity ? str(activity.id) : null,
    started_at: startedAt,
    duration_min: state !== "idle" && state !== "unknown" && !Number.isNaN(startMs) ? Math.round((now - startMs) / 60_000) : null,
    tracked_sleep: u.trackedSleep === true,
    latest_metrics_at: isoInstant(u.latestMetricsProcessed),
    stress: isNode(stress)
      ? {
          level: displayNumber(get(stress, "gauge", "gauge_score_display")),
          label: str(get(stress, "gauge", "gauge_subtext_display")),
          state: str(stress.stress_state),
        }
      : null,
    scores: isNode(widget)
      ? {
          recovery_pct: displayNumber(widget.recovery_string),
          sleep_pct: displayNumber(widget.sleep_string),
          strain: displayNumber(widget.strain_string),
          calories: displayNumber(widget.calories_string),
          hrv_ms: displayNumber(widget.hrv_string),
        }
      : null,
  };
}
