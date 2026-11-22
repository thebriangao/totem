// whoop_lift_exercise projections: exercise metadata (v1/exercise row or a catalog
// row), the PR list (v3/prs tiles), the one-rep-max card + history, progression,
// and compact history/record rows from the exercise_history cards.
import { byId, byType, get, parseNumber, str, walk, type Node } from "../whoop/bff.js";
import type { ExerciseMetaOutT, OneRepMaxOutT } from "../schemas/strength_v2.js";
import { clockSeconds, displayDate, weightUnit, type LiftCard } from "./lift_cards.js";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** A WHOOP exercise row (v1/exercise/{id}, v2/exercise, or a rebuilt bundle row) → metadata. */
export function exerciseMeta(row: unknown, withInstructions = false): ExerciseMetaOutT {
  const linked = get(row, "custom_exercise_info", "linked_exercise", "exercise_id");
  const meta: ExerciseMetaOutT = {
    id: String(get(row, "exercise_id") ?? ""),
    name: String(get(row, "name") ?? ""),
    custom: get(row, "custom_exercise") === true,
    deleted: get(row, "deleted") === true,
    format: str(get(row, "volume_input_format")),
    e1rm: bool(get(row, "e1rm_eligible")),
    trackable: bool(get(row, "trackable")),
    muscles: strings(get(row, "muscle_groups")),
    equipment: str(get(row, "equipment")),
    pattern: str(get(row, "movement_pattern")),
    linked: typeof linked === "string" ? linked : null,
  };
  if (withInstructions) meta.instructions = strings(get(row, "instructions"));
  return meta;
}

export const PR_COLS = ["id", "name", "value", "unit"];

/**
 * PR pages → [id, name, value, unit] rows, deduped by exercise_id (WHOOP reorders
 * tiles between calls), deleted custom exercises dropped. Units: lb, kg, reps, s.
 * Tiles carry no record date or medal.
 */
export function prRows(pages: unknown[]): Array<Array<string | number | null>> {
  const seen = new Set<string>();
  const out: Array<Array<string | number | null>> = [];
  for (const page of pages) {
    for (const t of (get(page, "tiles") ?? []) as unknown[]) {
      const id = get(t, "exercise_id");
      if (typeof id !== "string" || seen.has(id) || get(t, "deleted") === true) continue;
      seen.add(id);
      const rawValue = str(get(t, "volume_input_value"));
      const rawUnit = str(get(t, "volume_input_units"));
      const isTime = rawUnit === "min";
      out.push([id, String(get(t, "name") ?? ""), isTime ? clockSeconds(rawValue) : parseNumber(rawValue), isTime ? "s" : (weightUnit(rawUnit) ?? rawUnit)]);
    }
  }
  return out;
}

/** A history card → {date, activity_id, sets:[[weight, reps|seconds]], medal}. */
export function historySession(card: LiftCard) {
  return {
    date: card.date,
    activity_id: card.activity_id,
    sets: card.sets.map((s) => [s.weight, s.time_seconds ?? s.reps]),
    medal: card.medal,
  };
}

/** The weight unit the cards use (first one found). */
export function cardsUnit(cards: LiftCard[]): "kg" | "lb" | null {
  for (const c of cards) {
    const u = c.total.unit ?? c.sets.find((s) => s.unit)?.unit;
    if (u) return u;
  }
  return null;
}

function texts(node: unknown): string[] {
  return byType(node, "MARKDOWN_TEXT").map((n) => str(get(n, "content", "text"))).filter((t): t is string => t !== null);
}

/** GET /weightlifting-service/v3/one-rep-max/{id} → value, unit, source, date. */
export function oneRepMaxCard(raw: unknown): Omit<OneRepMaxOutT, "history"> & { unit: "kg" | "lb" | null } {
  const valueRow = texts(byId(raw, "one_rep_max_value_row"));
  const dateRow = texts(byId(raw, "one_rep_max_date_row"));
  const sourceText = dateRow.find((t) => /estimated|manual/i.test(t)) ?? null;
  const value = parseNumber(valueRow[0]);
  return {
    value,
    unit: weightUnit(valueRow[1]) ?? weightUnit(get(byId(raw, "one_rep_max_measurement"), "value_section", "unit")),
    source: sourceText ? (/manual/i.test(sourceText) ? "manual" : "estimated") : null,
    date: value === null ? null : (dateRow.map(displayDate).find((d) => d !== null) ?? null),
  };
}

export interface OneRepMaxEntry {
  key: string;
  source: "manual" | "estimated";
  date: string | null;
  value: number | null;
  entry_id: string | null;
}

/**
 * GET …/one-rep-max/{id}/history → entries. A manual entry's uuid (needed to edit
 * or delete it) appears only inside its EDIT modal (`manual-entry/{uuid}`).
 */
export function oneRepMaxEntries(raw: unknown): OneRepMaxEntry[] {
  const out: OneRepMaxEntry[] = [];
  for (const n of walk(raw)) {
    if (n.type !== "MEASUREMENT_ENTRY_ITEM") continue;
    const c = (n.content ?? {}) as Node;
    const key = str(c.id);
    if (!key) continue;
    const manual = /^MANUAL/i.test(key) || /manual/i.test(String(c.subtitle ?? ""));
    const interaction = JSON.stringify(c.generic_interaction ?? null);
    const entry = interaction.match(/manual-entry\/([0-9a-fA-F-]{8,})/)?.[1] ?? null;
    out.push({
      key,
      source: manual ? "manual" : "estimated",
      date: key.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? displayDate(c.subtitle_suffix),
      value: parseNumber(c.title),
      entry_id: manual ? entry : null,
    });
  }
  return out;
}

/** Entries → [date, value, source, entry_id?] rows. */
export function oneRepMaxRows(entries: OneRepMaxEntry[]): Array<Array<string | number | null>> {
  return entries.map((e) => (e.entry_id ? [e.date, e.value, e.source, e.entry_id] : [e.date, e.value, e.source]));
}

/** GET /progression-service/v3/exercise/{id}?endDate= → one row per window (M, 6M, …). */
export function progressionRows(raw: unknown) {
  const names = strings(get(raw, "segment_controller", "element_names"));
  return ((get(raw, "time_segments") ?? []) as unknown[]).map((s, i) => {
    const m = get(s, "metrics", 0);
    return {
      window: names[i] ?? String(i),
      metric: str(get(m, "metric_name_display")),
      value: parseNumber(get(m, "current_metric_value")) ?? parseNumber(get(m, "metric_value_display")),
      prev: parseNumber(get(m, "previous_metric_value")),
      change: parseNumber(get(m, "metric_change")),
      unit: str(get(m, "metric_units_display")),
    };
  });
}
