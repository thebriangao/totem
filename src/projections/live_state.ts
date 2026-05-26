import type { LiveStateOutT } from "../schemas/live.js";
import { isObject, asNumber, asString, asBool } from "../lib/walk.js";

const KNOWN_STATES = ["workout", "sleep", "idle", "recovery"] as const;
type KnownState = typeof KNOWN_STATES[number];

export function projectLiveState(raw: unknown): LiveStateOutT {
  const root = isObject(raw) ? raw : {};
  const rawState = asString(root.state)?.toLowerCase();
  const state: LiveStateOutT["state"] =
    rawState && (KNOWN_STATES as readonly string[]).includes(rawState)
      ? (rawState as KnownState)
      : "unknown";
  const activity = isObject(root.activity) ? root.activity as Record<string, unknown> : null;
  const startedAt = asString(root.startAt);
  const durationMs =
    state === "workout" && startedAt ? Date.now() - new Date(startedAt).getTime() : null;
  return {
    state,
    sport_name: activity ? asString(activity.sport_name) : null,
    sport_id: activity ? asNumber(activity.sport_id) : null,
    activity_id: activity ? asString(activity.id) : null,
    started_at: startedAt,
    duration_so_far_ms: durationMs,
    tracked_sleep: asBool(root.trackedSleep) ?? false,
    latest_metrics_at: asString(root.latestMetricsProcessed),
  };
}
