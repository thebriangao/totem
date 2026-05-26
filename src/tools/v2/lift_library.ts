import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftLibraryOut } from "../../schemas/strength.js";
import { projectLibraryList, projectLibrarySingle } from "../../projections/lift_library.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";

export function registerLiftLibrary(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_library",
    "Your saved Strength Trainer templates. Pass template_id for full detail of one; omit for the list.",
    { template_id: z.number().int().optional() },
    async ({ template_id }) => {
      const projected =
        template_id !== undefined
          ? projectLibrarySingle(await client.get(`/weightlifting-service/v2/workout-template/${template_id}`))
          : projectLibraryList(await client.get("/weightlifting-service/v3/workout-library"));
      try {
        const out = LiftLibraryOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_library", e);
        throw e;
      }
    },
  );
}
