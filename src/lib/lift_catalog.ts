// Exercise lookup for the v2 strength tools. Writes send WHOOP's own exercise row
// verbatim as `exercise_details` (a bare {exercise_id} is a 422), so rows come
// from the live catalog (GET /weightlifting-service/v2/exercise: 371 base rows plus
// this account's custom exercises; 24 h client cache), then GET
// /weightlifting-service/v1/exercise/{id} for ids it doesn't list, then the bundled
// catalog when WHOOP can't be read. Names resolve only on an exact (normalized)
// match; a miss returns the top-5 suggestions instead of guessing.
import type { WhoopClient } from "../whoop/client.js";
import { EXERCISES, EXERCISES_BY_ID } from "../data/exercises.js";
import type { OfficialExercise } from "../schemas/strength.js";

const CATALOG_PATH = "/weightlifting-service/v2/exercise";

export type ExerciseRow = Record<string, unknown> & { exercise_id: string; name: string };

export interface ExerciseRef {
  exercise_id?: string | undefined;
  name?: string | undefined;
}

export interface ResolvedExercise {
  exercise_id: string;
  name: string;
  /** The row sent as exercise_details. */
  row: ExerciseRow;
  custom: boolean;
  volume_input_format: string | null;
  e1rm_eligible: boolean | null;
  source: "live" | "v1" | "bundled";
}

export interface Suggestion {
  exercise_id: string;
  name: string;
}

export type ResolveResult =
  | { ok: true; exercise: ResolvedExercise }
  | { ok: false; input: string; error: string; suggestions: Suggestion[] };

// Fixed timestamps for a rebuilt row: WHOOP requires non-empty ISO strings and
// ignores the values (totem's v1 body, accepted live 2026-11-21).
const FALLBACK_CREATED_AT = "2022-03-03T19:45:51.740Z";
const FALLBACK_UPDATED_AT = "2026-09-02T15:57:09.962Z";

/** Rebuild WHOOP's exercise row from a bundled catalog entry (no instructions or media URLs). */
export function bundledExerciseRow(e: OfficialExercise): ExerciseRow {
  return {
    training_types: e.training_types ?? [],
    instructions: [],
    muscle_groups: [...e.muscle_groups],
    translated_muscle_groups: e.primary_muscle,
    created_at: FALLBACK_CREATED_AT,
    updated_at: FALLBACK_UPDATED_AT,
    custom_exercise_info: null,
    volume_input_value: null,
    volume_input_units: null,
    exercise_id: e.exercise_id,
    name: e.name,
    push_core_name: e.push_core_name,
    trackable: e.trackable,
    equipment: e.raw_equipment,
    translated_equipment: e.equipment,
    exercise_type: e.exercise_type,
    laterality: e.laterality,
    movement_pattern: e.raw_movement_pattern,
    translated_movement_pattern: e.movement_pattern,
    deleted: false,
    volume_input_format: e.volume_input_format,
    e1rm_eligible: e.e1rm_eligible,
    custom_exercise: false,
  };
}

/** Lower-case alphanumerics only: "Bench Press - Barbell" and "BENCHPRESS_BARBELL" both → "benchpressbarbell". */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

type Searchable = { exercise_id: string; name: string; muscle_groups?: unknown; raw_equipment?: unknown; equipment?: unknown };

/** Muscle groups and equipment as search words ("legs", "full body", "kettlebell"). */
function tagWords(row: Searchable): string[] {
  const tags = [
    ...(Array.isArray(row.muscle_groups) ? row.muscle_groups : []),
    typeof row.raw_equipment === "string" ? row.raw_equipment : row.equipment,
  ];
  return tags.flatMap((t) => (typeof t === "string" ? tokens(t.replace(/_/g, " ")) : []));
}

/**
 * Relevance of a row to a free-text query: whole-word hits (name, id, muscle
 * group, equipment), then prefix hits, then substring. 0 = no match.
 */
export function matchScore(query: string, row: Searchable): number {
  const q = tokens(query);
  if (q.length === 0) return 0;
  const words = [...tokens(row.name), ...tokens(row.exercise_id.replace(/_/g, " ")), ...tagWords(row)];
  let score = 0;
  for (const t of q) {
    if (words.includes(t)) score += 3;
    else if (words.some((w) => w.startsWith(t))) score += 2;
    else if (normalizeName(row.name).includes(t) || normalizeName(row.exercise_id).includes(t)) score += 1;
    else return 0; // every query word must appear somewhere
  }
  if (normalizeName(row.name) === normalizeName(query)) score += 10;
  return score;
}

/** Ranked matches for a free-text query (ties: shorter name first). */
export function rankMatches<T extends Searchable>(query: string, rows: readonly T[]): T[] {
  return rows
    .map((row) => ({ row, score: matchScore(query, row) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.row.name.length - b.row.name.length)
    .map((x) => x.row);
}

/** Up to 5 catalog suggestions for a missed name or id; falls back to any-word matches. */
export function suggestExercises(query: string, rows: readonly { exercise_id: string; name: string }[]): Suggestion[] {
  let ranked = rankMatches(query, rows);
  if (ranked.length === 0) {
    const words = tokens(query).filter((w) => w.length >= 3);
    ranked = rows
      .map((row) => ({ row, hits: words.filter((w) => normalizeName(row.name).includes(w)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.row.name.length - b.row.name.length)
      .map((x) => x.row);
  }
  return ranked.slice(0, 5).map((r) => ({ exercise_id: r.exercise_id, name: r.name }));
}

function isRow(v: unknown): v is ExerciseRow {
  return typeof v === "object" && v !== null && typeof (v as ExerciseRow).exercise_id === "string" && typeof (v as ExerciseRow).name === "string";
}

/** Live catalog rows (base + this account's customs), or null if WHOOP can't be read. */
export async function liveCatalog(client: WhoopClient, fresh = false): Promise<ExerciseRow[] | null> {
  try {
    const raw = await client.get<{ exercises?: unknown[] }>(CATALOG_PATH, {}, { fresh });
    const rows = Array.isArray(raw?.exercises) ? raw.exercises.filter(isRow) : [];
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

function resolved(row: ExerciseRow, source: ResolvedExercise["source"]): ResolvedExercise {
  return {
    exercise_id: row.exercise_id,
    name: row.name,
    row,
    custom: row.custom_exercise === true,
    volume_input_format: typeof row.volume_input_format === "string" ? row.volume_input_format : null,
    e1rm_eligible: typeof row.e1rm_eligible === "boolean" ? row.e1rm_eligible : null,
    source,
  };
}

/**
 * Resolves several exercise refs against one lazily loaded catalog. A miss on
 * the cached catalog re-reads it fresh once (a custom exercise created since the
 * cache filled), then tries v1/exercise/{id} for ids.
 */
export class ExerciseResolver {
  private live: ExerciseRow[] | null | undefined;
  private refreshed = false;

  constructor(private readonly client: WhoopClient) {}

  private async rows(): Promise<ExerciseRow[] | null> {
    if (this.live === undefined) this.live = await liveCatalog(this.client);
    return this.live;
  }

  private async refresh(): Promise<ExerciseRow[] | null> {
    if (!this.refreshed) {
      this.refreshed = true;
      this.live = (await liveCatalog(this.client, true)) ?? this.live ?? null;
    }
    return this.live ?? null;
  }

  private suggestionPool(): readonly { exercise_id: string; name: string }[] {
    const customs = (this.live ?? []).filter((r) => r.custom_exercise === true && r.deleted !== true);
    return [...EXERCISES, ...customs];
  }

  async resolve(ref: ExerciseRef): Promise<ResolveResult> {
    const id = ref.exercise_id?.trim();
    const name = ref.name?.trim();
    if (!id && !name) return { ok: false, input: "", error: "Give exercise_id or name.", suggestions: [] };

    if (id) {
      const findId = (rows: ExerciseRow[] | null) =>
        rows?.find((r) => r.exercise_id === id || r.exercise_id.toUpperCase() === id.toUpperCase());
      const hit = findId(await this.rows()) ?? findId(await this.refresh());
      if (hit) {
        if (hit.deleted === true) return { ok: false, input: id, error: `Exercise ${id} is deleted.`, suggestions: [] };
        return { ok: true, exercise: resolved(hit, "live") };
      }
      // Not listed: a catalog id while WHOOP's list is unreadable, or an id the list omits.
      try {
        const row = await this.client.get<unknown>(`/weightlifting-service/v1/exercise/${encodeURIComponent(id)}`);
        if (isRow(row)) {
          if (row.deleted === true) return { ok: false, input: id, error: `Exercise ${id} is deleted.`, suggestions: [] };
          return { ok: true, exercise: resolved(row, "v1") };
        }
      } catch {
        // fall through to the bundle
      }
      const bundled = EXERCISES_BY_ID.get(id) ?? EXERCISES_BY_ID.get(id.toUpperCase());
      if (bundled) return { ok: true, exercise: resolved(bundledExerciseRow(bundled), "bundled") };
      return { ok: false, input: id, error: `Unknown exercise_id "${id}".`, suggestions: suggestExercises(id.replace(/_/g, " "), this.suggestionPool()) };
    }

    const wanted = normalizeName(name!);
    const findName = (rows: readonly ExerciseRow[] | null) =>
      rows?.filter((r) => r.deleted !== true && (normalizeName(r.name) === wanted || normalizeName(r.exercise_id) === wanted)) ?? [];
    let hits = findName(await this.rows());
    if (hits.length === 0) hits = findName(await this.refresh());
    if (hits.length === 0 && !this.live) {
      const bundled = EXERCISES.filter((e) => normalizeName(e.name) === wanted || normalizeName(e.exercise_id) === wanted);
      if (bundled.length === 1) return { ok: true, exercise: resolved(bundledExerciseRow(bundled[0]!), "bundled") };
    }
    if (hits.length === 1) return { ok: true, exercise: resolved(hits[0]!, "live") };
    if (hits.length > 1) {
      return {
        ok: false,
        input: name!,
        error: `"${name}" matches ${hits.length} exercises; pass exercise_id.`,
        suggestions: hits.slice(0, 5).map((r) => ({ exercise_id: r.exercise_id, name: r.name })),
      };
    }
    return { ok: false, input: name!, error: `No exercise named "${name}".`, suggestions: suggestExercises(name!, this.suggestionPool()) };
  }

  /** Resolve all refs; any miss fails the batch with every miss listed. */
  async resolveAll(refs: ExerciseRef[]): Promise<{ ok: true; exercises: ResolvedExercise[] } | { ok: false; misses: Array<{ index: number; input: string; error: string; suggestions: Suggestion[] }> }> {
    const out: ResolvedExercise[] = [];
    const misses: Array<{ index: number; input: string; error: string; suggestions: Suggestion[] }> = [];
    for (const [index, ref] of refs.entries()) {
      const r = await this.resolve(ref);
      if (r.ok) out.push(r.exercise);
      else misses.push({ index, input: r.input, error: r.error, suggestions: r.suggestions });
    }
    return misses.length > 0 ? { ok: false, misses } : { ok: true, exercises: out };
  }

  /** Custom exercises from the live catalog (empty when unreadable). */
  async customs(): Promise<ExerciseRow[]> {
    return ((await this.rows()) ?? []).filter((r) => r.custom_exercise === true && r.deleted !== true);
  }
}
