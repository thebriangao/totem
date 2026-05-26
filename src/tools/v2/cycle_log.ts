import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CycleLogOut } from "../../schemas/womens_health.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

const PATH = "/womens-health-service/v1/menstrual-cycle-insights/log";

export function registerCycleLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_cycle_log",
    "WRITE: log period or ovulation for a date.",
    {
      date: z.iso.date(),
      period: z.boolean().optional(),
      period_flow: z.number().nullable().optional().describe("Magnitude if logging period."),
      ovulation: z.boolean().optional(),
      confirm: z.boolean().default(false),
    },
    async ({ date, period, period_flow, ovulation, confirm }) => {
      if (period === true && ovulation === true) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Cannot log period and ovulation on the same date — Whoop's API rejects this with 400. Pick one or call cycle_log twice on different dates." }) }],
          isError: true,
        };
      }
      const parts = date.split("-").map(Number);
      const y = parts[0] ?? 1970;
      const m = parts[1] ?? 1;
      const d = parts[2] ?? 1;
      const body = {
        period_logs: [
          {
            date: [y, m, d],
            period: { answered_yes: period ?? false, magnitude_input_value: period_flow ?? null },
            ovulation: { answered_yes: ovulation ?? false, magnitude_input_value: null },
          },
        ],
      };
      if (!confirm) {
        return {
          content: [{ type: "text", text: jsonOut(preview("PUT", PATH, { date, period, ovulation })) }],
        };
      }
      await client.put(PATH, body);
      const out = CycleLogOut.parse({ logged: true as const, date });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
