// whoop_profile_update (W!): change profile fields (SPEC.md §4.8, §7 S6).
//
// PUT /profile-service/v1/profile is a full replace, so the body is merged from
// a fresh read of the profile-edit screen (bootstrap's gender is a display
// string and its baseline is always null). Omitting `city` clears it, so it's
// always carried; omitting `physiological_baseline` keeps it, so it's only sent
// when asked. WHOOP answers `false` (HTTP 200) when it refuses the values.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond, type ToolResult } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { ProfileUpdateV2Out } from "../../schemas/profile_v2.js";
import { parseProfileEdit, type EditableProfile } from "../../projections/profile_v2.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";
import { toKg } from "../../whoop/units.js";
import { todayIso } from "../../lib/dates.js";
import { BASELINES, GENDERS, HEIGHT_M, UNIT_SYSTEMS, WEIGHT_KG } from "../../lib/profile_settings.js";

const NAME = "whoop_profile_update";
const PATH = "/profile-service/v1/profile";
const EDIT = "/profile-service/v1/profile/bff/edit";

function fail(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: jsonOut({ error, ...extra }) }], isError: true };
}

type Field = "first_name" | "last_name" | "birthday" | "gender" | "physiological_baseline" | "weight" | "height" | "city" | "state" | "country" | "unit_system";
type Value = string | number | null;

const same = (a: Value, b: Value) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.005 : a === b;

export function registerProfileUpdate(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "WRITE: change profile fields; pass only what changes. Totem reads your current profile fresh and sends the full body WHOOP requires, keeping everything else (city included; physiological baseline only changes if you pass it). Weight is kg or lb (24–272 kg), height m, cm or in (0.91–2.72 m). Changing birthday or country makes WHOOP end the session; totem refreshes the token on the next call. Email can't be changed here. Read back after writing; preview unless confirm:true.",
    input: {
      first_name: z.string().trim().min(1).optional(),
      last_name: z.string().trim().min(1).optional(),
      birthday: z.iso.date().optional().describe("YYYY-MM-DD."),
      gender: z.enum(GENDERS).optional(),
      physiological_baseline: z.enum(BASELINES).optional().describe("Sex used for physiology baselines. Unchanged unless passed."),
      weight: z.number().positive().optional(),
      weight_unit: z.enum(["kg", "lb"]).optional().describe("Default kg."),
      height: z.number().positive().optional(),
      height_unit: z.enum(["m", "cm", "in"]).optional().describe("Default m."),
      city: z.string().trim().optional(),
      state: z.string().trim().min(1).optional().describe("Region code, e.g. CA. Required for US."),
      country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("ISO 3166 alpha-2."),
      unit_system: z.enum(UNIT_SYSTEMS).optional().describe("Display units; also how WHOOP reads lift weights."),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async (args) => {
    // 1. Validate before reading anything.
    const wanted: Partial<Record<Field, Value>> = {};
    if (args.first_name !== undefined) wanted.first_name = args.first_name;
    if (args.last_name !== undefined) wanted.last_name = args.last_name;
    if (args.birthday !== undefined) {
      if (args.birthday > todayIso()) return fail("Birthday can't be in the future.");
      wanted.birthday = args.birthday;
    }
    if (args.gender !== undefined) wanted.gender = args.gender;
    if (args.physiological_baseline !== undefined) wanted.physiological_baseline = args.physiological_baseline;
    if (args.weight_unit !== undefined && args.weight === undefined) return fail("weight_unit needs weight.");
    if (args.height_unit !== undefined && args.height === undefined) return fail("height_unit needs height.");
    if (args.weight !== undefined) {
      const kg = Math.round(toKg(args.weight, args.weight_unit ?? "kg") * 100) / 100;
      if (kg < WEIGHT_KG.min || kg > WEIGHT_KG.max) return fail(`Weight must be ${WEIGHT_KG.min}–${WEIGHT_KG.max} kg; got ${kg} kg.`);
      wanted.weight = kg;
    }
    if (args.height !== undefined) {
      const factor = { m: 1, cm: 0.01, in: 0.0254 }[args.height_unit ?? "m"];
      const m = Math.round(args.height * factor * 1000) / 1000;
      if (m < HEIGHT_M.min || m > HEIGHT_M.max) return fail(`Height must be ${HEIGHT_M.min}–${HEIGHT_M.max} m; got ${m} m.`);
      wanted.height = m;
    }
    if (args.city !== undefined) wanted.city = args.city === "" ? null : args.city;
    if (args.state !== undefined) wanted.state = args.state.toUpperCase();
    if (args.country !== undefined) wanted.country = args.country.toUpperCase();
    if (args.unit_system !== undefined) wanted.unit_system = args.unit_system;
    if (Object.keys(wanted).length === 0) return fail("Pass at least one profile field to change.");

    // 2. Fresh merge base: the profile-edit screen (never bootstrap).
    const current = parseProfileEdit(await client.get(EDIT, {}, { fresh: true }));
    if (!current) return fail("Couldn't read your current profile, so nothing was sent (WHOOP's PUT replaces the whole profile).");

    // A state from the old country doesn't belong to a new one.
    if (wanted.country !== undefined && wanted.country !== current.country && wanted.state === undefined) wanted.state = null;
    const next: EditableProfile = { ...current };
    for (const [k, v] of Object.entries(wanted) as Array<[Field, Value]>) (next as unknown as Record<string, Value>)[k] = v;

    const missing = (["first_name", "last_name", "gender", "unit_system", "height", "weight"] as const).filter((k) => next[k] === null);
    if (missing.length > 0) return fail(`Your WHOOP profile has no ${missing.join(", ")}; pass ${missing.length > 1 ? "them" : "it"} too (WHOOP requires the full profile).`);
    if (next.country === "US" && !next.state) return fail("WHOOP requires a state for US profiles; pass state.");

    const changes: Partial<Record<Field, [Value, Value]>> = {};
    for (const [k, v] of Object.entries(wanted) as Array<[Field, Value]>) {
      const before = current[k] as Value;
      if (!same(before, v)) changes[k] = [before, v];
    }
    if (Object.keys(changes).length === 0) {
      return respond(NAME, ProfileUpdateV2Out, { updated: false, no_change: true, changed: {}, verified: true, mismatches: [], warnings: [] });
    }

    const warnings: string[] = [];
    if (changes.birthday || changes.country) {
      warnings.push("WHOOP ends the current session after a birthday or country change; totem refreshes the token automatically on the next request (one retry).");
    }
    if (changes.weight) warnings.push("A newer weight reading (whoop_weight_log) replaces the profile weight.");
    if (changes.unit_system) warnings.push("WHOOP reads lift, template and 1RM weights in the display unit, so this also changes how those writes are interpreted.");

    const body: Record<string, unknown> = {
      first_name: next.first_name,
      last_name: next.last_name,
      email: next.email,
      birthday: next.birthday,
      gender: next.gender,
      weight: next.weight,
      height: next.height,
      country: next.country,
      unit_system: next.unit_system,
    };
    if (next.city !== null) body.city = next.city; // omitting city clears it, so carry it whenever it's set
    if (next.state !== null) body.state = next.state;
    if (wanted.physiological_baseline !== undefined) body.physiological_baseline = next.physiological_baseline; // omitted = kept
    for (const k of Object.keys(body)) if (body[k] === null) delete body[k];

    if (!args.confirm) {
      return respond(NAME, ProfileUpdateV2Out, preview("PUT", PATH, { changes, ...(warnings.length > 0 ? { warnings } : {}) }));
    }

    // 3. Send. `false` means WHOOP rejected the values and saved nothing.
    const result = await client.put(PATH, body);
    if (result === false) return fail("WHOOP refused these values (it answered false); nothing was saved.", { changes });

    // 4. Fresh read-back (a 401 here after a birthday/country change is refreshed and retried by the client).
    const after = parseProfileEdit(await client.get(EDIT, {}, { fresh: true }).catch(() => null));
    const changed: Record<string, [Value, Value]> = {};
    const mismatches: string[] = [];
    for (const [k, [before, to]] of Object.entries(changes) as Array<[Field, [Value, Value]]>) {
      const got = after ? (after[k] as Value) : to;
      changed[k] = [before, got];
      if (after && !same(got, to)) mismatches.push(`${k}: sent ${String(to)}, WHOOP shows ${String(got)}`);
    }
    if (!after) warnings.push("Couldn't read the profile back to verify.");
    return respond(NAME, ProfileUpdateV2Out, {
      updated: true,
      no_change: false,
      changed,
      verified: after !== null && mismatches.length === 0,
      mismatches,
      warnings,
    });
  });
}
