import type { LiftPrsOutT } from "../schemas/strength.js";
import { extractPrTiles, isObject, asArray, asString, asMedal } from "../lib/walk.js";

export function projectLiftPrs(raw: unknown): LiftPrsOutT {
  const tiles = extractPrTiles(raw);
  const rawTiles = isObject(raw) ? asArray((raw as Record<string, unknown>).tiles) : [];
  return tiles.map((t) => {
    const rawTile = rawTiles.find(
      (x) => isObject(x) && (x as Record<string, unknown>).exercise_id === t.exercise_id,
    );
    return {
      exercise_id: t.exercise_id,
      name: t.name,
      muscle_groups: t.muscle_groups,
      equipment: t.equipment,
      pr_value: t.pr_value,
      pr_units: t.pr_units,
      pr_date: isObject(rawTile) ? asString((rawTile as Record<string, unknown>).record_date) : null,
      medal: isObject(rawTile) ? asMedal((rawTile as Record<string, unknown>).achievement_icon) : null,
      custom_exercise: t.custom_exercise,
    };
  });
}
