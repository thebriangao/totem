import type { CycleOutT } from "../schemas/womens_health.js";
import { isObject, asArray, asBool, asNumber, asString, findByType } from "../lib/walk.js";

export function projectCycle(raw: unknown, date: string): CycleOutT {
  const root = isObject(raw) ? raw : {};
  const tiles = asArray(root.tiles);
  const phaseTile = tiles.find(
    (t) => isObject(t) && asString((t as Record<string, unknown>).type) === "CYCLE_PHASE_TILE",
  ) as Record<string, unknown> | undefined;
  const modeTile = findByType(root, "HORMONAL_MODE_TILE");

  return {
    date,
    phase: phaseTile ? asString(phaseTile.phase) : null,
    cycle_day: phaseTile ? asNumber(phaseTile.cycle_day) : null,
    cycle_length: phaseTile ? asNumber(phaseTile.cycle_length) : null,
    next_period_predicted_date: phaseTile ? asString(phaseTile.next_period_date) : null,
    ovulation_predicted_date: phaseTile ? asString(phaseTile.ovulation_date) : null,
    hormonal_mode: modeTile ? asString(modeTile.mode) : null,
    contraception_type: modeTile ? asString(modeTile.contraception_type) : null,
    is_pregnant: modeTile ? asBool(modeTile.is_pregnant) : null,
  };
}
