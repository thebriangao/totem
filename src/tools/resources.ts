// The bundled catalogs as MCP resources (they were four tools in v1). A resource
// costs nothing per turn: a client reads it only when asked. Rows are columnar
// ({columns, rows}) so a full read stays small.
//
// Some MCP clients never show resources to the model, so no tool depends on
// them: every tool that takes a name (activity type, exercise, behaviour)
// resolves it itself and returns the closest matches on a miss.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ACTIVITY_TYPES } from "../data/sports.js";
import { EXERCISES, EXERCISE_FILTER_OPTIONS } from "../data/exercises.js";
import { BEHAVIORS } from "../data/behaviors.js";
import { GARMENTS } from "../data/garments.js";
import { ENDPOINT_CATALOG } from "../data/endpoint_catalog.js";

interface CatalogResource {
  name: string;
  uri: string;
  title: string;
  description: string;
  build: () => unknown;
}

export const CATALOG_RESOURCES: readonly CatalogResource[] = [
  {
    name: "sports",
    uri: "whoop://catalog/sports",
    title: "WHOOP activity types",
    description: "Every activity type WHOOP accepts: internal_name (what whoop_activity_log takes), display name, sport_id, and whether it scores as CARDIO, RECOVERY or SLEEP.",
    build: () => ({
      columns: ["internal_name", "name", "sport_id", "score_type"],
      rows: ACTIVITY_TYPES.map((t) => [t.internal_name, t.name, t.sport_id, t.score_type]),
    }),
  },
  {
    name: "exercises",
    uri: "whoop://catalog/exercises",
    title: "WHOOP Strength Trainer exercises",
    description: "The official exercise catalog: exercise_id (what the lift tools take), name, equipment, primary muscle, how volume is entered, and whether WHOOP estimates a 1RM for it. Custom exercises are per-account: see whoop_lift_library.",
    build: () => ({
      columns: ["exercise_id", "name", "equipment", "primary_muscle", "volume_input_format", "e1rm_eligible"],
      rows: EXERCISES.map((e) => [e.exercise_id, e.name, e.raw_equipment ?? e.equipment, e.primary_muscle, e.volume_input_format ?? null, e.e1rm_eligible ?? null]),
      filter_options: EXERCISE_FILTER_OPTIONS,
    }),
  },
  {
    name: "behaviors",
    uri: "whoop://catalog/behaviors",
    title: "WHOOP Journal behaviours",
    description: "The stock Journal behaviours: id (what whoop_journal_log takes), title, category, and the magnitude each accepts (units and range, or the allowed choices). Custom behaviours are per-account: see whoop_journal.",
    build: () => ({
      columns: ["id", "title", "category", "units", "min", "max", "choices"],
      rows: BEHAVIORS.map((b) => {
        const m = b.magnitude_spec;
        return [
          b.behavior_tracker_id, b.title, b.category, m?.units ?? null, m?.minimum ?? null, m?.maximum ?? null,
          m && m.choices.length ? m.choices.map((c) => `${c.value}=${c.label}`) : null,
        ];
      }),
    }),
  },
  {
    name: "garments",
    uri: "whoop://catalog/garments",
    title: "WHOOP strap locations",
    description: "Where the strap can be worn (garment_id for activity tools), and which strap generations support each.",
    build: () => ({
      columns: ["id", "name", "strap_location", "straps"],
      rows: GARMENTS.map((g) => [g.id, g.name, g.strap_location, g.straps]),
    }),
  },
  {
    name: "endpoints",
    uri: "whoop://catalog/endpoints",
    title: "WHOOP private API endpoints",
    description: "Every endpoint totem has verified against the live WHOOP app API, with its verdict and the tool that wraps it. Use with whoop_raw when no tool fits.",
    build: () => ({
      columns: ["method", "path", "verdict", "tools"],
      rows: ENDPOINT_CATALOG.map((e) => [e.method, e.path, e.verdict, e.tools.length ? e.tools : null]),
    }),
  },
];

export function registerResources(server: McpServer): void {
  for (const r of CATALOG_RESOURCES) {
    server.registerResource(
      r.name,
      r.uri,
      { title: r.title, description: r.description, mimeType: "application/json" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.build()) }] }),
    );
  }
}
