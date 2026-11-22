import { WEIGHT_COLUMNS, type WeightPageT, type WeightReadingT } from "../schemas/weight.js";
import { asArray, asNumber, asString, isObject } from "../lib/walk.js";
import { fatFractionToPercent, round } from "../lib/weight_readings.js";

// GET /progression-service/v3/trends/WEIGHT/readings (and …/readings/paginated?next_token=):
// sections.records[] is one entry per month, each with measurements[].content{id,
// weight (display unit), metric_unit ("lbs"|"kg"), source, weight_details_screen{
// timestamp (UTC ms Z), weight_kg, body_fat_percent (FRACTION), lean_body_mass_kg,
// save_title (null = not editable), source}}. Ported from PR #35 (@ostiums).
// `manual_measurement_updates` is the ADD-sheet prefill and holds lb under a `_kg`
// name, so it is never read.

function displayUnit(metricUnit: string | null): "kg" | "lb" | null {
  if (!metricUnit) return null;
  if (/^kg/i.test(metricUnit)) return "kg";
  if (/^lb/i.test(metricUnit)) return "lb";
  return null;
}

export function projectWeightReadings(raw: unknown): WeightPageT {
  const sections = isObject(raw) && isObject(raw.sections) ? raw.sections : {};
  const readings: WeightReadingT[] = [];
  let unit: "kg" | "lb" | null = null;
  for (const month of asArray(sections.records)) {
    for (const m of asArray(isObject(month) ? month.measurements : null)) {
      const content = isObject(m) && isObject(m.content) ? m.content : null;
      const details = content && isObject(content.weight_details_screen) ? content.weight_details_screen : null;
      const id = content ? asString(content.id) : null;
      const timestamp = details ? asString(details.timestamp) : null;
      const weight = asNumber(details?.weight_kg);
      if (!content || !details || !id || !timestamp || weight === null) continue;
      unit ??= displayUnit(asString(content.metric_unit));
      const fat = asNumber(details.body_fat_percent);
      const lean = asNumber(details.lean_body_mass_kg);
      readings.push({
        id,
        timestamp,
        weight_kg: round(weight, 4),
        body_fat_pct: fat === null ? null : fatFractionToPercent(fat),
        fat_fraction: fat === null ? null : round(fat, 4),
        lean_kg: lean === null ? null : round(lean, 4),
        source: asString(details.source ?? content.source),
        editable: details.save_title !== null && details.save_title !== undefined,
      });
    }
  }
  // Newest first: the latest-timestamp reading is the one that sets the profile weight.
  readings.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return { display_unit: unit, readings, next_token: asString(sections.next_token) };
}

/** Compact columnar rows (WEIGHT_COLUMNS order), no key repeated per reading. */
export function weightRows(readings: WeightReadingT[]): Array<Array<string | number | null>> {
  return readings.map((r) => [r.id, r.timestamp, r.weight_kg, r.body_fat_pct, r.lean_kg, r.source]);
}

export { WEIGHT_COLUMNS };
