import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { JournalAutopopOut } from "../../schemas/journal.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerJournalAutopop(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_journal_autopop",
    "WRITE: trigger Whoop to auto-populate the journal from inferred behaviors (HealthKit data, workout patterns).",
    {
      cycle_id: z.number().int().describe("Get from whoop_journal or whoop_today."),
      confirm: z.boolean().default(false),
    },
    async ({ cycle_id, confirm }) => {
      const path = `/autopop-service/v1/autopop/JOURNAL/${cycle_id}`;
      if (!confirm) {
        return { content: [{ type: "text", text: jsonOut(preview("PUT", path, { cycle_id })) }] };
      }
      await client.put(path, {});
      const out = JournalAutopopOut.parse({ triggered: true as const, cycle_id });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
