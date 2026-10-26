import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JournalCatalogOut } from "../../schemas/journal.js";
import { BEHAVIORS } from "../../data/behaviors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { READ_ONLY } from "../annotations.js";

const CATEGORIES = [
  "Drugs & Medication",
  "Health & Symptoms",
  "Hormonal Health",
  "Lifestyle",
  "Mental Wellbeing",
  "Nutrition",
  "Recovery",
  "Sleep & Circadian Health",
  "Supplements",
] as const;

export function registerJournalCatalog(server: McpServer, _client: unknown): void {
  server.tool(
    "whoop_journal_catalog",
    "Search the 308-behavior journal catalog to get a behavior_tracker_id and its magnitude type for whoop_journal_log. Filter by substring, magnitude_type (bare, boolean, or magnitude), or category (Drugs & Medication, Health & Symptoms, Hormonal Health, Lifestyle, Mental Wellbeing, Nutrition, Recovery, Sleep & Circadian Health, Supplements).",
    {
      category: z.enum(CATEGORIES).optional(),
      search: z.string().optional(),
      magnitude_type: z.enum(["bare", "boolean", "magnitude"]).optional(),
      limit: z.number().int().min(1).max(308).default(100),
    },
    READ_ONLY,
    async ({ category, search, magnitude_type, limit }) => {
      const s = search?.toLowerCase();
      const matches = BEHAVIORS.filter((b) => {
        if (category && b.category !== category) return false;
        if (s && !(b.title.toLowerCase().includes(s) || b.internal_name.toLowerCase().includes(s))) return false;
        if (magnitude_type && b.magnitude !== magnitude_type) return false;
        return true;
      });
      const out = JournalCatalogOut.parse({
        total_in_catalog: 308,
        matched: matches.length,
        truncated: matches.length > limit,
        behaviors: matches.slice(0, limit),
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
