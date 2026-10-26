import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LiftCatalogOut } from "../../schemas/strength.js";
import { EXERCISES } from "../../data/exercises.js";
import { jsonOut } from "../../whoop/json_out.js";
import { READ_ONLY } from "../annotations.js";

export function registerLiftCatalog(server: McpServer, _client: unknown): void {
  server.tool(
    "whoop_lift_catalog",
    "Search the 372-exercise Strength Trainer catalog to get the exact exercise_id for whoop_lift_log, lift_exercise, or lift_progression. Filter by name substring, muscle, equipment, movement_pattern, or laterality (BILATERAL, LEFT, RIGHT, ALTERNATING), and read the id from the result.",
    {
      search: z.string().optional(),
      muscle: z.string().optional(),
      equipment: z.string().optional(),
      movement_pattern: z.string().optional(),
      laterality: z.enum(["BILATERAL", "LEFT", "RIGHT", "ALTERNATING"]).optional(),
      limit: z.number().int().min(1).max(372).default(50),
    },
    READ_ONLY,
    async ({ search, muscle, equipment, movement_pattern, laterality, limit }) => {
      const s = search?.toLowerCase();
      const matches = EXERCISES.filter((e) => {
        if (s && !(e.name.toLowerCase().includes(s) || e.exercise_id.toLowerCase().includes(s))) return false;
        if (muscle && !e.muscle_groups.includes(muscle.toUpperCase())) return false;
        if (equipment && !e.equipment.toLowerCase().includes(equipment.toLowerCase())) return false;
        if (movement_pattern && !e.movement_pattern.toLowerCase().includes(movement_pattern.toLowerCase())) return false;
        if (laterality && e.laterality !== laterality) return false;
        return true;
      });
      const out = LiftCatalogOut.parse({
        total_in_catalog: 372,
        matched: matches.length,
        truncated: matches.length > limit,
        exercises: matches.slice(0, limit).map((e) => ({
          exercise_id: e.exercise_id,
          name: e.name,
          muscle_groups: [...e.muscle_groups],
          primary_muscle: e.primary_muscle,
          equipment: e.equipment,
          movement_pattern: e.movement_pattern,
          laterality: e.laterality,
        })),
      });
      return { content: [{ type: "text", text: jsonOut(out) }] };
    },
  );
}
