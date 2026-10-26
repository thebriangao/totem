import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { ProfileUpdateOut } from "../../schemas/settings.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { isObject } from "../../lib/walk.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";

const PATH = "/profile-service/v1/profile";

export function registerProfileUpdate(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_profile_update",
    "WRITE: change any profile field(s) — pass ONLY what you want to change and the tool fetches your current profile and merges, backfilling everything you didn't touch (Whoop's PUT is non-partial and 422s on a sparse body). Weight is kg and height is meters; preview unless confirm:true.",
    {
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.email().optional(),
      birthday: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional().describe("YYYY-MM-DD. ISO datetimes accepted (auto-trimmed)."),
      gender: z.enum(["MALE", "FEMALE", "NON_BINARY"]).optional().describe("Whoop's API rejects UNSPECIFIED; pick one or omit."),
      physiological_baseline: z.enum(["MALE", "FEMALE"]).optional().describe("Defaults to your current value (or gender) if omitted."),
      weight_kg: z.number().positive().optional().describe("Kilograms (wire format is metric regardless of unit_system)."),
      height_m: z.number().positive().optional().describe("Meters (wire format is metric regardless of unit_system)."),
      city: z.string().optional(),
      state: z.string().optional().describe("e.g. 'CA'. Required when country='US' — auto-kept from your current profile if you don't change it."),
      country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("ISO-3166 alpha-2."),
      unit_system: z.enum(["imperial", "metric"]).optional().describe("Display preference only."),
      confirm: z.boolean().default(false),
    },
    WRITE_DESTRUCTIVE,
    async (args) => {
      const { confirm, weight_kg, height_m, birthday } = args;
      const changed = Object.entries(args)
        .filter(([key, value]) => key !== "confirm" && value !== undefined)
        .map(([key]) => key);
      if (changed.length === 0) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "Provide at least one profile field to update." }) }],
          isError: true,
        };
      }

      // The PUT is non-partial (a sparse body → 422), so pull the current profile
      // and overlay only what the caller passed. Every field stays editable.
      const boot = await client.get<Record<string, unknown>>("/users-service/v2/bootstrap");
      const u = isObject(boot.user) ? boot.user : {};
      const p = isObject(boot.profile) ? boot.profile : {};
      const acc = isObject(boot.account) ? boot.account : {};
      const curGender = typeof p.gender === "string" ? p.gender.toUpperCase() : undefined;
      // Birthday is stored as midnight-local (e.g. "...T17:00:00-07:00" == next-day
      // midnight UTC); the UTC calendar date is the actual birthday.
      const birthdayMs = typeof p.birthday === "string" ? Date.parse(p.birthday) : NaN;
      const curBirthday = Number.isNaN(birthdayMs) ? undefined : new Date(birthdayMs).toISOString().slice(0, 10);
      const curBaseline = typeof p.physiological_baseline === "string" ? p.physiological_baseline.toUpperCase() : undefined;

      const merged: Record<string, unknown> = {
        first_name: args.first_name ?? u.first_name,
        last_name: args.last_name ?? u.last_name,
        email: args.email ?? acc.email,
        birthday: (birthday ? birthday.slice(0, 10) : undefined) ?? curBirthday,
        gender: args.gender ?? curGender,
        physiological_baseline: args.physiological_baseline ?? curBaseline ?? (curGender === "FEMALE" ? "FEMALE" : "MALE"),
        weight: weight_kg ?? (typeof p.weight === "number" ? p.weight : undefined),
        height: height_m ?? (typeof p.height === "number" ? p.height : undefined),
        city: args.city ?? u.city,
        state: args.state ?? u.admin_division,
        country: args.country?.toUpperCase() ?? u.country,
        unit_system: args.unit_system ?? p.unit_system,
      };
      for (const k of Object.keys(merged)) if (merged[k] === undefined || merged[k] === null) delete merged[k];
      const current: Record<string, unknown> = {
        first_name: u.first_name,
        last_name: u.last_name,
        email: acc.email,
        birthday: curBirthday,
        gender: curGender,
        physiological_baseline: curBaseline ?? (curGender === "FEMALE" ? "FEMALE" : "MALE"),
        weight: typeof p.weight === "number" ? p.weight : undefined,
        height: typeof p.height === "number" ? p.height : undefined,
        city: u.city,
        state: u.admin_division,
        country: u.country,
        unit_system: p.unit_system,
      };
      for (const k of Object.keys(current)) if (current[k] === undefined || current[k] === null) delete current[k];

      if (merged.country === "US" && (typeof merged.state !== "string" || merged.state.trim() === "")) {
        return {
          content: [{ type: "text", text: jsonOut({ error: "A non-empty state is required when country is US." }) }],
          isError: true,
        };
      }

      if (!confirm) {
        return {
          content: [{ type: "text", text: jsonOut(preview("PUT", PATH, { fields_changed: changed, full_body_fields: Object.keys(merged) })) }],
        };
      }
      const noChange = JSON.stringify(merged) === JSON.stringify(current);
      if (noChange) {
        const out = ProfileUpdateOut.parse({ updated: false, no_change: true, fields_updated: changed });
        return { content: [{ type: "text", text: jsonOut(out) }] };
      }
      await client.put(PATH, merged);
      const out = ProfileUpdateOut.parse({ updated: true, no_change: false, fields_updated: changed });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
