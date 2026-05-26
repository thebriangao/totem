import type { LiveStressOutT } from "../schemas/live.js";
import { projectStress } from "./stress.js";

export function projectLiveStress(raw: unknown): LiveStressOutT {
  const full = projectStress(raw, "1970-01-01");
  return {
    current_level: full.current_level,
    baseline_level: full.baseline_level,
    calibration_state: full.calibration_state,
    last_updated_at:
      full.timeline.length > 0 ? full.timeline[full.timeline.length - 1]!.ended_at : null,
  };
}
