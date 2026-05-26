import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JournalCatalogOut } from "../../schemas/journal.js";
import { BEHAVIORS } from "../../data/behaviors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { markConsulted } from "../../whoop/session_state.js";

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
    "Browse the 308-behavior catalog. Filter by category or substring. Used to find behavior IDs for whoop_journal_log.",
    {
      category: z.enum(CATEGORIES).optional(),
      search: z.string().optional(),
      magnitude_type: z.enum(["bare", "boolean", "magnitude"]).optional(),
      limit: z.number().int().min(1).max(308).default(100),
    },
    async ({ category, search, magnitude_type, limit }) => {
      markConsulted("behaviors");
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
