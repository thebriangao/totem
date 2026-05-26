import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftHistoryOut } from "../../schemas/strength.js";
import { projectLiftHistory } from "../../projections/lift_history.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { rangeFromDays } from "../../lib/dates.js";

export function registerLiftHistory(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_history",
    "Recent strength workouts with set-level detail (vs whoop_workouts which is generic).",
    {
      limit: z.number().int().min(1).max(20).default(10),
      end_date: z.iso.date().optional(),
    },
    async ({ limit, end_date }) => {
      const endDate = end_date ? new Date(end_date) : new Date();
      const start = rangeFromDays(60, endDate).start;
      const end = endDate.toISOString();
      const workouts = await client.get<{ records?: { id: string; sport_name?: string }[] }>(
        "/developer/v2/activity/workout",
        { start, end, limit: 25 },
      );
      // Whoop's /developer/v2/activity/workout returns internal sport names like
      // "weightlifting_msk" (Strength Trainer), "weightlifting", "powerlifting".
      // None of these contain "strength" so we match by the broader pattern.
      const strengthIds = (workouts.records ?? [])
        .filter((r) => r.sport_name && /weight|strength|powerlift/i.test(r.sport_name))
        .slice(0, limit)
        .map((r) => r.id);
      const details = await Promise.all(
        strengthIds.map((id) =>
          client.get(`/core-details-bff/v1/cardio-details`, { activityId: id }).catch(() => ({})),
        ),
      );
      const projected = projectLiftHistory({ workouts, details });
      try {
        const out = LiftHistoryOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_history", e);
        throw e;
      }
    },
  );
}
