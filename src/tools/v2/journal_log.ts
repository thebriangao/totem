import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { JournalLogOut } from "../../schemas/journal.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { BEHAVIORS_BY_ID } from "../../data/behaviors.js";
import { gateError } from "../../whoop/session_state.js";

export function registerJournalLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_journal_log",
    "WRITE: save full journal entry for a date. Replaces existing entry. Requires calling whoop_journal_catalog first to see valid behavior_tracker_id values. Preview unless confirm:true.",
    {
      date: z.iso.date().optional(),
      behaviors: z.array(z.object({
        behavior_tracker_id: z.number().int(),
        answered_yes: z.boolean().optional(),
        magnitude_value: z.number().optional(),
        magnitude_label: z.string().optional(),
      })),
      notes: z.string().optional(),
      confirm: z.boolean().default(false),
    },
    async ({ date, behaviors, notes, confirm }) => {
      const gate = gateError("behaviors", "whoop_journal_catalog");
      if (gate) return { content: [{ type: "text", text: JSON.stringify(gate, null, 2) }], isError: true };
      const d = date ?? todayIso();
      const unknownIds = behaviors
        .filter((b) => !BEHAVIORS_BY_ID.has(b.behavior_tracker_id))
        .map((b) => b.behavior_tracker_id);
      if (unknownIds.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut({
                error: "Unknown behavior_tracker_id",
                unknown: unknownIds,
                hint: "Use whoop_journal_catalog",
              }),
            },
          ],
          isError: true,
        };
      }
      const tracker_inputs = behaviors.map((b) => {
        const input: Record<string, unknown> = { behavior_tracker_id: b.behavior_tracker_id };
        if (b.answered_yes !== undefined) input.answered_yes = b.answered_yes;
        if (b.magnitude_value !== undefined) {
          input.magnitude_input_value = b.magnitude_value;
          input.magnitude_input_label = b.magnitude_label ?? String(b.magnitude_value);
        }
        return input;
      });
      const body: Record<string, unknown> = { tracker_inputs };
      if (notes !== undefined) body.notes = notes;
      const path = `/journal-service/v2/journals/entries/user/date/${d}`;
      if (!confirm) {
        const sampleTitles = behaviors
          .slice(0, 5)
          .map((b) => BEHAVIORS_BY_ID.get(b.behavior_tracker_id)?.title ?? `#${b.behavior_tracker_id}`);
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("PUT", path, {
                  date: d,
                  behaviors_count: behaviors.length,
                  sample_titles: sampleTitles,
                }),
              ),
            },
          ],
        };
      }
      await client.put(path, body);
      const out = JournalLogOut.parse({ logged: true as const, date: d, behaviors_count: behaviors.length });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
