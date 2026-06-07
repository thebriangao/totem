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
      // The v3 drafts endpoint nests each logged behavior as
      //   { behavior_tracker: { id, title, ... }, tracker_input: { behavior_tracker_id,
      //     answered_yes, magnitude_input_value, magnitude_input_label, ... } }
      // The flat shape (the v2 write body, and older captures) puts those fields
      // directly on the entry. Read whichever exists — missing this nesting is why
      // every behavior was being dropped and `behaviors` came back empty (issue #2).
      const input = isObject(i.tracker_input) ? (i.tracker_input as Record<string, unknown>) : i;
      const tracker = isObject(i.behavior_tracker) ? (i.behavior_tracker as Record<string, unknown>) : null;
      const id = asNumber(input.behavior_tracker_id ?? (tracker ? tracker.id : undefined) ?? i.behavior_id);
      if (id === null) return null;
      const meta = BEHAVIORS_BY_ID.get(id);
      return {
        behavior_tracker_id: id,
        title: meta?.title ?? asString(tracker?.title) ?? "",
        category: meta?.category ?? asString(tracker?.category) ?? "",
        internal_name: meta?.internal_name ?? asString(tracker?.internal_name) ?? "",
        answered_yes: asBool(input.answered_yes),
        magnitude_value: asNumber(input.magnitude_input_value),
        magnitude_label: asString(input.magnitude_input_label),
        recorded_at: asString(input.recorded_at),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  return { date, cycle_id: cycleId, journal_entry_id: entryId, notes, behaviors };
}
