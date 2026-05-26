import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { ProfileUpdateOut } from "../../schemas/settings.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

const PATH = "/profile-service/v1/profile";

export function registerProfileUpdate(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_profile_update",
    "WRITE: update profile (name, birthday, gender, weight, height, country/state, city, email). Wire format is metric.",
    {
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().describe("YYYY-MM-DD. ISO datetimes accepted (auto-trimmed)."),
      gender: z.enum(["MALE", "FEMALE", "NON_BINARY"]).optional().describe("Whoop's API rejects UNSPECIFIED; pick one or omit."),
      physiological_baseline: z.enum(["MALE", "FEMALE"]).optional(),
      weight_kg: z.number().positive().optional().describe("Wire format is metric; v2 takes kg only."),
      height_m: z.number().positive().optional().describe("Wire format is metric; v2 takes meters only."),
      city: z.string().optional(),
      state: z.string().optional().describe("e.g. 'CA'."),
      country: z.string().length(2).optional().describe("ISO-3166 alpha-2. If country='US', the API requires state to be set too — otherwise 400 'AdminDivision (state) must be set for US'."),
      unit_system: z.enum(["imperial", "metric"]).optional().describe("Display preference only."),
      confirm: z.boolean().default(false),
    },
    async (args) => {
      const { confirm, weight_kg, height_m, birthday, ...rest } = args;
      const body: Record<string, unknown> = { ...rest };
      if (weight_kg !== undefined) body.weight = weight_kg;
      if (height_m !== undefined) body.height = height_m;
      // Whoop's PUT rejects ISO datetime strings; only YYYY-MM-DD is accepted.
      if (birthday !== undefined) body.birthday = birthday.slice(0, 10);
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      const fields = Object.keys(body);
      if (!confirm) {
        return {
          content: [{ type: "text", text: jsonOut(preview("PUT", PATH, { fields_to_update: fields })) }],
        };
      }
      await client.put(PATH, body);
      const out = ProfileUpdateOut.parse({ updated: true as const, fields_updated: fields });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
