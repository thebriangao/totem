import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { JournalOut } from "../../schemas/journal.js";
import { projectJournal } from "../../projections/journal.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerJournal(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_journal",
    "Your journal entry for a date: tracked behaviors with values + human-readable names (resolved from the bundled catalog).",
    { date: z.iso.date().optional() },
    async ({ date }) => {
      const d = date ?? todayIso();
      // v3 drafts is the authoritative endpoint for "what did I log".
      // The v2 /behaviors/user/{date} endpoint returns the tracked-behaviors
      // catalog (which behaviors the user has enabled), not the entries.
      const raw = await client.get(`/journal-service/v3/journals/drafts/mobile/${d}`);
      const projected = projectJournal(raw, d);
      try {
        const out = JournalOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_journal", e);
        throw e;
      }
    },
  );
}
