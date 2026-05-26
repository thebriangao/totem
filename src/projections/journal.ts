import type { JournalOutT } from "../schemas/journal.js";
import { BEHAVIORS_BY_ID } from "../data/behaviors.js";
import { isObject, asArray, asNumber, asString, asBool } from "../lib/walk.js";

export function projectJournal(raw: unknown, date: string): JournalOutT {
  let inputs: unknown[];
  let cycleId: number | null = null;
  let entryId: string | null = null;
  let notes: string | null = null;

  if (Array.isArray(raw)) {
    inputs = raw;
  } else if (isObject(raw)) {
    const journal = isObject(raw.journal) ? raw.journal as Record<string, unknown> : null;
    if (journal) {
      inputs = asArray(journal.tracked_behaviors);
      cycleId = asNumber(journal.cycle_id);
      entryId = asString(journal.journal_entry_id);
      notes = asString(journal.notes);
    } else {
      inputs = asArray(raw.records ?? raw.tracker_inputs ?? raw.items);
    }
  } else {
    inputs = [];
  }

  const behaviors = inputs
    .map((i) => {
      if (!isObject(i)) return null;
      const id = asNumber(i.behavior_tracker_id ?? i.behavior_id);
      if (id === null) return null;
      const meta = BEHAVIORS_BY_ID.get(id);
      return {
        behavior_tracker_id: id,
        title: meta?.title ?? "",
        category: meta?.category ?? "",
        internal_name: meta?.internal_name ?? "",
        answered_yes: asBool(i.answered_yes),
        magnitude_value: asNumber(i.magnitude_input_value),
        magnitude_label: asString(i.magnitude_input_label),
        recorded_at: asString(i.recorded_at),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  return { date, cycle_id: cycleId, journal_entry_id: entryId, notes, behaviors };
}
