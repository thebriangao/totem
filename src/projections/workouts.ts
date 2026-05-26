import type { WorkoutListOutT } from "../schemas/workouts.js";
import { isObject, asArray, asNumber, asString } from "../lib/walk.js";
import { kjToCal } from "../lib/format.js";

export function projectWorkoutsList(raw: unknown, sportFilter?: string, limit = 10): WorkoutListOutT {
  const root = isObject(raw) ? raw : {};
  const records = asArray(root.records);
  const all = records
    .map((r) => {
      if (!isObject(r)) return null;
      const id = asString(r.id);
      const sportName = asString(r.sport_name);
      const start = asString(r.start);
      const end = asString(r.end);
      if (!id || !sportName || !start || !end) return null;
      const score = isObject(r.score) ? r.score as Record<string, unknown> : {};
      const kj = asNumber(score.kilojoule);
      return {
        id,
        sport_name: sportName,
        start,
        end,
        duration_ms: new Date(end).getTime() - new Date(start).getTime(),
        strain: asNumber(score.strain),
        avg_hr_bpm: asNumber(score.average_heart_rate),
        max_hr_bpm: asNumber(score.max_heart_rate),
        calories: kj !== null ? kjToCal(kj) : null,
        distance_m: asNumber(score.distance_meter),
      };
    })
    .filter((w): w is NonNullable<typeof w> => w !== null);
  const filtered = sportFilter
    ? all.filter((w) => w.sport_name.toLowerCase().includes(sportFilter.toLowerCase()))
    : all;
  return filtered.slice(0, limit);
}
