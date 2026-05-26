import type { LiveHrOutT } from "../schemas/live.js";
import { isObject, asNumber, asString, asBool, findByType } from "../lib/walk.js";

export function projectLiveHr(raw: unknown): LiveHrOutT {
  const root = isObject(raw) ? raw : {};
  const showLive = asBool(root.show_live_hr) ?? false;
  const hrTile =
    findByType(root, "LIVE_HR") ??
    findByType(root, "HEART_RATE_LIVE") ??
    findByType(root, "LIVE_HEART_RATE_TILE");
  const bpmRaw = hrTile ? asNumber(hrTile.value ?? hrTile.bpm) : null;
  const bpm = bpmRaw !== null ? Math.round(bpmRaw) : null;
  const zone = hrTile ? asNumber(hrTile.zone) : null;
  return {
    current_bpm: bpm,
    hr_zone: zone !== null && zone >= 0 && zone <= 5 ? zone : null,
    is_recording: bpm !== null && showLive,
    last_updated_at: hrTile ? asString(hrTile.updated_at ?? hrTile.timestamp) : null,
    show_live_hr: showLive,
  };
}
