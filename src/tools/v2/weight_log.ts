import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE } from "../annotations.js";
import { WeightLogOut, type WeightReadingT } from "../../schemas/weight.js";
import { projectWeightReadings } from "../../projections/weight_readings.js";
import { buildMeasurementBody, round, WEIGHT_READINGS_PATH, type MeasurementBody } from "../../lib/weight_readings.js";
import { previewWith, toolError, writeRejected } from "../../lib/health_plans_write.js";
import { toKg } from "../../whoop/units.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { assertNotFuture, isoDay } from "../../lib/dates.js";
import { toLocalIso } from "../../lib/timezone.js";
import { fetchWeightPage } from "./weight.js";
import { instantInput, toInstantOpt } from "../../lib/instant.js";

const MAX_PAGES = 5;

interface Loaded {
  readings: WeightReadingT[];
  target: WeightReadingT | null;
}

/** Fresh readings, following next_cursor (up to MAX_PAGES) until `match` hits. */
export async function loadReadings(
  client: WhoopClient,
  match?: (r: WeightReadingT) => boolean,
): Promise<Loaded> {
  const readings: WeightReadingT[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const out = projectWeightReadings(await fetchWeightPage(client, cursor, true));
    readings.push(...out.readings);
    const target = match ? out.readings.find(match) ?? null : null;
    if (target || !match || !out.next_token) return { readings, target };
    cursor = out.next_token;
  }
  return { readings, target: null };
}

async function profileWeightKg(client: WhoopClient): Promise<number | null> {
  try {
    const boot = await client.get<{ profile?: { weight?: unknown } }>("/users-service/v2/bootstrap", {}, { fresh: true });
    const w = boot?.profile?.weight;
    return typeof w === "number" ? round(w, 2) : null;
  } catch {
    return null;
  }
}

const row = (r: WeightReadingT) => ({ at: r.timestamp, kg: r.weight_kg, fat_pct: r.body_fat_pct, lean_kg: r.lean_kg });

const sameInstant = (a: string, b: string): boolean => Math.abs(Date.parse(a) - Date.parse(b)) < 1000;

function matches(r: WeightReadingT, body: MeasurementBody, tsIso: string): boolean {
  const fat = body.body_fat_percent === null ? null : round(body.body_fat_percent * 100, 1);
  return sameInstant(r.timestamp, tsIso)
    && Math.abs(r.weight_kg - body.weight_kg) < 0.01
    && (fat === null ? r.body_fat_pct === null : r.body_fat_pct !== null && Math.abs(r.body_fat_pct - fat) < 0.15)
    && (body.lean_body_mass_kg === null ? r.lean_kg === null : r.lean_kg !== null && Math.abs(r.lean_kg - body.lean_body_mass_kg) < 0.01);
}

export function registerWeightLog(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_weight_log",
    description:
      "Add, edit or delete a weight or body-composition reading. weight and lean_mass need unit. add ALWAYS creates a new reading, even " +
      "on a day that has one; to replace, edit by reading_id (from whoop_weight). The latest reading becomes the profile weight, and " +
      "deleting a reading never reverts it. No future times. Previews unless confirm:true.",
    input: {
      action: z.enum(["add", "edit", "delete"]),
      reading_id: z.string().min(1).optional().describe("For edit and delete"),
      weight: z.number().positive().optional().describe("Required for add"),
      unit: z.enum(["kg", "lb"]).optional(),
      body_fat_pct: z.number().gt(0).lt(100).nullable().optional().describe("Percent, e.g. 18.5; on edit null clears body composition"),
      lean_mass: z.number().positive().optional(),
      at: instantInput().optional().describe("Default now; edit keeps it"),
      confirm: z.boolean().default(false),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async ({ action, reading_id, weight, unit, body_fat_pct, lean_mass, at: atIn, confirm }) => {
    const at = toInstantOpt(atIn, "at");
    if (action === "add" && weight === undefined) return toolError("action:add needs weight (and unit).");
    if (action === "add" && reading_id) return toolError("action:add creates a new reading; to change an existing one use action:edit with reading_id.");
    if (action !== "add" && !reading_id) return toolError(`action:${action} needs reading_id (from whoop_weight).`);
    if (action === "delete" && (weight !== undefined || body_fat_pct !== undefined || lean_mass !== undefined || at !== undefined)) {
      return toolError("action:delete takes only reading_id.");
    }
    if ((weight !== undefined || lean_mass !== undefined) && !unit) {
      return toolError("Say which unit weight/lean_mass are in: unit \"kg\" or \"lb\". (WHOOP stores readings in kg.)");
    }

    // Fresh pre-read: the target reading (edit/delete), same-day readings, and the latest timestamp.
    const { readings, target } = await loadReadings(client, reading_id ? (r) => r.id === reading_id : undefined);
    if (action !== "add" && !target) {
      return toolError(`No reading with id ${reading_id} in your recent readings (searched ${MAX_PAGES} pages). WHOOP answers 204 to any delete, so totem won't send one it can't verify.`);
    }
    if (action === "edit" && target && !target.editable) {
      return toolError(`Reading ${target.id} comes from ${target.source ?? "an integration"} and isn't editable in WHOOP; it can only be deleted.`);
    }

    const warnings: string[] = [];
    const others = readings.filter((r) => r.id !== reading_id);
    const latestOther = others[0] ?? null;

    if (action === "delete") {
      const path = `${WEIGHT_READINGS_PATH}/${encodeURIComponent(target!.id)}`;
      warnings.push("Deleting a reading never reverts the profile weight. To change it back, add a reading at the right weight with a later time than every other reading.");
      if (!confirm) return respond("whoop_weight_log", WeightLogOut, previewWith("DELETE", path, { reading_id: target!.id }, warnings, row(target!)));
      try {
        await client.delete(path);
      } catch (error) {
        if (error instanceof WhoopApiError) return writeRejected("deletion", path, error);
        throw error;
      }
      const after = await loadReadings(client, (r) => r.id === target!.id);
      return respond("whoop_weight_log", WeightLogOut, {
        action, id: target!.id, verified: after.target === null, reading: null,
        profile_kg: await profileWeightKg(client), warnings,
      });
    }

    // add / edit: build the full body (PUT is a full replace, so edit merges onto the current reading).
    const tsIso = at ?? (action === "edit" ? target!.timestamp : new Date().toISOString());
    try {
      assertNotFuture(tsIso, "reading time");
    } catch {
      // assertNotFuture's own reason (an undeletable empty day) is about activities and sleeps.
      return toolError(`The reading time ${tsIso} is in the future. A weight reading is dated when it was taken.`);
    }
    let fatPct: number | undefined;
    let leanKg: number | undefined;
    // An edit that changes neither weight nor body composition (a new time only) re-sends the
    // stored values exactly: the PUT replaces everything, and WHOOP never ties lean to weight.
    const verbatim = action === "edit" && weight === undefined && body_fat_pct === undefined && lean_mass === undefined;
    if (body_fat_pct !== undefined || lean_mass !== undefined) {
      fatPct = body_fat_pct ?? undefined;
      leanKg = lean_mass !== undefined ? toKg(lean_mass, unit!) : undefined;
    } else if (action === "edit" && target && !verbatim) {
      // A new weight keeps the stored body fat (at its stored precision); lean follows the new weight.
      if (target.fat_fraction !== null) fatPct = target.fat_fraction * 100;
      else if (target.lean_kg !== null) leanKg = target.lean_kg;
    }
    let body: MeasurementBody;
    try {
      body = buildMeasurementBody({
        // The app sends local wall-clock time with its offset; toLocalIso leaves offset input as given.
        timestamp: toLocalIso(tsIso),
        weight_kg: weight !== undefined ? toKg(weight, unit!) : target!.weight_kg,
        body_fat_percent: fatPct,
        lean_body_mass_kg: leanKg,
      });
      if (verbatim) body = { ...body, body_fat_percent: target!.fat_fraction, lean_body_mass_kg: target!.lean_kg };
    } catch (e) {
      return toolError((e as Error).message);
    }

    const day = isoDay(new Date(tsIso));
    const sameDay = others.filter((r) => isoDay(new Date(r.timestamp)) === day);
    if (action === "add" && sameDay.length) {
      warnings.push(`${day} already has ${sameDay.length} reading(s) (${sameDay.map((r) => r.id).join(", ")}). add creates another one; to replace, use action:edit with that reading_id.`);
    }
    if (!latestOther || Date.parse(tsIso) >= Date.parse(latestOther.timestamp)) {
      warnings.push(`This will be your latest reading, so WHOOP sets your profile weight to ${body.weight_kg} kg (deleting it later won't revert that).`);
    }

    const path = action === "edit" ? `${WEIGHT_READINGS_PATH}/${encodeURIComponent(target!.id)}` : WEIGHT_READINGS_PATH;
    const method = action === "edit" ? "PUT" : "POST";
    if (!confirm) return respond("whoop_weight_log", WeightLogOut, previewWith(method, path, body, warnings, target ? row(target) : undefined));

    try {
      if (action === "edit") await client.put(path, body);
      else await client.post(path, body);
    } catch (error) {
      if (error instanceof WhoopApiError) return writeRejected(action === "edit" ? "edit" : "reading", path, error);
      throw error;
    }

    // Read back: POST returns 204 with no id, so find the new reading by time + values.
    const before = new Set(readings.map((r) => r.id));
    const after = await loadReadings(client, action === "edit"
      ? (r) => r.id === target!.id
      : (r) => !before.has(r.id) && matches(r, body, tsIso));
    const reading = after.target;
    const verified = reading !== null && matches(reading, body, tsIso);
    if (!verified) warnings.push(reading ? "WHOOP stored different values than were sent; see reading." : "The reading didn't show up when re-listed.");
    return respond("whoop_weight_log", WeightLogOut, {
      action, id: reading?.id ?? reading_id ?? null, verified,
      reading: reading ? row(reading) : null,
      profile_kg: await profileWeightKg(client), warnings,
    });
  });
}
