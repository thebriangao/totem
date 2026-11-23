// Activity-type and garment lookups for the activity tools. The bundled catalog
// (src/data/sports.ts) answers almost everything; on a miss we re-fetch WHOOP's
// live catalogs once (24 h client cache) before giving up with the top-5 fuzzy
// suggestions. MCP resources aren't visible to every client, so tools resolve
// names themselves (SPEC.md §3.3, §7 S3).
import type { WhoopClient } from "../whoop/client.js";
import { ACTIVITY_TYPES, ACTIVITY_TYPES_BY_INTERNAL_NAME, type ActivityType, type ScoreType } from "../data/sports.js";
import { GARMENTS, GARMENTS_BY_ID, type Garment } from "../data/garments.js";

/** Sport ids WHOOP retired (`is_current:false`); v0 create rejects them with 400. */
const RETIRED_SPORT_IDS: Record<number, string> = {
  [-1]: "Activity", 50: "Machine Workout", 54: "Jogging", 58: "Obstacle Racing", 67: "Plyometrics",
  68: "Spinning", 69: "Sex", 72: "Pit Practice", 116: "Resonance Frequency Breathing",
};

export type TypeResolution =
  | { ok: true; type: ActivityType; matched_by: "internal_name" | "name" | "sport_id" | "live_catalog" }
  | { ok: false; error: string; suggestions: string[] };

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** "ski-erg (Ski Erg)" — what a model should pass back. */
export function describeType(t: Pick<ActivityType, "internal_name" | "name">): string {
  return `${t.internal_name.trim()} (${t.name})`;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

function similarity(query: string, field: string): number {
  if (!query || !field) return 0;
  if (field === query) return 1;
  if (field.startsWith(query) || query.startsWith(field)) return 0.9 - Math.abs(field.length - query.length) / 100;
  if (field.includes(query) || query.includes(field)) return 0.8 - Math.abs(field.length - query.length) / 100;
  return 1 - levenshtein(query, field) / Math.max(query.length, field.length);
}

/** Top-n catalog entries closest to `query`, as "internal_name (Name)". */
export function suggestActivityTypes(query: string, n = 5, catalog: readonly ActivityType[] = ACTIVITY_TYPES): string[] {
  const q = norm(query);
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return catalog
    .map((t) => {
      let score = Math.max(similarity(q, norm(t.internal_name)), similarity(q, norm(t.name)));
      // A whole word of the query inside the name ("bike" → "Assault Bike") beats edit distance.
      if (words.some((w) => t.name.toLowerCase().includes(w) || t.internal_name.includes(w))) score = Math.max(score, 0.75);
      return { t, score };
    })
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .slice(0, n)
    .map(({ t }) => describeType(t));
}

function matchIn(catalog: readonly ActivityType[], raw: string): { type: ActivityType; by: "internal_name" | "name" } | null {
  const exact = catalog.find((t) => t.internal_name === raw);
  if (exact) return { type: exact, by: "internal_name" };
  const lower = raw.trim().toLowerCase();
  const byInternal = catalog.find((t) => t.internal_name.trim().toLowerCase() === lower);
  if (byInternal) return { type: byInternal, by: "internal_name" };
  const byName = catalog.find((t) => t.name.toLowerCase() === lower);
  if (byName) return { type: byName, by: "name" };
  const n = norm(raw);
  const loose = n ? catalog.find((t) => norm(t.internal_name) === n || norm(t.name) === n) : undefined;
  return loose ? { type: loose, by: "name" } : null;
}

/**
 * Resolve an internal_name ("ski-erg"), a display name ("Strength Trainer"), or a
 * current sport_id (339, or "339") against the bundled catalog.
 */
export function resolveActivityType(input: string | number, catalog: readonly ActivityType[] = ACTIVITY_TYPES): TypeResolution {
  const raw = typeof input === "number" ? String(input) : input;
  if (/^-?\d+$/.test(raw.trim())) {
    const id = Number(raw.trim());
    const fromCatalog = catalog.find((t) => t.sport_id === id);
    if (fromCatalog) return { ok: true, type: fromCatalog, matched_by: "sport_id" };
    const retired = RETIRED_SPORT_IDS[id];
    if (retired) {
      return { ok: false, error: `sport_id ${id} (${retired}) is retired; WHOOP rejects it.`, suggestions: suggestActivityTypes(retired, 5, catalog) };
    }
    return { ok: false, error: `Unknown sport_id ${id}.`, suggestions: [] };
  }
  if (!raw.trim()) return { ok: false, error: "Empty activity type.", suggestions: [] };
  const hit = matchIn(catalog, raw);
  if (hit) return { ok: true, type: hit.type, matched_by: hit.by };
  return { ok: false, error: `Unknown activity type "${raw}".`, suggestions: suggestActivityTypes(raw, 5, catalog) };
}

interface RawSport { id?: unknown; name?: unknown; activity_type_internal_name?: unknown; is_current?: unknown }
interface RawType {
  internal_name?: unknown; display_name?: unknown; category?: unknown; score_type?: unknown;
  msk_linkable?: unknown; has_gps?: unknown; deleted?: unknown;
}

/**
 * Join WHOOP's live catalogs the way the bundled one was generated: a type's
 * sport is the current sport whose activity_type_internal_name matches, else the
 * one whose name equals the display name (case-insensitive).
 */
export function joinActivityCatalog(rawSports: unknown, rawTypes: unknown): ActivityType[] {
  const sports = (Array.isArray(rawSports) ? rawSports : []) as RawSport[];
  const current = sports.filter((s) => s.is_current !== false && typeof s.id === "number" && typeof s.name === "string");
  const byInternal = new Map(current.filter((s) => typeof s.activity_type_internal_name === "string").map((s) => [s.activity_type_internal_name as string, s]));
  const byName = new Map(current.map((s) => [(s.name as string).toLowerCase(), s]));
  const types = (Array.isArray(rawTypes) ? rawTypes : []) as RawType[];
  const out: ActivityType[] = [];
  for (const t of types) {
    if (typeof t.internal_name !== "string" || typeof t.display_name !== "string" || t.deleted === true) continue;
    const scoreType = t.score_type === "RECOVERY" || t.score_type === "SLEEP" ? t.score_type : "CARDIO";
    const sport = byInternal.get(t.internal_name) ?? byName.get(t.display_name.toLowerCase());
    out.push({
      internal_name: t.internal_name,
      name: t.display_name,
      sport_id: typeof sport?.id === "number" ? sport.id : null,
      score_type: scoreType as ScoreType,
      category: typeof t.category === "string" ? t.category : "",
      msk_linkable: t.msk_linkable === true,
      has_gps: t.has_gps === true,
    });
  }
  return out;
}

/**
 * Bundled lookup first; on a miss, re-fetch the live catalogs (new types WHOOP
 * shipped after this build) and try again. Live failures fall back to the
 * bundled suggestions.
 */
export async function resolveActivityTypeLive(client: WhoopClient, input: string | number): Promise<TypeResolution> {
  const local = resolveActivityType(input);
  if (local.ok) return local;
  try {
    const [sports, types] = await Promise.all([
      client.get("/activities-service/v1/sports"),
      client.get("/activities-service/v2/activity-types"),
    ]);
    const live = joinActivityCatalog(sports, types);
    if (live.length) {
      const hit = resolveActivityType(input, live);
      if (hit.ok) return { ok: true, type: hit.type, matched_by: "live_catalog" };
    }
  } catch {
    // Live catalog unavailable: the bundled answer stands.
  }
  return local;
}

/** Catalog entry for an internal_name seen in a WHOOP payload (tolerates trimming). */
export function typeForInternalName(name: string | null | undefined): ActivityType | undefined {
  if (!name) return undefined;
  return ACTIVITY_TYPES_BY_INTERNAL_NAME.get(name) ?? ACTIVITY_TYPES.find((t) => t.internal_name.trim() === name.trim());
}

export function isSleepType(internalName: string | null | undefined): boolean {
  return internalName === "sleep" || internalName === "nap";
}

export type GarmentResolution = { ok: true; garment: Garment } | { ok: false; error: string };

export function resolveGarment(id: number): GarmentResolution {
  const garment = GARMENTS_BY_ID.get(id);
  if (garment) return { ok: true, garment };
  return { ok: false, error: `Unknown garment_id ${id}. Valid: ${GARMENTS.map((g) => `${g.id} ${g.name}`).join(", ")}.` };
}
