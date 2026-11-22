// v2 output schemas for whoop_journal and whoop_journal_log. Rows are short:
// jsonOut strips null/empty keys centrally, so absent values are null here.
import { z } from "zod";
import { IsoDateTime, withPreview } from "./primitives.js";
import { BehaviorImpactOut } from "./journal.js";

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const JournalAnsweredRow = z.object({
  id: z.number().int(),
  name: z.string(),
  yes: z.boolean().nullable(),
  value: z.number().nullable(),
  /** Step behaviours only: the choice label ("Moderate"). */
  label: z.string().nullable(),
  unit: z.string().nullable(),
  time: IsoDateTime.nullable(),
  /** "AI" when the journal agent or coach logged it. */
  src: z.literal("AI").nullable(),
  /** Sticky: true once the AI has ever written this row. */
  ever_ai: z.literal(true).nullable(),
  custom: z.literal(true).nullable(),
});

export const BehaviorCatalogRow = z.object({
  id: z.number().int(),
  name: z.string(),
  /** yn = yes/no only; range = a number; step = one of choices. */
  type: z.enum(["yn", "range", "step"]),
  /** The behaviour also asks for a time. */
  time: z.literal(true).nullable(),
  custom: z.literal(true).nullable(),
  /** false: a stock behaviour you don't track (the app hides it). */
  tracked: z.literal(false).nullable(),
  // With include:["magnitudes"] only:
  unit: z.string().nullable().optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  choices: z.string().nullable().optional(),
  time_q: z.string().nullable().optional(),
});

export const BehaviorImpactRow = z.object({
  /** Personal impacts only: pass as impact_id for detail. */
  id: z.string().nullable(),
  name: z.string(),
  /** Recovery impact in percent. */
  pct: z.number().nullable(),
  dir: z.enum(["positive", "negative", "neutral", "insufficient"]),
  /** Member-average card, not your data; no detail. */
  rec: z.literal(true).nullable(),
});

export const JournalV2Out = z.object({
  date: z.iso.date(),
  reviewed: z.boolean().nullable(),
  notes: z.string().nullable(),
  answered: z.array(JournalAnsweredRow),
  /** [id, name] pairs. */
  unanswered: z.array(z.tuple([z.number().int(), z.string()])).optional(),
  catalog: z.object({
    source: z.literal("bundled").nullable(),
    total: z.number().int(),
    matched: z.number().int(),
    truncated: z.literal(true).nullable(),
    /** Unfiltered calls: behaviour count per category, to filter by. */
    categories: z.record(z.string(), z.number().int()).nullable(),
    rows: z.array(BehaviorCatalogRow),
  }).optional(),
  impact: z.object({
    personal: z.number().int(),
    rows: z.array(BehaviorImpactRow),
    detail: BehaviorImpactOut.nullable(),
  }).optional(),
  warnings: z.array(z.string()),
});

export const JournalLogRow = z.object({
  /** Only when several dates were written. */
  date: z.iso.date().nullable(),
  id: z.number().int(),
  name: z.string(),
  yes: z.boolean().nullable(),
  value: z.number().nullable(),
  label: z.string().nullable(),
  time: IsoDateTime.nullable(),
  unset: z.literal(true).nullable(),
  /** Stored fields re-sent because WHOOP replaces a row whole. */
  carried: z.array(z.string()),
});

export const JournalLogV2Out = withPreview(z.object({
  written: z.literal(true),
  method: z.enum(["partial", "full"]),
  /** >1 when menstruation and ovulation had to go separately. */
  requests: z.number().int().nullable(),
  dates: z.array(z.iso.date()),
  rows: z.array(JournalLogRow),
  /** Full PUT only: the day's notes before and after. */
  notes: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable(),
  /** replace_day: names of the answers it removed. */
  removed: z.array(z.string()),
  verified: z.boolean(),
  mismatches: z.array(z.object({
    date: z.iso.date(),
    id: z.number().int().nullable(),
    field: z.string(),
    expected: Scalar,
    actual: Scalar,
  })),
  warnings: z.array(z.string()),
}));
