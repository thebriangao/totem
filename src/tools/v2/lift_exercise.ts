// whoop_lift_exercise (R): replaces whoop_lift_exercise, whoop_lift_progression and
// whoop_lift_prs (+ the proposed one-rep-max read).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { LiftExerciseOutV2 } from "../../schemas/strength_v2.js";
import {
  PR_COLS,
  cardsUnit,
  exerciseMeta,
  historySession,
  oneRepMaxCard,
  oneRepMaxEntries,
  oneRepMaxRows,
  prRows,
  progressionRows,
} from "../../projections/lift_exercise_v2.js";
import { parseLiftCards } from "../../projections/lift_cards.js";
import { ExerciseResolver } from "../../lib/lift_catalog.js";
import { get } from "../../whoop/bff.js";
import { runPaced } from "../../lib/concurrency.js";
import { todayIso } from "../../lib/dates.js";
import { errorMessage, liftError } from "../../lib/lift_tool.js";

const TOOL = "whoop_lift_exercise";
const PR_PAGES = 5;
const INCLUDES = ["history", "records", "one_rep_max", "progression", "instructions"] as const;
type Include = (typeof INCLUDES)[number];

async function prList(client: WhoopClient, cursor: string | undefined) {
  const start = cursor ? Number(cursor) : 0;
  if (!Number.isInteger(start) || start < 0) throw new Error(`cursor "${cursor}" isn't a PR offset; pass a returned next.`);
  const pages: unknown[] = [];
  let offset = start;
  let more = true;
  for (let i = 0; i < PR_PAGES && more; i++) {
    const page = await client.get("/weightlifting-service/v3/prs", offset ? { offset } : {});
    pages.push(page);
    more = get(page, "show_more") === true;
    const next = Number(get(page, "next_exercise_offset"));
    offset = Number.isFinite(next) && next > offset ? next : offset + 10;
  }
  return { mode: "prs" as const, cols: PR_COLS, prs: prRows(pages), next: more ? String(offset) : null, warnings: [] };
}

export function registerLiftExercise(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: TOOL,
    description:
      "One exercise: metadata (format, e1rm eligibility, custom/linked), workout history (sets as [weight, reps], or [weight, seconds] if timed), medal records, 1RM (value, estimated/manual, history rows [date, value, source, entry_id] — entry_id feeds whoop_lift_exercise_set). Without an exercise: your PR list (deleted customs dropped; no dates; a tile can outlive the deleted activity that set it). Weights in `unit`. cursor = a returned next.",
    input: {
      exercise_id: z.string().optional().describe("Catalog id (e.g. BENCHPRESS_BARBELL) or custom UUID."),
      name: z.string().optional().describe("Exact exercise name; a miss returns suggestions."),
      include: z.array(z.enum(INCLUDES)).optional().describe("Default history, records, one_rep_max."),
      cursor: z.string().optional().describe("A returned next (history or PR page)."),
      end_date: z.iso.date().optional().describe("Progression end date; default today."),
    },
    annotations: READ_ONLY,
  }, async ({ exercise_id, name, include, cursor, end_date }) => {
    if (!exercise_id && !name) return respond(TOOL, LiftExerciseOutV2, await prList(client, cursor));

    const warnings: string[] = [];
    const wanted = new Set<Include>(include ?? ["history", "records", "one_rep_max"]);
    const resolver = new ExerciseResolver(client);
    let id = exercise_id?.trim();
    let catalogRow: unknown = null;
    if (!id) {
      const r = await resolver.resolve({ name });
      if (!r.ok) return liftError({ error: r.error, suggestions: r.suggestions });
      id = r.exercise.exercise_id;
      catalogRow = r.exercise.row;
    }

    let meta;
    try {
      // v1 answers for catalog ids, custom UUIDs and soft-deleted customs.
      meta = exerciseMeta(await client.get(`/weightlifting-service/v1/exercise/${encodeURIComponent(id)}`), wanted.has("instructions"));
    } catch (e) {
      if (!catalogRow) {
        const r = await resolver.resolve({ exercise_id: id });
        if (!r.ok) return liftError({ error: r.error, suggestions: r.suggestions });
        catalogRow = r.exercise.row;
      }
      meta = exerciseMeta(catalogRow, wanted.has("instructions"));
      warnings.push(`Exercise detail failed (${errorMessage(e)}); metadata from the catalog.`);
    }
    if (meta.deleted) warnings.push("This custom exercise is deleted.");

    const enc = encodeURIComponent(id);
    const base = `/weightlifting-service/v3/exercise/${enc}`;
    const orm = `/weightlifting-service/v3/one-rep-max/${enc}`;
    const tasks: Array<[string, () => Promise<unknown>]> = [];
    if (wanted.has("history")) tasks.push(["history", () => client.get(`${base}/exercise_history`, cursor ? { startDate: cursor } : {})]);
    if (wanted.has("records")) tasks.push(["records", () => client.get(`${base}/personal_records`)]);
    if (wanted.has("one_rep_max")) {
      tasks.push(["1rm", () => client.get(orm)]);
      tasks.push(["1rm history", () => client.get(`${orm}/history`)]);
    }
    if (wanted.has("progression")) tasks.push(["progression", () => client.get(`/progression-service/v3/exercise/${enc}`, { endDate: end_date ?? todayIso() })]);
    const results = new Map(
      (await runPaced(tasks.map(([key, load]) => async () => {
        try {
          return [key, await load()] as const;
        } catch (e) {
          warnings.push(`${key} failed: ${errorMessage(e)}`);
          return [key, undefined] as const;
        }
      }), { concurrency: 3, jitterMaxMs: 80 })),
    );
    const got = (key: string) => results.get(key);

    let unit: "kg" | "lb" | null = null;
    const out: Record<string, unknown> = { mode: "exercise", exercise: meta };
    if (got("history") !== undefined) {
      const { cards, next_cursor } = parseLiftCards(got("history"));
      unit = cardsUnit(cards);
      out.history = { sessions: cards.map(historySession), next: next_cursor };
    }
    if (got("records") !== undefined) {
      const { cards } = parseLiftCards(got("records"));
      unit = unit ?? cardsUnit(cards);
      out.records = cards.map((c) => ({ medal: c.medal, date: c.date, value: c.record.value }));
      out.record_unit = cards[0]?.record.unit ?? null;
    }
    if (wanted.has("one_rep_max")) {
      if (got("1rm") === undefined) out.one_rep_max = null;
      else {
        const { unit: ormUnit, ...card } = oneRepMaxCard(got("1rm"));
        unit = unit ?? ormUnit;
        const history = got("1rm history") === undefined ? undefined : oneRepMaxRows(oneRepMaxEntries(got("1rm history")));
        out.one_rep_max = history ? { ...card, history } : card;
        if (meta.e1rm === false) warnings.push("Not e1RM-eligible: WHOOP shows only manual 1RM entries.");
      }
    }
    if (wanted.has("progression")) out.progression = got("progression") === undefined ? null : progressionRows(got("progression"));
    out.unit = unit;
    out.warnings = warnings;
    return respond(TOOL, LiftExerciseOutV2, out);
  });
}
