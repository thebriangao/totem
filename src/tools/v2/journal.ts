// whoop_journal (R): the day's journal answers, plus the live behaviour catalog
// and behaviour impact on request. Replaces whoop_journal, whoop_journal_catalog
// and whoop_behavior_impact (SPEC.md §3.1, D15).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { JournalV2Out } from "../../schemas/journal_v2.js";
import { isDraftBody, loadBehaviorCatalog, parseDraft } from "../../lib/journal_behaviors.js";
import { projectBehaviorCatalog, projectBehaviorImpacts, projectJournalDay } from "../../projections/journal_v2.js";
import { projectBehaviorImpact } from "../../projections/behavior_impact.js";
import { todayIso } from "../../lib/dates.js";
import { WhoopApiError } from "../../whoop/errors.js";

const NAME = "whoop_journal";

export function registerJournal(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "Journal for a date (default today): answered behaviours (yes/no, value, time) and notes. include: unanswered; catalog (your " +
      "behaviour ids and names, custom too; filter with search or category); magnitudes (ranges and step choices on catalog rows); " +
      "impact (how behaviours move your recovery). impact_id: one personal impact's detail.",
    input: {
      date: z.iso.date().optional(),
      include: z.array(z.enum(["unanswered", "catalog", "magnitudes", "impact"])).optional(),
      search: z.string().optional(),
      category: z.string().optional().describe("e.g. Supplements"),
      impact_id: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, async ({ date, include, search, category, impact_id }) => {
    const d = date ?? todayIso();
    const wants = new Set<string>(include ?? []);
    if (search !== undefined || category !== undefined || wants.has("magnitudes")) wants.add("catalog");
    if (impact_id !== undefined) wants.add("impact");
    const warnings: string[] = [];

    const [rawDraft, catalog, rawImpact] = await Promise.all([
      client.get(`/journal-service/v3/journals/drafts/mobile/${d}`),
      wants.has("catalog") ? loadBehaviorCatalog(client, d) : Promise.resolve(null),
      wants.has("impact")
        ? client.get("/behavior-impact-service/v1/impact").catch((e: unknown) => {
            warnings.push(`Behaviour impact unavailable: ${(e as Error).message}`);
            return null;
          })
        : Promise.resolve(null),
    ]);

    // An empty day still has `journal.tracked_behaviors: []`; a body without it isn't an empty day.
    if (!isDraftBody(rawDraft)) warnings.push("WHOOP's journal response had an unexpected shape, so this day may not really be empty.");
    const out: Record<string, unknown> = { ...projectJournalDay(parseDraft(rawDraft, d), { includeUnanswered: wants.has("unanswered") }) };

    if (catalog) {
      if (catalog.warning) warnings.push(catalog.warning);
      out.catalog = projectBehaviorCatalog(catalog, { search, category, detail: wants.has("magnitudes") });
    }

    if (wants.has("impact")) {
      const impacts = rawImpact === null ? { personal: 0, rows: [] } : projectBehaviorImpacts(rawImpact);
      let detail = null;
      if (impact_id !== undefined) {
        const card = impacts.rows.find((i) => i.uuid === impact_id);
        if (card?.rec) {
          warnings.push(`"${card.name}" is a member-average card, not your data; WHOOP has no detail for it.`);
        } else {
          try {
            detail = projectBehaviorImpact(await client.get(`/behavior-impact-service/v2/impact/details/${encodeURIComponent(impact_id)}`), impact_id);
          } catch (e) {
            // 400 for an unknown impact uuid; 404 for an id that isn't a uuid at all (live 2026-11-21).
            if (!(e instanceof WhoopApiError && (e.status === 400 || e.status === 404))) throw e;
            warnings.push(`WHOOP has no personal impact ${impact_id}; only your own impacts have detail (their id is on the impact rows).`);
          }
        }
      }
      if (rawImpact !== null && impacts.personal === 0) {
        warnings.push("No personal impacts yet (WHOOP needs weeks of journal answers); rec:true rows are member averages.");
      }
      out.impact = { personal: impacts.personal, rows: impacts.rows.map(({ uuid: _uuid, ...row }) => row), detail };
    }

    out.warnings = warnings;
    return respond(NAME, JournalV2Out, out);
  });
}
