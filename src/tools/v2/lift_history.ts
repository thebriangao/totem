import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftHistoryOut } from "../../schemas/strength.js";
import { projectLiftHistory, hasLiftData } from "../../projections/lift_history.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { rangeFromDays } from "../../lib/dates.js";
import { runPaced } from "../../lib/concurrency.js";

const MAX_SCAN = 40;
const MAX_PAGES = 4;
const BATCH = 6;

export function registerLiftHistory(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_history",
    "Recent workouts that have lifts attached (any sport, e.g. a Strength Trainer log re-typed to Functional Fitness), with per-exercise aggregates (set count, total reps, tonnage, medals). It does NOT include individual set reps/weights — for those use whoop_lift_exercise, which returns every set for one exercise across your history.",
    {
      limit: z.number().int().min(1).max(20).default(10),
      end_date: z.iso.date().optional(),
    },
    async ({ limit, end_date }) => {
      const endDate = end_date ? new Date(`${end_date}T23:59:59.999Z`) : new Date();
      const start = rangeFromDays(60, endDate).start;
      const end = endDate.toISOString();
      const records: Array<{ id: string }> = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_PAGES && records.length < MAX_SCAN; page++) {
        const resp = await client.get<{ records?: Array<{ id: string }>; next_token?: string | null }>(
          "/developer/v2/activity/workout",
          { start, end, limit: 25, ...(nextToken ? { nextToken } : {}) },
        );
        records.push(...(resp.records ?? []));
        nextToken = resp.next_token ?? undefined;
        if (!nextToken) break;
      }
      const candidates = records.slice(0, MAX_SCAN);
      const found: { records: Array<{ id: string }>; details: unknown[] } = { records: [], details: [] };
      for (let i = 0; i < candidates.length && found.records.length < limit; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        const details = await runPaced(
          batch.map((r) => () => client.get(`/core-details-bff/v1/cardio-details`, { activityId: r.id }).catch(() => ({}))),
          { concurrency: 3, jitterMaxMs: 150 },
        );
        batch.forEach((r, k) => {
          if (hasLiftData(details[k])) {
            found.records.push(r);
            found.details.push(details[k]);
          }
        });
      }
      const workouts = { records: found.records.slice(0, limit) };
      const details = found.details.slice(0, limit);
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
