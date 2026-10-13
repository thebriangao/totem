// Build the ManualMeasurementRequestBody the WHOOP app POSTs to
// /progression-service/v3/trends/WEIGHT/readings (snake_cased on the wire).
import { jodaTimestamp } from "../lib/dates.js";
import { fatPercentToFraction, round } from "../lib/format.js";

export interface MeasurementInput {
  timestamp: string;
  weight_kg: number;
  /** Percentage, e.g. 18.5. */
  body_fat_percent?: number | undefined;
  lean_body_mass_kg?: number | undefined;
}

/** The app's ManualMeasurementRequestBody. */
export interface MeasurementBody {
  timestamp: string;
  weight_kg: number;
  /** Fraction, e.g. 0.185 — the unit WHOOP stores and returns. */
  body_fat_percent: number | null;
  lean_body_mass_kg: number | null;
}

/**
 * Build the request body the app sends. Lean mass is weight minus fat mass
 * (WHOOP's own definition), so given one of body fat / lean mass the other
 * follows; given both, they must agree.
 */
export function buildMeasurementBody(input: MeasurementInput): MeasurementBody {
  const { weight_kg: weight, body_fat_percent: fatPct, lean_body_mass_kg: givenLean } = input;
  const timestamp = jodaTimestamp(input.timestamp);
  if (givenLean !== undefined && givenLean >= weight) {
    throw new Error(`Lean body mass (${givenLean} kg) must be below body weight (${weight} kg).`);
  }
  const leanFromFat = fatPct === undefined ? undefined : round(weight * (1 - fatPct / 100), 2);
  if (leanFromFat !== undefined && givenLean !== undefined && Math.abs(leanFromFat - givenLean) > 0.5) {
    throw new Error(`Body fat ${fatPct}% and lean mass ${givenLean} kg disagree for ${weight} kg (expected lean ≈ ${leanFromFat} kg). Pass one of them.`);
  }
  const lean = givenLean ?? leanFromFat ?? null;
  const fat = fatPct !== undefined ? fatPercentToFraction(fatPct)
    : lean !== null ? round(1 - lean / weight, 4)
    : null;
  return { timestamp, weight_kg: weight, body_fat_percent: fat, lean_body_mass_kg: lean };
}
