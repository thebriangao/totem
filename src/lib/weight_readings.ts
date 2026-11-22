// Weight / body-composition reading helpers, ported from PR #35 (@ostiums).
// The app POSTs a ManualMeasurementRequestBody to
// /progression-service/v3/trends/WEIGHT/readings: weight in kg (always kg, whatever
// the display unit), body fat as a FRACTION (0.185), lean mass in kg, and a Joda
// timestamp. WHOOP accepts 0 < weight_kg <= 275 (SPEC.md §4.9).

export const WEIGHT_READINGS_PATH = "/progression-service/v3/trends/WEIGHT/readings";
export const WEIGHT_MAX_KG = 275;

export function round(n: number, digits: number): number {
  return Number(n.toFixed(digits));
}

/** Body fat as WHOOP stores it (fraction, 0.185) → percentage (18.5). */
export function fatFractionToPercent(fraction: number): number {
  return round(fraction * 100, 1);
}

/** Body fat percentage (18.5) → the fraction WHOOP stores (0.185). */
export function fatPercentToFraction(percent: number): number {
  return round(percent / 100, 4);
}

/**
 * ISO-8601 with offset → Joda's `yyyy-MM-dd'T'HH:mm:ss.SSSZ` ("2026-10-13T09:30:00.000+0300"),
 * the form the WHOOP app sends for manual trend readings. Wall clock and offset are kept as given.
 */
export function jodaTimestamp(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/);
  if (!m) throw new Error(`Invalid timestamp "${iso}"; expected an ISO-8601 datetime with an offset.`);
  const [, dateHourMinute, sec = "00", frac = "", zone] = m;
  const ms = frac.padEnd(3, "0").slice(0, 3);
  const offset = zone === "Z" ? "+0000" : zone!.replace(":", "").padEnd(5, "0");
  return `${dateHourMinute}:${sec}.${ms}${offset}`;
}

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
 * follows; given both, they must agree. Sending both matters: the Body Comp
 * trend only plots a day whose latest reading has both.
 */
export function buildMeasurementBody(input: MeasurementInput): MeasurementBody {
  const { weight_kg: weight, body_fat_percent: fatPct, lean_body_mass_kg: givenLean } = input;
  if (!(weight > 0) || weight > WEIGHT_MAX_KG) {
    throw new Error(`Weight must be above 0 and at most ${WEIGHT_MAX_KG} kg (WHOOP's limit); got ${round(weight, 2)} kg.`);
  }
  if (fatPct !== undefined && !(fatPct > 0 && fatPct < 100)) {
    throw new Error(`Body fat must be a percentage between 0 and 100 (e.g. 18.5); got ${fatPct}.`);
  }
  const timestamp = jodaTimestamp(input.timestamp);
  if (givenLean !== undefined && (givenLean <= 0 || givenLean >= weight)) {
    throw new Error(`Lean body mass (${round(givenLean, 2)} kg) must be above 0 and below body weight (${round(weight, 2)} kg).`);
  }
  const leanFromFat = fatPct === undefined ? undefined : round(weight * (1 - fatPct / 100), 2);
  if (leanFromFat !== undefined && givenLean !== undefined && Math.abs(leanFromFat - givenLean) > 0.5) {
    throw new Error(`Body fat ${fatPct}% and lean mass ${round(givenLean, 2)} kg disagree for ${round(weight, 2)} kg (expected lean ≈ ${leanFromFat} kg). Pass one of them.`);
  }
  // 5 decimals: enough to carry an lb conversion or a profile weight (107.95498) exactly.
  const lean = givenLean !== undefined ? round(givenLean, 5) : leanFromFat ?? null;
  const fat = fatPct !== undefined ? fatPercentToFraction(fatPct)
    : lean !== null ? round(1 - lean / weight, 4)
    : null;
  return { timestamp, weight_kg: round(weight, 5), body_fat_percent: fat, lean_body_mass_kg: lean };
}
