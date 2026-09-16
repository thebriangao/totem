import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { JournalLogOut } from "../../schemas/journal.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { BEHAVIORS, BEHAVIORS_BY_ID, BEHAVIORS_BY_NAME } from "../../data/behaviors.js";
import { isObject, asArray, asNumber, asString, asBool } from "../../lib/walk.js";

// A journal row only renders in the Whoop app when `answered_yes` is true. A
// tracker_input written without it lands server-side with `answered_yes: null`
// — invisible in the app, yet the write returns 200. The bundled catalog marks
// every behavior `magnitude: "bare"`, so gating the request on that field
// rejected `answered_yes`, the magnitude and the time input for behaviors that
// genuinely accept them (Sauna takes 1-300 minutes, Alcohol 1-20 drinks), and
// the resulting entry was silently unreadable to the user.
//
// The live draft is the authority: each tracked behavior carries its real
// `question_type` and `magnitude` spec. Validate against that when it is
// available, default YES_NO behaviors to `true`, and confirm the write by
// reading the day back instead of trusting the status code.

export type LiveSpec = {
  question_type: string | null;
  magnitude: { type: string | null; units: string | null; minimum: number | null; maximum: number | null } | null;
};

export function specsFromDraft(raw: unknown): Map<number, LiveSpec> {
  const specs = new Map<number, LiveSpec>();
  const journal = isObject(raw) && isObject(raw.journal) ? (raw.journal as Record<string, unknown>) : null;
  for (const entry of asArray(journal?.tracked_behaviors)) {
    if (!isObject(entry)) continue;
    const tracker = isObject(entry.behavior_tracker) ? (entry.behavior_tracker as Record<string, unknown>) : null;
    const id = asNumber(tracker?.id);
    if (id === null) continue;
    const magnitude = isObject(tracker?.magnitude) ? (tracker!.magnitude as Record<string, unknown>) : null;
    specs.set(id, {
      question_type: asString(tracker?.question_type),
      magnitude: magnitude
        ? {
            type: asString(magnitude.type),
            units: asString(magnitude.units),
            minimum: asNumber(magnitude.minimum_inclusive),
            maximum: asNumber(magnitude.maximum_inclusive),
          }
        : null,
    });
  }
  return specs;
}

export type ExistingInput = { behavior_tracker_id: number; input: Record<string, unknown> };

export function answeredInputsFromDraft(raw: unknown): ExistingInput[] {
  const kept: ExistingInput[] = [];
  const journal = isObject(raw) && isObject(raw.journal) ? (raw.journal as Record<string, unknown>) : null;
  for (const entry of asArray(journal?.tracked_behaviors)) {
    if (!isObject(entry)) continue;
    const input = isObject(entry.tracker_input) ? (entry.tracker_input as Record<string, unknown>) : null;
    const id = asNumber(input?.behavior_tracker_id);
    if (id === null || input === null) continue;
    if (asBool(input.answered_yes) === null && asNumber(input.magnitude_input_value) === null) continue;
    const carried: Record<string, unknown> = { behavior_tracker_id: id };
    if (asBool(input.answered_yes) !== null) carried.answered_yes = asBool(input.answered_yes);
    if (asNumber(input.magnitude_input_value) !== null) {
      carried.magnitude_input_value = asNumber(input.magnitude_input_value);
      carried.magnitude_input_label = asString(input.magnitude_input_label) ?? String(asNumber(input.magnitude_input_value));
    }
    if (asNumber(input.time_input_value) !== null) carried.time_input_value = asNumber(input.time_input_value);
    kept.push({ behavior_tracker_id: id, input: carried });
  }
  return kept;
}

export function verifyWritten(raw: unknown, sent: Array<Record<string, unknown>>): { verified: boolean; missing: number[] } {
  const written = new Map<number, Record<string, unknown>>();
  for (const existing of answeredInputsFromDraft(raw)) written.set(existing.behavior_tracker_id, existing.input);
  const missing = sent
    .map((input) => Number(input.behavior_tracker_id))
    .filter((id) => {
      const back = written.get(id);
      if (!back) return true;
      const intended = sent.find((s) => Number(s.behavior_tracker_id) === id)!;
      if (intended.answered_yes !== undefined && back.answered_yes !== intended.answered_yes) return true;
      if (intended.magnitude_input_value !== undefined && back.magnitude_input_value !== intended.magnitude_input_value) return true;
      return false;
    });
  return { verified: missing.length === 0, missing };
}

function toEpochSeconds(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.round(parsed / 1000);
}

export function registerJournalLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_journal_log",
    "WRITE: log journal behaviors for a date. A behavior is only visible in the app when it is answered, so YES_NO behaviors default to answered_yes:true. Behaviors that accept a magnitude take magnitude_value (e.g. sauna minutes, alcoholic drinks) and an optional time (ISO datetime or epoch seconds) for 'when did you stop'. Entries already answered on that date are preserved unless replace_day:true. The write is confirmed by reading the day back, not by the status code.",
    {
      date: z.iso.date().optional(),
      behaviors: z.array(z.object({
        behavior_tracker_id: z.number().int().optional(),
        behavior: z.string().optional().describe("Exact behavior title or internal name."),
        answered_yes: z.boolean().optional().describe("Defaults to true — an unanswered row is invisible in the app."),
        magnitude_value: z.number().optional(),
        magnitude_label: z.string().optional(),
        time: z.union([z.string(), z.number()]).optional().describe("ISO datetime or epoch seconds for the behavior's time input."),
      })),
      notes: z.string().optional(),
      replace_day: z.boolean().default(false).describe("Drop every existing answer for the date instead of preserving the ones you did not mention."),
      allow_empty_replace: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    async ({ date, behaviors, notes, replace_day, allow_empty_replace, confirm }) => {
      const d = date ?? todayIso();
      const draftPath = `/journal-service/v3/journals/drafts/mobile/${d}`;
      if (behaviors.length === 0 && !allow_empty_replace) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Refusing to replace a journal with zero behaviors. Set allow_empty_replace:true only when intentional." }) }],
          isError: true,
        };
      }
      const resolved = behaviors.map((behavior) => {
        if (behavior.behavior_tracker_id !== undefined) return { ...behavior, definition: BEHAVIORS_BY_ID.get(behavior.behavior_tracker_id) };
        const name = behavior.behavior?.trim().toLowerCase();
        const definition = name
          ? BEHAVIORS_BY_NAME.get(name) ?? BEHAVIORS.find((b) => b.title.toLowerCase() === name)
          : undefined;
        return { ...behavior, behavior_tracker_id: definition?.behavior_tracker_id, definition };
      });
      const unknown = resolved.filter((b) => !b.definition).map((b) => b.behavior ?? b.behavior_tracker_id);
      if (unknown.length > 0) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Unknown behavior", unknown, hint: "Use whoop_journal_catalog" }) }],
          isError: true,
        };
      }

      const draft = await client.get(draftPath).catch(() => null);
      const specs = specsFromDraft(draft);

      for (const b of resolved) {
        const spec = specs.get(b.behavior_tracker_id!);
        const range = spec?.magnitude;
        if (b.magnitude_value !== undefined && spec && !range) {
          return { content: [{ type: "text", text: jsonOut({ error: `${b.definition!.title} does not take a magnitude.` }) }], isError: true };
        }
        if (b.magnitude_value !== undefined && range && range.minimum !== null && range.maximum !== null
            && (b.magnitude_value < range.minimum || b.magnitude_value > range.maximum)) {
          return {
            content: [{ type: "text", text: jsonOut({ error: `${b.definition!.title} takes ${range.minimum}-${range.maximum} ${range.units ?? "units"}.`, given: b.magnitude_value }) }],
            isError: true,
          };
        }
        if (b.time !== undefined && toEpochSeconds(b.time) === null) {
          return { content: [{ type: "text", text: jsonOut({ error: `Unparseable time for ${b.definition!.title}.`, given: b.time }) }], isError: true };
        }
      }

      const requested = resolved.map((b) => {
        const spec = specs.get(b.behavior_tracker_id!);
        const input: Record<string, unknown> = { behavior_tracker_id: b.behavior_tracker_id };
        // Unanswered rows are invisible in the app, so an explicit log means yes
        // unless the caller says otherwise. Only skipped when the live spec says
        // the behavior asks no yes/no question.
        const answers = spec?.question_type ? spec.question_type === "YES_NO" : true;
        if (b.answered_yes !== undefined) input.answered_yes = b.answered_yes;
        else if (answers) input.answered_yes = true;
        if (b.magnitude_value !== undefined) {
          input.magnitude_input_value = b.magnitude_value;
          input.magnitude_input_label = b.magnitude_label ?? String(b.magnitude_value);
        }
        if (b.time !== undefined) input.time_input_value = toEpochSeconds(b.time);
        return input;
      });

      const requestedIds = new Set(requested.map((i) => Number(i.behavior_tracker_id)));
      const preserved = replace_day
        ? []
        : answeredInputsFromDraft(draft).filter((e) => !requestedIds.has(e.behavior_tracker_id)).map((e) => e.input);
      const tracker_inputs = [...preserved, ...requested];

      const body: Record<string, unknown> = { tracker_inputs };
      if (notes !== undefined) body.notes = notes;
      const path = `/journal-service/v2/journals/entries/user/date/${d}`;
      if (!confirm) {
        return {
          content: [{
            type: "text",
            text: jsonOut(preview("PUT", path, {
              date: d,
              behaviors_count: behaviors.length,
              preserved_count: preserved.length,
              sample_titles: resolved.slice(0, 5).map((b) => b.definition?.title ?? `#${b.behavior_tracker_id}`),
            })),
          }],
        };
      }
      await client.put(path, body);

      // Proof by effect: a 200 does not mean the row is answered. Read the day
      // back and report what actually landed.
      const after = await client.get(draftPath).catch(() => null);
      const { verified, missing } = verifyWritten(after, requested);
      if (!verified) {
        return {
          content: [{
            type: "text",
            text: jsonOut({
              error: "Whoop accepted the write but the journal does not show it. These behaviors are still unanswered server-side.",
              date: d,
              unconfirmed_behavior_tracker_ids: missing,
            }),
          }],
          isError: true,
        };
      }
      const out = JournalLogOut.parse({ logged: true as const, date: d, behaviors_count: behaviors.length, preserved_count: preserved.length, verified: true as const });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
