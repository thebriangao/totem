// Journal behaviours: the live catalog, name resolution with suggestions, the
// v3 draft parser, and the row builder/validator shared by whoop_journal and
// whoop_journal_log (SPEC.md §4.6, §7 S10).
//
// The live per-user list is the authority. The bundled catalog (309 stock
// behaviours) is the fallback, and it can't know custom behaviours.
import type { WhoopClient } from "../whoop/client.js";
import { BEHAVIORS, BEHAVIORS_BY_ID, type BehaviorMagnitudeSpec } from "../data/behaviors.js";
import { assertNotFuture } from "./dates.js";
import { asArray, asBool, asNumber, asString, isObject } from "./walk.js";

export const MENSTRUATION_ID = 43;
export const OVULATION_ID = 79;

export interface BehaviorSpec {
  id: number;
  title: string;
  internal_name: string | null;
  question: string | null;
  /** Human category from the bundled catalog ("Lifestyle"…), "Custom" for customs. */
  category: string | null;
  custom: boolean;
  /** true: in the user's live tracked list. false: stock but untracked. null: live list unavailable. */
  tracked: boolean | null;
  magnitude: BehaviorMagnitudeSpec | null;
  time_label: string | null;
}

export interface BehaviorCatalog {
  specs: Map<number, BehaviorSpec>;
  source: "live" | "bundled";
  warning: string | null;
}

/** One stored answer, as the v3 draft returns it. */
export interface StoredInput {
  answered_yes: boolean | null;
  magnitude_input_value: number | null;
  magnitude_input_label: string | null;
  time_input_value: number | null;
  source: string | null;
  ever_ai_sourced: boolean | null;
}

export interface DraftRow {
  spec: BehaviorSpec;
  input: StoredInput | null;
}

export interface DraftDay {
  date: string;
  cycle_id: number | null;
  notes: string | null;
  user_reviewed: boolean | null;
  rows: DraftRow[];
}

/** A row in either journal PUT body. A bare `{behavior_tracker_id}` clears it. */
export interface TrackerRow {
  behavior_tracker_id: number;
  answered_yes?: boolean;
  magnitude_input_value?: number;
  magnitude_input_label?: string;
  time_input_value?: number;
}

function parseMagnitude(raw: unknown): BehaviorMagnitudeSpec | null {
  if (!isObject(raw)) return null;
  const type = raw.type === "range" || raw.type === "step" ? raw.type : null;
  if (!type) return null;
  return {
    type,
    label: asString(raw.label),
    units: asString(raw.units),
    minimum: asNumber(raw.minimum_inclusive ?? raw.minimum),
    maximum: asNumber(raw.maximum_inclusive ?? raw.maximum),
    interval: asNumber(raw.interval),
    choices: asArray(raw.choices).flatMap((c) => {
      if (!isObject(c)) return [];
      const value = asNumber(c.value);
      const label = asString(c.label);
      return value === null || label === null ? [] : [{ value, label }];
    }),
  };
}

/** A live `behavior_tracker` object (drafts, user lists) → spec. */
export function specFromTracker(raw: unknown, tracked: boolean | null = true): BehaviorSpec | null {
  if (!isObject(raw)) return null;
  const id = asNumber(raw.id);
  if (id === null || !Number.isInteger(id)) return null;
  const bundled = BEHAVIORS_BY_ID.get(id);
  const internal = asString(raw.internal_name) ?? bundled?.internal_name ?? null;
  const custom = !bundled || (internal?.startsWith("custom-") ?? false) || asString(raw.category) === "CUSTOM";
  return {
    id,
    title: asString(raw.title)?.trim() || bundled?.title.trim() || `#${id}`,
    internal_name: internal,
    question: asString(raw.question_text) ?? bundled?.question ?? null,
    category: bundled?.category ?? (custom ? "Custom" : null),
    custom,
    tracked,
    magnitude: raw.magnitude === undefined ? bundled?.magnitude_spec ?? null : parseMagnitude(raw.magnitude),
    time_label: raw.time_label === undefined ? bundled?.time_label ?? null : asString(raw.time_label),
  };
}

function bundledSpec(id: number, tracked: boolean | null): BehaviorSpec | null {
  const b = BEHAVIORS_BY_ID.get(id);
  if (!b) return null;
  return {
    id,
    title: b.title,
    internal_name: b.internal_name,
    question: b.question,
    category: b.category,
    custom: false,
    tracked,
    magnitude: b.magnitude_spec,
    time_label: b.time_label,
  };
}

/** Trackers from either list shape: a bare array, or `{records}`. */
export function trackerList(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : isObject(raw) ? asArray(raw.records) : [];
}

/**
 * The user's behaviour catalog for a date: the live tracked list (309 stock incl.
 * 171, plus tracked custom behaviours), then every bundled stock behaviour the
 * user doesn't track. Falls back to the bundle alone when WHOOP can't be read.
 */
export async function loadBehaviorCatalog(
  client: WhoopClient,
  date: string,
  // Writes validate against this list, so they read it fresh: the cached copy
  // (5 min) wouldn't know a custom behaviour created in the app a moment ago.
  options: { fresh?: boolean } = {},
): Promise<BehaviorCatalog> {
  const sources = [
    `/journal-service/v2/journals/behaviors/user/${date}`,
    // Stock behaviours only: WHOOP never lists custom ones here (verified live).
    "/activities-service/v1/journals/behaviors/user",
  ];
  for (const [i, path] of sources.entries()) {
    try {
      const list = trackerList(await (options.fresh ? client.get(path, {}, { fresh: true }) : client.get(path)));
      if (list.length === 0) continue;
      const specs = new Map<number, BehaviorSpec>();
      for (const t of list) {
        const spec = specFromTracker(t, true);
        if (spec) specs.set(spec.id, spec);
      }
      for (const b of BEHAVIORS) {
        if (!specs.has(b.behavior_tracker_id)) specs.set(b.behavior_tracker_id, bundledSpec(b.behavior_tracker_id, false)!);
      }
      return {
        specs,
        source: "live",
        warning: i === 0 ? null : "Couldn't read your dated behaviour list from WHOOP, so custom behaviours can't be resolved right now (stock ones can).",
      };
    } catch {
      // try the next source, then the bundle
    }
  }
  const specs = new Map<number, BehaviorSpec>();
  for (const b of BEHAVIORS) specs.set(b.behavior_tracker_id, bundledSpec(b.behavior_tracker_id, null)!);
  return {
    specs,
    source: "bundled",
    warning: "Couldn't read your live behaviour list from WHOOP, so only the 309 stock behaviours are known (custom behaviours can't be resolved).",
  };
}

// ─── Name resolution ────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** Similarity 0..1 between a query and one label. */
export function similarity(query: string, label: string): number {
  const a = norm(query);
  const b = norm(label);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.9;
  if (b.includes(a) || a.includes(b)) return 0.8;
  const ta = a.split(" ");
  const tb = b.split(" ");
  const shared = ta.filter((t) => tb.some((u) => u === t || (t.length > 2 && (u.startsWith(t) || t.startsWith(u))))).length;
  const jaccard = shared / new Set([...ta, ...tb]).size;
  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(jaccard * 0.75, edit * 0.7);
}

/** Top-n items by best similarity of any of their labels. */
export function suggest<T>(query: string, items: Iterable<T>, labels: (item: T) => Array<string | null>, n = 5): T[] {
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = Math.max(0, ...labels(item).map((l) => (l ? similarity(query, l) : 0)));
    if (score > 0.2) scored.push({ item, score });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, n).map((s) => s.item);
}

export type Resolution =
  | { ok: true; spec: BehaviorSpec }
  | { ok: false; error: string; suggestions: Array<{ id: number; title: string }> };

const brief = (s: BehaviorSpec) => ({ id: s.id, title: s.title });

/** Resolve `{id}` or `{name}` (exact title or internal name, case-insensitive). */
export function resolveBehavior(ref: { id?: number | undefined; name?: string | undefined }, catalog: BehaviorCatalog): Resolution {
  const specs = [...catalog.specs.values()];
  const suggestFor = (q: string) => suggest(q, specs, (s) => [s.title, s.internal_name]).map(brief);
  if (ref.id !== undefined) {
    const spec = catalog.specs.get(ref.id);
    if (!spec) {
      return {
        ok: false,
        error: `Unknown behaviour id ${ref.id}.${catalog.source === "bundled" ? " (Custom behaviours can't be checked right now.)" : ""}`,
        suggestions: ref.name ? suggestFor(ref.name) : [],
      };
    }
    if (ref.name && norm(ref.name) !== norm(spec.title) && norm(ref.name) !== norm(spec.internal_name ?? "")) {
      return { ok: false, error: `Behaviour id ${ref.id} is "${spec.title}", not "${ref.name}". Pass one or the other.`, suggestions: suggestFor(ref.name) };
    }
    return { ok: true, spec };
  }
  const name = ref.name?.trim();
  if (!name) return { ok: false, error: "Each behaviour needs an id or a name.", suggestions: [] };
  const wanted = norm(name);
  const exact = specs.filter((s) => norm(s.title) === wanted || (s.internal_name !== null && norm(s.internal_name) === wanted));
  // Prefer what the user tracks, then stock over custom.
  exact.sort((a, b) => Number(b.tracked === true) - Number(a.tracked === true) || Number(a.custom) - Number(b.custom));
  if (exact[0]) return { ok: true, spec: exact[0] };
  return { ok: false, error: `No journal behaviour is called "${name}".`, suggestions: suggestFor(name) };
}

// ─── Draft parsing ──────────────────────────────────────────────────────────

function storedInput(raw: unknown): StoredInput | null {
  if (!isObject(raw)) return null;
  return {
    answered_yes: asBool(raw.answered_yes),
    magnitude_input_value: asNumber(raw.magnitude_input_value),
    magnitude_input_label: asString(raw.magnitude_input_label),
    time_input_value: asNumber(raw.time_input_value),
    source: asString(raw.source),
    ever_ai_sourced: asBool(raw.ever_ai_sourced),
  };
}

/** A stored row counts as answered once any value is set (`answered_yes:null` rows are invisible in the app). */
export function isAnswered(input: StoredInput | null): input is StoredInput {
  return input !== null && (input.answered_yes !== null || input.magnitude_input_value !== null || input.time_input_value !== null);
}

/**
 * True for a real draft body. WHOOP answers 200 with `journal.tracked_behaviors`
 * (an array, empty on an empty day) for any date; anything else must not be
 * read as "nothing logged", or a full-day write would erase the day.
 */
export function isDraftBody(raw: unknown): boolean {
  return isObject(raw) && isObject(raw.journal) && Array.isArray(raw.journal.tracked_behaviors);
}

/**
 * GET /journal-service/v3/journals/drafts/mobile/{date}. A day with a cycle
 * lists every tracked behaviour (most unanswered); a day without one lists only
 * the answered rows. Entries are keyed by date, not cycle.
 */
export function parseDraft(raw: unknown, date: string): DraftDay {
  const journal = isObject(raw) && isObject(raw.journal) ? raw.journal : {};
  const rows: DraftRow[] = [];
  for (const entry of asArray(journal.tracked_behaviors)) {
    if (!isObject(entry)) continue;
    const input = storedInput(entry.tracker_input);
    let spec = specFromTracker(entry.behavior_tracker, true);
    if (!spec) {
      const id = isObject(entry.tracker_input) ? asNumber(entry.tracker_input.behavior_tracker_id) : null;
      spec = id === null ? null : bundledSpec(id, true) ?? emptySpec(id);
    }
    if (spec) rows.push({ spec, input });
  }
  const notes = asString(journal.notes);
  return {
    date,
    cycle_id: asNumber(journal.cycle_id),
    notes: notes && notes.length > 0 ? notes : null,
    user_reviewed: asBool(journal.user_reviewed),
    rows,
  };
}

function emptySpec(id: number): BehaviorSpec {
  return { id, title: `#${id}`, internal_name: null, question: null, category: null, custom: true, tracked: true, magnitude: null, time_label: null };
}

/** Answered rows keyed by id. */
export function answeredById(day: DraftDay): Map<number, DraftRow & { input: StoredInput }> {
  const out = new Map<number, DraftRow & { input: StoredInput }>();
  for (const row of day.rows) if (isAnswered(row.input)) out.set(row.spec.id, row as DraftRow & { input: StoredInput });
  return out;
}

// ─── Row building ───────────────────────────────────────────────────────────

export interface RowRequest {
  answered_yes?: boolean | undefined;
  /** null clears a stored magnitude (otherwise it's carried). */
  magnitude?: number | null | undefined;
  magnitude_label?: string | undefined;
  /** null clears a stored time (otherwise it's carried). */
  time?: string | number | null | undefined;
}

/** ISO datetime or epoch seconds → epoch seconds. */
export function toEpochSeconds(value: string | number): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value > 1e11 || value < 0) return null; // ms or garbage
    return Math.round(value);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.round(ms / 1000);
}

export function describeChoices(spec: BehaviorMagnitudeSpec): string {
  return spec.choices.map((c) => `${c.value}=${c.label}`).join(", ");
}

/**
 * Build one partial/full PUT row and validate it against the behaviour's live
 * spec. A row is replaced whole by WHOOP, so when the caller leaves the
 * magnitude or time out of an already-"yes" row, the stored values are carried;
 * an explicit null clears them.
 */
export function buildRow(
  spec: BehaviorSpec,
  req: RowRequest,
  existing: StoredInput | null,
  now: number = Date.now(),
): { row: TrackerRow; carried: string[] } | { error: string } {
  const yes = req.answered_yes ?? true;
  const row: TrackerRow = { behavior_tracker_id: spec.id, answered_yes: yes };
  const carried: string[] = [];
  const name = spec.title;
  const wantsMagnitude = (req.magnitude !== undefined && req.magnitude !== null) || req.magnitude_label !== undefined;
  const wantsTime = req.time !== undefined && req.time !== null;
  if (!yes && (wantsMagnitude || wantsTime)) {
    return { error: `${name}: a magnitude or time only goes with answered_yes:true.` };
  }
  const keep = yes && existing?.answered_yes === true;

  if (wantsMagnitude) {
    const m = spec.magnitude;
    if (!m) return { error: `${name} is a yes/no behaviour; it takes no magnitude.` };
    if (m.type === "step") {
      const byLabel = req.magnitude_label !== undefined
        ? m.choices.find((c) => c.label.toLowerCase() === req.magnitude_label!.trim().toLowerCase())
        : undefined;
      const choice = typeof req.magnitude === "number" ? m.choices.find((c) => c.value === req.magnitude) : byLabel;
      if (!choice) return { error: `${name} takes one of: ${describeChoices(m)}.` };
      if (byLabel && byLabel.value !== choice.value) return { error: `${name}: magnitude ${req.magnitude} is "${choice.label}", not "${req.magnitude_label}".` };
      row.magnitude_input_value = choice.value;
      row.magnitude_input_label = choice.label;
    } else {
      if (typeof req.magnitude !== "number") return { error: `${name} takes a number${m.units ? ` of ${m.units}` : ""}, not just a label.` };
      if ((m.minimum !== null && req.magnitude < m.minimum) || (m.maximum !== null && req.magnitude > m.maximum)) {
        return { error: `${name} takes ${m.minimum ?? "…"}–${m.maximum ?? "…"}${m.units ? ` ${m.units}` : ""}; got ${req.magnitude}.` };
      }
      row.magnitude_input_value = req.magnitude;
      row.magnitude_input_label = req.magnitude_label ?? String(req.magnitude);
    }
  } else if (req.magnitude === undefined && keep && existing!.magnitude_input_value !== null && spec.magnitude) {
    row.magnitude_input_value = existing!.magnitude_input_value;
    row.magnitude_input_label = existing!.magnitude_input_label ?? labelFor(spec, existing!.magnitude_input_value);
    carried.push("magnitude");
  }

  if (wantsTime) {
    if (!spec.time_label) return { error: `${name} doesn't ask for a time.` };
    const secs = toEpochSeconds(req.time!);
    if (secs === null) return { error: `${name}: time must be an ISO datetime with an offset, or epoch seconds.` };
    try {
      assertNotFuture(new Date(secs * 1000).toISOString(), `${name} time`, now);
    } catch (e) {
      return { error: (e as Error).message };
    }
    row.time_input_value = secs;
  } else if (req.time === undefined && keep && existing!.time_input_value !== null && spec.time_label) {
    row.time_input_value = existing!.time_input_value;
    carried.push("time");
  }
  return { row, carried };
}

/** The label a stored magnitude should carry when re-sent. */
export function labelFor(spec: BehaviorSpec | null, value: number): string {
  const choice = spec?.magnitude?.type === "step" ? spec.magnitude.choices.find((c) => c.value === value) : undefined;
  return choice?.label ?? String(value);
}

/** A stored answer re-sent verbatim (full PUT keeps rows it doesn't touch). */
export function carryRow(row: DraftRow & { input: StoredInput }): TrackerRow {
  const out: TrackerRow = { behavior_tracker_id: row.spec.id };
  if (row.input.answered_yes !== null) out.answered_yes = row.input.answered_yes;
  if (row.input.magnitude_input_value !== null) {
    out.magnitude_input_value = row.input.magnitude_input_value;
    out.magnitude_input_label = row.input.magnitude_input_label ?? labelFor(row.spec, row.input.magnitude_input_value);
  }
  if (row.input.time_input_value !== null) out.time_input_value = row.input.time_input_value;
  return out;
}

/**
 * The partial endpoint refuses menstruation (43) and ovulation (79) both "yes"
 * in one request (it checks the request, not the stored day). Move the 79 rows
 * of any date that also has 43=yes into a second request.
 */
export function splitMenstruationOvulation(byDate: Map<string, TrackerRow[]>): Array<Map<string, TrackerRow[]>> {
  const first = new Map<string, TrackerRow[]>();
  const second = new Map<string, TrackerRow[]>();
  for (const [date, rows] of byDate) {
    const yes = (id: number) => rows.some((r) => r.behavior_tracker_id === id && r.answered_yes === true);
    if (yes(MENSTRUATION_ID) && yes(OVULATION_ID)) {
      first.set(date, rows.filter((r) => r.behavior_tracker_id !== OVULATION_ID));
      second.set(date, rows.filter((r) => r.behavior_tracker_id === OVULATION_ID));
    } else {
      first.set(date, rows);
    }
  }
  return second.size > 0 ? [first, second] : [first];
}
