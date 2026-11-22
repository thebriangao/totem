// whoop_lift_library (R): replaces whoop_lift_library + whoop_lift_catalog.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { LiftLibraryOutV2 } from "../../schemas/strength_v2.js";
import { libraryRows, prebuiltDetail, templateDetail } from "../../projections/lift_library_v2.js";
import { EXERCISES } from "../../data/exercises.js";
import { liveCatalog, rankMatches } from "../../lib/lift_catalog.js";
import { displayUnitForReads, liftError } from "../../lib/lift_tool.js";
import { WhoopApiError } from "../../whoop/errors.js";

const TOOL = "whoop_lift_library";
const SEARCH_LIMIT = 10;

export function registerLiftLibrary(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: TOOL,
    description:
      "Strength Trainer workouts and exercises. No args: your templates `my` [template_key, name] and WHOOP workouts `whoop` [prebuilt_id, title, minutes]. template_key: one template, sets as [weight, reps] ([weight, seconds] if timed) in `unit`. prebuilt_id: one WHOOP workout. search: up to 10 exercises {id, name} by name words, muscle or equipment (your custom exercises included) — the ids whoop_lift_log and whoop_lift_exercise take.",
    input: {
      template_key: z.number().int().optional().describe("One of your templates."),
      prebuilt_id: z.string().optional().describe("One WHOOP workout (id from the list)."),
      search: z.string().optional().describe("Exercise search, e.g. \"bench barbell\" or \"legs kettlebell\"."),
    },
    annotations: READ_ONLY,
  }, async ({ template_key, prebuilt_id, search }) => {
    const warnings: string[] = [];
    const out: Record<string, unknown> = {};

    if (search !== undefined) {
      const customs = ((await liveCatalog(client)) ?? []).filter((r) => r.custom_exercise === true && r.deleted !== true);
      const ranked = rankMatches(search, [...EXERCISES, ...customs]);
      out.search = { matches: ranked.slice(0, SEARCH_LIMIT).map((r) => ({ id: r.exercise_id, name: r.name })), more: Math.max(0, ranked.length - SEARCH_LIMIT) };
    }

    try {
      if (template_key !== undefined) {
        const [raw, unit] = await Promise.all([
          client.get(`/weightlifting-service/v2/workout-template/${template_key}`),
          displayUnitForReads(client),
        ]);
        out.template = templateDetail(raw, unit);
      } else if (prebuilt_id !== undefined) {
        out.prebuilt = prebuiltDetail(await client.get(`/weightlifting-service/v2/prebuilt-workout-template/${encodeURIComponent(prebuilt_id)}`), prebuilt_id);
      } else if (search === undefined) {
        Object.assign(out, libraryRows(await client.get("/weightlifting-service/v3/workout-library")));
      }
    } catch (e) {
      if (e instanceof WhoopApiError && e.status === 404) {
        return liftError({
          error: template_key !== undefined ? `No template ${template_key} (deleted, or a WHOOP workout id: use prebuilt_id).` : `No WHOOP workout ${prebuilt_id}.`,
        });
      }
      throw e;
    }
    out.warnings = warnings;
    return respond(TOOL, LiftLibraryOutV2, out);
  });
}
