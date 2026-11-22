// whoop_hr_zones_set (W!): max HR, custom zones, or reset to WHOOP's defaults
// (SPEC.md §4.8 HR zones, §7 S7). Read back from bff/settings: the maxhr
// response shows heart-rate-reserve zones even while custom zones stay in force.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond, type ToolResult } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { HrZonesSetV2Out } from "../../schemas/settings_v2.js";
import { hrZonesOut, parseHrZones, type HrZonesState, type ZoneId, type ZoneRow } from "../../projections/settings_v2.js";
import { preview } from "../../whoop/write_safety.js";
import { jsonOut } from "../../whoop/json_out.js";

const NAME = "whoop_hr_zones_set";
const ZONES = "/hr-zones-service/v1/bff/zones";
const SETTINGS = "/hr-zones-service/v1/bff/settings";
const MAXHR = "/hr-zones-service/v1/maxhr";
const CUSTOM = "/hr-zones-service/v1/bff/custom";
const IDS: ZoneId[] = ["ZONE_1", "ZONE_2", "ZONE_3", "ZONE_4", "ZONE_5"];

function fail(error: string): ToolResult {
  return { content: [{ type: "text", text: jsonOut({ error }) }], isError: true };
}

/** Rows Z1..Z5 → the [min,max] pairs. */
const pairs = (rows: ZoneRow[]) => IDS.map((id) => rows.find((r) => r.id === id)).map((r) => (r ? [r.min, r.max] : null));
const sameZones = (a: ZoneRow[], b: ZoneRow[]) => JSON.stringify(pairs(a)) === JSON.stringify(pairs(b));

/** S7: five zones, each min < max, contiguous (min = previous max + 1). */
export function validateCustomZones(zones: Array<[number, number]>, maxHr: number | null): string | null {
  if (zones.length !== 5) return "Pass exactly 5 zones, Z1..Z5.";
  for (let i = 0; i < 5; i++) {
    const [min, max] = zones[i]!;
    if (min >= max) return `Z${i + 1} needs min below max.`;
    if (i > 0 && min !== zones[i - 1]![1] + 1) {
      return `Zones must be contiguous: Z${i + 1} has to start at ${zones[i - 1]![1] + 1} (Z${i} max + 1); WHOOP rejects gaps and overlaps.`;
    }
  }
  if (maxHr !== null && zones[4]![1] > maxHr) return `Z5 max ${zones[4]![1]} is above your max HR ${maxHr}; set max HR first (action max_hr) or lower Z5.`;
  return null;
}

export function registerHrZonesSet(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "Set heart-rate zones. max_hr: set max_heart_rate (WHOOP recomputes its default zones; custom zones stay in force). custom: zones " +
      "as 5 [min, max] bpm pairs Z1..Z5, contiguous (each min = previous max + 1), Z5 max at most your max HR. reset: back to WHOOP's " +
      "defaults. Previews unless confirm:true.",
    input: {
      action: z.enum(["max_hr", "custom", "reset"]),
      max_heart_rate: z.number().int().min(101).max(220).optional(),
      zones: z.array(z.tuple([z.number().int().min(0), z.number().int().min(1)])).optional(),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async ({ action, max_heart_rate, zones, confirm }) => {
    if (action === "max_hr" && max_heart_rate === undefined) return fail("action max_hr needs max_heart_rate.");
    if (action === "custom" && zones === undefined) return fail("action custom needs zones.");
    if (action !== "custom" && zones !== undefined) return fail("zones only go with action custom.");
    if (action !== "max_hr" && max_heart_rate !== undefined) return fail("max_heart_rate only goes with action max_hr.");
    if (action === "custom") {
      const err = validateCustomZones(zones!, null);
      if (err) return fail(err);
    }

    // Fresh pre-read: the defaults (reset), max HR (Z5 rule) and the before-state.
    const warnings: string[] = [];
    const read = async (): Promise<HrZonesState | null> => {
      const [z1, s1] = await Promise.all([
        client.get(ZONES, {}, { fresh: true }).catch(() => null),
        client.get(SETTINGS, {}, { fresh: true }).catch(() => null),
      ]);
      return s1 === null ? null : parseHrZones({ zones: z1, settings: s1 });
    };
    const before = await read();
    if (!before) {
      if (action === "reset") return fail("Couldn't read WHOOP's default zones, so reset can't be built. Nothing was sent.");
      warnings.push("Couldn't read the current zones first; no before-state.");
    }

    let path: string;
    let body: unknown;
    let target: ZoneRow[] | null = null;
    if (action === "max_hr") {
      if (before?.max_hr === max_heart_rate) {
        return respond(NAME, HrZonesSetV2Out, { action, updated: false, no_change: true, before: hrZonesOut(before!), after: null, verified: true, warnings });
      }
      path = MAXHR;
      body = { max_heart_rate };
      if (before?.is_custom) warnings.push("Your zones are custom, so they stay in force; only the default zones are recomputed (use reset to switch to them).");
    } else if (action === "custom") {
      const err = validateCustomZones(zones!, before?.max_hr ?? null);
      if (err) return fail(err);
      target = IDS.map((id, i) => ({ id, min: zones![i]![0], max: zones![i]![1] }));
      if (before?.is_custom && sameZones(before.zones, target)) {
        return respond(NAME, HrZonesSetV2Out, { action, updated: false, no_change: true, before: hrZonesOut(before), after: null, verified: true, warnings });
      }
      path = CUSTOM;
      body = { zones: target, is_custom: true };
    } else {
      target = IDS.map((id) => before!.default_zones.find((z) => z.id === id)).filter((z): z is ZoneRow => z !== undefined);
      if (target.length !== 5) return fail("WHOOP's default zones are incomplete, so reset can't be built. Nothing was sent.");
      // Not flagged custom doesn't prove the defaults are in force: WHOOP stores
      // whatever zones arrive with is_custom:false, so compare the zones too.
      if (before!.is_custom === false && sameZones(before!.zones, target)) {
        return respond(NAME, HrZonesSetV2Out, { action, updated: false, no_change: true, before: hrZonesOut(before!), after: null, verified: true, warnings });
      }
      path = CUSTOM;
      body = { zones: target.map(({ id, min, max }) => ({ id, min, max })), is_custom: false };
    }

    if (!confirm) {
      return respond(NAME, HrZonesSetV2Out, preview("POST", path, {
        before: before ? hrZonesOut(before) : null,
        ...(target ? { zones: pairs(target) } : { max_heart_rate }),
        ...(warnings.length > 0 ? { warnings } : {}),
      }));
    }

    await client.post(path, body);

    const after = await read();
    let verified = after !== null;
    if (!after) warnings.push("Couldn't read the zones back to verify.");
    else if (action === "max_hr") verified = after.max_hr === max_heart_rate;
    else if (action === "custom") verified = after.is_custom === true && sameZones(after.zones, target!);
    else verified = after.is_custom === false && sameZones(after.zones, target!);
    if (after && !verified) warnings.push("WHOOP accepted the write but the zones read back differently; check after/before.");
    return respond(NAME, HrZonesSetV2Out, {
      action,
      updated: true,
      no_change: false,
      before: before ? hrZonesOut(before) : null,
      after: after ? hrZonesOut(after) : null,
      verified,
      warnings,
    });
  });
}
