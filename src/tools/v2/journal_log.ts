// whoop_journal_log (W!): write journal answers (SPEC.md §4.6, D3, §7 S10).
//
// Default path: PUT /journal-service/v2/journal/entry/partial. It merges across
// rows, never touches notes, and takes several dates at once. The full PUT
// (/journals/entries/user/date/{date}) replaces the whole day and nulls notes
// it isn't sent, so it's used only for replace_day or notes, and then always
// carries the current notes and answers from a fresh draft read (PR #44's
// guard: no draft, no full PUT; a 404 counts as no draft). Every write is read
// back: one 204 was seen not to land while cycles were being reshuffled.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond, type ToolResult } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { JournalLogV2Out } from "../../schemas/journal_v2.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { runPaced } from "../../lib/concurrency.js";
import { projectBehaviorToggles } from "../../projections/settings_v2.js";
import {
  answeredById,
  buildRow,
  carryRow,
  isAnswered,
  isDraftBody,
  loadBehaviorCatalog,
  parseDraft,
  resolveBehavior,
  splitMenstruationOvulation,
  type BehaviorSpec,
  type DraftDay,
  type TrackerRow,
} from "../../lib/journal_behaviors.js";

const NAME = "whoop_journal_log";
const DRAFT = (d: string) => `/journal-service/v3/journals/drafts/mobile/${d}`;
const PARTIAL = "/journal-service/v2/journal/entry/partial";
const FULL = (d: string) => `/journal-service/v2/journals/entries/user/date/${d}`;
const CUSTOMIZE = "/journal-service/v3/journals/behaviors";

function fail(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: jsonOut({ error, ...extra }) }], isError: true };
}

const BehaviorInput = z.object({
  id: z.number().int().optional().describe("behavior_tracker_id (see whoop_journal include:[catalog])."),
  name: z.string().optional().describe("Exact behaviour title or internal name, e.g. Caffeine."),
  answered_yes: z.boolean().optional().describe("Default true: unanswered rows are invisible in the app."),
  magnitude: z.number().nullable().optional().describe("Range: a number in range. Step: the choice value. null clears it."),
  magnitude_label: z.string().optional().describe("Step behaviours: the choice label (e.g. Moderate) instead of the value."),
  time: z.union([z.string(), z.number()]).nullable().optional().describe("ISO datetime or epoch seconds, if the behaviour asks a time. null clears it."),
});

interface PlannedRow {
  date: string;
  spec: BehaviorSpec;
  row: TrackerRow;
  action: "set" | "unset";
  carried: string[];
}

const iso = (secs: number | undefined) => (secs === undefined ? null : new Date(secs * 1000).toISOString());

/** Drop null/empty fields (previews go out as-is). */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))) as Partial<T>;
}

export function registerJournalLog(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "WRITE: log journal answers. Default is a merge (partial PUT): only the listed behaviours change; notes and other answers stay. WHOOP replaces a row whole, so a yes row keeps its stored magnitude/time unless you pass new ones (null clears). behaviors[]: id or name (custom ones too), answered_yes (default true), magnitude (range number, or step value/label), time. unset[] clears answers. notes or replace_day:true rewrite the whole day (one date), keeping current notes/answers unless replaced. Read back after writing; preview unless confirm:true.",
    input: {
      date: z.iso.date().optional().describe("YYYY-MM-DD, default today. Past or today only."),
      dates: z.array(z.iso.date()).min(1).max(7).optional().describe("Several dates at once (merge writes only)."),
      behaviors: z.array(BehaviorInput).default([]),
      unset: z.array(z.union([z.number().int(), z.string()])).optional().describe("Ids or names whose answer to clear."),
      notes: z.string().optional().describe("Replaces the day's notes (\"\" clears them). Uses the full-day PUT."),
      replace_day: z.boolean().optional().describe("Drop every answer not listed here. Notes are kept unless passed."),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async ({ date, dates, behaviors, unset, notes, replace_day, confirm }) => {
    // 1. Validate the request shape before touching WHOOP.
    if (date !== undefined && dates !== undefined) return fail("Pass date or dates, not both.");
    const today = todayIso();
    const dateList = [...new Set(dates ?? [date ?? today])].sort();
    const future = dateList.filter((d) => d > today);
    if (future.length > 0) return fail(`Journal dates can't be in the future (today is ${today}): ${future.join(", ")}.`);
    const full = replace_day === true || notes !== undefined;
    if (full && dateList.length > 1) return fail("notes and replace_day rewrite one day at a time; pass a single date.");
    const unsetRefs = unset ?? [];
    if (behaviors.length === 0 && unsetRefs.length === 0 && notes === undefined && replace_day !== true) {
      return fail("Nothing to write: pass behaviors, unset, notes or replace_day.");
    }

    // 2. Resolve every behaviour against the live catalog (171 and customs included).
    const catalog = await loadBehaviorCatalog(client, dateList[0]!);
    const warnings: string[] = catalog.warning ? [catalog.warning] : [];
    const errors: Array<{ error: string; suggestions?: Array<{ id: number; title: string }> }> = [];
    const resolved: Array<{ spec: BehaviorSpec; input: z.infer<typeof BehaviorInput> }> = [];
    for (const b of behaviors) {
      const r = resolveBehavior({ id: b.id, name: b.name }, catalog);
      if (r.ok) resolved.push({ spec: r.spec, input: b });
      else errors.push({ error: r.error, suggestions: r.suggestions });
    }
    const unsetSpecs: BehaviorSpec[] = [];
    for (const ref of unsetRefs) {
      const asId = typeof ref === "number" ? ref : /^\d+$/.test(ref.trim()) ? Number(ref) : undefined;
      const r = resolveBehavior(asId !== undefined ? { id: asId } : { name: String(ref) }, catalog);
      if (r.ok) unsetSpecs.push(r.spec);
      else errors.push({ error: r.error, suggestions: r.suggestions });
    }
    if (errors.length > 0) return fail("Some behaviours couldn't be resolved; nothing was written.", { problems: errors });
    const ids = resolved.map((r) => r.spec.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) return fail(`Behaviour listed twice: ${[...new Set(dupes)].join(", ")}.`);
    const clash = unsetSpecs.filter((s) => ids.includes(s.id));
    if (clash.length > 0) return fail(`Can't both set and unset: ${clash.map((s) => s.title).join(", ")}.`);
    for (const { spec } of resolved) {
      if (spec.tracked === false) {
        warnings.push(`${spec.title} isn't in your tracked behaviours, so the app won't show it until you track it (whoop_preferences_set setting:tracked_behaviors).`);
      }
    }

    // 3. Fresh draft pre-read: "before" values for the preview, stored magnitude/time
    //    to carry, and (full PUT) the notes and answers that must be re-sent.
    //    WHOOP answers 200 for every date (an empty day is `tracked_behaviors: []`),
    //    so a 404 or a body without the journal is a failed read, never "empty day".
    const drafts = new Map<string, DraftDay | null>();
    const readErrors: string[] = [];
    await runPaced(dateList.map((d) => async () => {
      try {
        const raw = await client.get(DRAFT(d), {}, { fresh: true });
        if (!isDraftBody(raw)) throw new Error("unexpected journal response");
        drafts.set(d, parseDraft(raw, d));
      } catch (e) {
        drafts.set(d, null);
        readErrors.push(`${d}: ${(e as Error).message}`);
      }
    }), { concurrency: 3 });
    if (full && drafts.get(dateList[0]!) === null) {
      return fail(
        `Couldn't read the current journal for ${dateList[0]}, so a full-day write could erase its notes or other answers. Nothing was written. Retry, or drop notes/replace_day to merge instead.`,
        { detail: readErrors.join("; ") },
      );
    }
    if (readErrors.length > 0) {
      // A merge replaces each listed row whole. Without the draft, a stored
      // magnitude or time the caller didn't spell out would be erased.
      const atRisk = resolved.filter(({ spec, input }) =>
        (input.answered_yes ?? true) && (
          (spec.magnitude !== null && input.magnitude === undefined && input.magnitude_label === undefined) ||
          (spec.time_label !== null && input.time === undefined)
        ));
      if (atRisk.length > 0) {
        return fail(
          `Couldn't read the current journal, and WHOOP replaces a row whole: a stored magnitude or time for ${atRisk.map((r) => r.spec.title).join(", ")} would be erased. Nothing was written. Retry, or pass magnitude and time explicitly (null clears them).`,
          { detail: readErrors.join("; ") },
        );
      }
      warnings.push(`Couldn't read the current journal first (${readErrors.join("; ")}), so there are no before-values.`);
    }

    // 4. Build rows per date.
    const planned: PlannedRow[] = [];
    const rowErrors = new Set<string>();
    for (const d of dateList) {
      const stored = drafts.get(d) ? answeredById(drafts.get(d)!) : new Map();
      for (const { spec, input } of resolved) {
        const built = buildRow(spec, input, stored.get(spec.id)?.input ?? null);
        if ("error" in built) rowErrors.add(built.error);
        else planned.push({ date: d, spec, row: built.row, action: "set", carried: built.carried });
      }
      for (const spec of unsetSpecs) {
        planned.push({ date: d, spec, row: { behavior_tracker_id: spec.id }, action: "unset", carried: [] });
      }
    }
    if (rowErrors.size > 0) return fail("Some answers don't fit their behaviour; nothing was written.", { problems: [...rowErrors] });

    // 5. Compose the request(s).
    type Req = { path: string; body: unknown };
    const requests: Req[] = [];
    let notesPlan: { before: string | null; send: string | null } | null = null;
    const removed: Array<{ date: string; id: number; title: string }> = [];
    let keptCount = 0;
    if (!full) {
      const byDate = new Map<string, TrackerRow[]>();
      for (const p of planned) byDate.set(p.date, [...(byDate.get(p.date) ?? []), p.row]);
      const split = splitMenstruationOvulation(byDate);
      for (const part of split) {
        const tracker_inputs: Record<string, { tracker_input_eggs: TrackerRow[] }> = {};
        for (const [d, rows] of part) if (rows.length > 0) tracker_inputs[d] = { tracker_input_eggs: rows };
        if (Object.keys(tracker_inputs).length > 0) requests.push({ path: PARTIAL, body: { tracker_inputs } });
      }
      if (requests.length > 1) warnings.push("Menstruation and ovulation went in separate requests: WHOOP refuses both as yes in one request.");
    } else {
      const d = dateList[0]!;
      const day = drafts.get(d) ?? parseDraft({}, d);
      const touched = new Set(planned.map((p) => p.spec.id));
      const stored = answeredById(day);
      const kept: TrackerRow[] = [];
      for (const [id, row] of stored) {
        if (touched.has(id)) continue;
        if (replace_day) removed.push({ date: d, id, title: row.spec.title });
        else kept.push(carryRow(row));
      }
      keptCount = kept.length;
      // Unset rows are simply left out: the full PUT deletes what it isn't sent.
      const tracker_inputs = [...kept, ...planned.filter((p) => p.action === "set").map((p) => p.row)];
      const send = notes !== undefined ? notes : day.notes;
      notesPlan = { before: day.notes, send };
      requests.push({ path: FULL(d), body: send === null ? { tracker_inputs } : { tracker_inputs, notes: send } });
      // WHOOP leaves an untracked custom behaviour's answers out of the draft, so
      // they can't be re-sent, and the full PUT deletes what it isn't sent
      // (verified live: gone after re-tracking; kept when no full PUT ran).
      const hidden = await client.get(CUSTOMIZE, {}, { fresh: true })
        .then((raw) => projectBehaviorToggles(raw).toggles.filter((t) => t.custom && !t.selected).map((t) => t.title ?? `#${t.id}`))
        .catch(() => [] as string[]);
      if (hidden.length > 0) {
        warnings.push(`You have untracked custom behaviours (${hidden.join(", ")}). WHOOP hides their answers from the day, so a full-day write can't keep them: any answer they have on ${d} will be deleted. Track them first to keep those answers.`);
      }
    }

    const multi = dateList.length > 1;
    const rowsOut = planned.map((p) => ({
      date: multi ? p.date : null,
      id: p.spec.id,
      name: p.spec.title,
      yes: p.action === "unset" ? null : p.row.answered_yes ?? null,
      value: p.row.magnitude_input_value ?? null,
      label: p.spec.magnitude?.type === "step" ? p.row.magnitude_input_label ?? null : null,
      time: iso(p.row.time_input_value),
      unset: p.action === "unset" ? true as const : null,
      carried: p.carried,
    }));

    // 6. Preview: what changes, against what is stored now.
    if (!confirm) {
      const before = (p: PlannedRow) => {
        const s = drafts.get(p.date) ? answeredById(drafts.get(p.date)!).get(p.spec.id)?.input : undefined;
        if (!s) return null;
        return [s.answered_yes, s.magnitude_input_value, iso(s.time_input_value ?? undefined)].filter((v) => v !== null);
      };
      return respond(NAME, JournalLogV2Out, preview("PUT", requests[0]!.path, {
        method: full ? "full: replaces the whole day" : "partial: merge",
        ...(requests.length > 1 ? { requests: requests.length } : {}),
        dates: dateList,
        changes: planned.map((p, i) => ({ ...compact(rowsOut[i]!), before: before(p) })),
        ...(full
          ? { notes: { before: notesPlan!.before, after: notesPlan!.send === "" ? null : notesPlan!.send }, other_answers_kept: keptCount, removes: removed.map((r) => r.title) }
          : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      }));
    }

    // 7. Send. A failure after the first request leaves a partial write: say so.
    let sent = 0;
    for (const req of requests) {
      try {
        await client.put(req.path, req.body);
        sent++;
      } catch (e) {
        if (sent === 0) throw e;
        return fail(`Request ${sent + 1} of ${requests.length} failed after the first was applied; re-read the journal before retrying.`, {
          detail: (e as Error).message,
          rows: rowsOut,
        });
      }
    }

    // 8. Fresh read-back: report what actually stuck, not the 204.
    const mismatches: Array<{ date: string; id: number | null; field: string; expected: string | number | boolean | null; actual: string | number | boolean | null }> = [];
    const after = new Map<string, DraftDay | null>();
    await runPaced(dateList.map((d) => async () => {
      after.set(d, await client.get(DRAFT(d), {}, { fresh: true }).then((raw) => parseDraft(raw, d)).catch(() => null));
    }), { concurrency: 3 });
    let verified = true;
    for (const d of dateList) {
      const day = after.get(d);
      if (!day) {
        verified = false;
        warnings.push(`Couldn't read ${d} back to verify the write.`);
        continue;
      }
      const back = answeredById(day);
      for (const p of planned.filter((x) => x.date === d)) {
        const got = back.get(p.spec.id)?.input;
        if (p.action === "unset") {
          if (isAnswered(got ?? null)) mismatches.push({ date: d, id: p.spec.id, field: "answered_yes", expected: null, actual: got!.answered_yes });
          continue;
        }
        const check = (field: string, expected: number | boolean | null, actual: number | boolean | null) => {
          const same = typeof expected === "number" && typeof actual === "number" ? Math.abs(expected - actual) < 1e-6 : expected === actual;
          if (!same) mismatches.push({ date: d, id: p.spec.id, field, expected, actual });
        };
        check("answered_yes", p.row.answered_yes ?? null, got?.answered_yes ?? null);
        // WHOOP replaces a row whole, so a field that wasn't sent (cleared with
        // null, or dropped by answered_yes:false) must read back empty too.
        check("magnitude", p.row.magnitude_input_value ?? null, got?.magnitude_input_value ?? null);
        check("time", p.row.time_input_value ?? null, got?.time_input_value ?? null);
      }
      if (full) {
        const expectNotes = notesPlan!.send === "" ? null : notesPlan!.send;
        if (day.notes !== expectNotes) mismatches.push({ date: d, id: null, field: "notes", expected: expectNotes, actual: day.notes });
        for (const r of removed) {
          if (back.has(r.id)) mismatches.push({ date: d, id: r.id, field: "answered_yes", expected: null, actual: back.get(r.id)!.input.answered_yes });
        }
        const missingKept = [...answeredById(drafts.get(d) ?? parseDraft({}, d)).keys()]
          .filter((id) => !replace_day && !planned.some((p) => p.spec.id === id) && !back.has(id));
        for (const id of missingKept) mismatches.push({ date: d, id, field: "kept_answer", expected: true, actual: false });
      }
    }
    if (mismatches.length > 0) {
      verified = false;
      warnings.push("WHOOP accepted the write, but the read-back doesn't match everywhere (see mismatches). A write can be dropped while WHOOP reshuffles the day's cycle; retry in a minute.");
    }

    return respond(NAME, JournalLogV2Out, {
      written: true,
      method: full ? "full" : "partial",
      requests: requests.length > 1 ? requests.length : null,
      dates: dateList,
      rows: rowsOut,
      notes: full ? { before: notesPlan!.before, after: after.get(dateList[0]!)?.notes ?? null } : null,
      removed: removed.map((r) => r.title),
      verified,
      mismatches,
      warnings,
    });
  });
}
