import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { SymptomLogOut } from "../../schemas/womens_health.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";

export function registerSymptomLog(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_symptom_log",
    "WRITE: log women's-health symptoms for a date via menstruation (none, spotting, light_flow, medium_flow, heavy_flow), cervical_mucus (5 discharge types — see the param enum; omit to clear), and/or symptoms[] referencing behavior_tracker_ids. Women's-health tracking must be set up.",
    {
      date: z.iso.date(),
      menstruation: z.enum(["none", "spotting", "light_flow", "medium_flow", "heavy_flow"]).optional(),
      cervical_mucus: z
        .enum([
          "vaginal-discharge---egg-white",
          "vaginal-discharge---creamy",
          "vaginal-discharge---sticky",
          "vaginal-discharge---watery",
          "vaginal-discharge---grey",
        ])
        .optional()
        .describe("Omit field entirely to clear; the API rejects 'none' with 422."),
      symptoms: z
        .array(z.object({
          behavior_tracker_id: z.number().int(),
          answered_yes: z.boolean().optional(),
        }))
        .default([]),
      confirm: z.boolean().default(false),
    },
    WRITE_DESTRUCTIVE,
    async ({ date, menstruation, cervical_mucus, symptoms, confirm }) => {
      // zod fills the default [] on the MCP path, but guard anyway so a
      // menstruation/cervical_mucus-only call can never trip on undefined.
      const syms = symptoms ?? [];
      const path = "/womens-health-service/v1/symptom-insights/log/symptoms";
      const body: Record<string, unknown> = {
        tracker_inputs: syms.map((s) => ({
          is_suggested: false,
          behavior_tracker_id: s.behavior_tracker_id,
          ...(s.answered_yes !== undefined ? { answered_yes: s.answered_yes } : {}),
        })),
      };
      if (menstruation !== undefined) body.menstruation = menstruation;
      if (cervical_mucus !== undefined) body.cervical_mucus = cervical_mucus;
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: jsonOut(
                preview("POST", `${path}?requestDate=${date}`, {
                  date,
                  menstruation,
                  cervical_mucus,
                  symptoms_count: syms.length,
                }),
              ),
            },
          ],
        };
      }
      await client.post(path, body, { requestDate: date });
      const out = SymptomLogOut.parse({
        logged: true as const,
        date,
        symptoms_count: syms.length,
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
