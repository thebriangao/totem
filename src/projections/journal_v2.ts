// whoop_journal projections: the day's answered rows, the live behaviour
// catalog (compact, filtered), and behaviour impact (personal or member-average).
import type { z } from "zod";
import type { BehaviorCatalogRow, BehaviorImpactRow, JournalAnsweredRow } from "../schemas/journal_v2.js";
import {
  describeChoices,
  isAnswered,
  similarity,
  type BehaviorCatalog,
  type BehaviorSpec,
  type DraftDay,
  type StoredInput,
} from "../lib/journal_behaviors.js";
import { parseNumber } from "../whoop/bff.js";
import { asArray, asString, isObject } from "../lib/walk.js";

type AnsweredRow = z.infer<typeof JournalAnsweredRow>;
type CatalogRow = z.infer<typeof BehaviorCatalogRow>;
type ImpactRow = z.infer<typeof BehaviorImpactRow>;

export function answeredRow(spec: BehaviorSpec, input: StoredInput): AnsweredRow {
  const step = spec.magnitude?.type === "step";
  const value = input.magnitude_input_value;
  return {
    id: spec.id,
    name: spec.title,
    yes: input.answered_yes,
    value,
    label: value !== null && step ? input.magnitude_input_label ?? spec.magnitude!.choices.find((c) => c.value === value)?.label ?? null : null,
    unit: value !== null ? spec.magnitude?.units ?? null : null,
    time: input.time_input_value === null ? null : new Date(input.time_input_value * 1000).toISOString(),
    src: input.source === "AI" ? "AI" : null,
    ever_ai: input.ever_ai_sourced === true && input.source !== "AI" ? true : null,
    custom: spec.custom ? true : null,
  };
}

export function projectJournalDay(day: DraftDay, opts: { includeUnanswered?: boolean } = {}) {
  const answered: AnsweredRow[] = [];
  const unanswered: Array<[number, string]> = [];
  for (const { spec, input } of day.rows) {
    if (isAnswered(input)) answered.push(answeredRow(spec, input));
    else unanswered.push([spec.id, spec.title]);
  }
  return {
    date: day.date,
    reviewed: day.user_reviewed,
    notes: day.notes,
    answered,
    ...(opts.includeUnanswered ? { unanswered } : {}),
  };
}

function catalogRow(s: BehaviorSpec, detail: boolean): CatalogRow {
  const m = s.magnitude;
  const row: CatalogRow = {
    id: s.id,
    name: s.title,
    type: m ? m.type : "yn",
    time: s.time_label ? true : null,
    custom: s.custom ? true : null,
    tracked: s.tracked === false ? false : null,
  };
  if (detail) {
    row.unit = m?.units ?? null;
    row.min = m?.type === "range" ? m.minimum : null;
    row.max = m?.type === "range" ? m.maximum : null;
    row.choices = m?.type === "step" ? describeChoices(m) : null;
    row.time_q = s.time_label;
  }
  return row;
}

/**
 * The catalog, filtered by search (name, internal name or category) and/or
 * category. Unfiltered calls get the category counts and a short first page.
 */
export function projectBehaviorCatalog(
  catalog: BehaviorCatalog,
  filter: { search?: string | undefined; category?: string | undefined; detail?: boolean },
) {
  const all = [...catalog.specs.values()].sort((a, b) =>
    Number(b.tracked !== false) - Number(a.tracked !== false) || a.title.localeCompare(b.title));
  const q = filter.search?.trim().toLowerCase();
  const cat = filter.category?.trim().toLowerCase();
  let matches = cat ? all.filter((s) => (s.category ?? "").toLowerCase().includes(cat)) : all;
  if (q) {
    const direct = matches.filter((s) =>
      s.title.toLowerCase().includes(q) || (s.internal_name ?? "").toLowerCase().includes(q) || (s.category ?? "").toLowerCase().includes(q));
    matches = direct.length > 0
      ? direct
      : matches.map((s) => ({ s, score: Math.max(similarity(q, s.title), similarity(q, s.internal_name ?? "")) }))
          .filter((x) => x.score > 0.45).sort((a, b) => b.score - a.score).map((x) => x.s);
  }
  const filtered = Boolean(q || cat);
  const limit = filtered ? 80 : 30;
  let categories: Record<string, number> | null = null;
  if (!filtered) {
    categories = {};
    for (const s of all) if (s.category) categories[s.category] = (categories[s.category] ?? 0) + 1;
  }
  return {
    source: catalog.source === "bundled" ? "bundled" as const : null,
    total: all.length,
    matched: matches.length,
    truncated: matches.length > limit ? true as const : null,
    categories,
    rows: matches.slice(0, limit).map((s) => catalogRow(s, filter.detail === true)),
  };
}

function direction(style: string | null): ImpactRow["dir"] {
  const s = (style ?? "").toUpperCase();
  if (s === "INSUFFICIENT") return "insufficient";
  if (s.startsWith("NEGLIGIBLE")) return "neutral";
  if (s.endsWith("POSITIVE")) return "positive";
  if (s.endsWith("NEGATIVE")) return "negative";
  return "neutral";
}

/** A member-average block: "WHOOP members discovered" (HEADER_ITEMS_CARD, MEMBERS_LIKE_YOU). */
function isMemberBlock(node: Record<string, unknown>): boolean {
  const content = isObject(node.content) ? node.content : {};
  return node.type === "HEADER_ITEMS_CARD"
    || content.title_icon === "MEMBERS_LIKE_YOU"
    || /members/i.test(asString(content.title) ?? "");
}

/**
 * GET /behavior-impact-service/v1/impact. Established accounts put personal
 * cards in `tiles[].content.impact_cards`; new accounts nest member-average
 * "recommended" cards under `HEADER_ITEMS_CARD.content.items[].content`. Walk
 * the whole tree and mark which kind each card is.
 */
export function projectBehaviorImpacts(raw: unknown) {
  const rows: Array<ImpactRow & { uuid: string | null }> = [];
  const seen = new Set<string>();
  const visit = (node: unknown, rec: boolean, insufficient: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n, rec, insufficient);
      return;
    }
    if (!isObject(node)) return;
    const recHere = rec || isMemberBlock(node);
    const insuffHere = insufficient || node.type === "INSUFFICIENT_IMPACT_TILE";
    const title = asString(node.impact_card_title_display);
    if (title !== null && ("impact_uuid" in node || "impact_style" in node)) {
      const uuid = asString(node.impact_uuid);
      const key = `${uuid ?? title}|${recHere}`;
      if (!seen.has(key)) {
        seen.add(key);
        const pct = parseNumber(node.impact_percentage_display);
        const dir = direction(asString(node.impact_style));
        rows.push({
          id: recHere ? null : uuid,
          uuid,
          name: title,
          pct,
          dir: insuffHere && pct === null ? "insufficient" : dir,
          rec: recHere ? true : null,
        });
      }
      return;
    }
    for (const v of Object.values(node)) visit(v, recHere, insuffHere);
  };
  visit(isObject(raw) ? asArray(raw.tiles) : [], false, false);
  return {
    personal: rows.filter((r) => r.rec === null).length,
    // uuid kept internally to recognise a member card passed as impact_id.
    rows,
  };
}
