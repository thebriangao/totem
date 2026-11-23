// whoop_trend (v2): replaces whoop_trend, whoop_trend_pack and whoop_compare.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { todayIso } from "../../lib/dates.js";
import { runPaced } from "../../lib/concurrency.js";
import { TREND_METRICS, TrendV2Out } from "../../schemas/v2/trend.js";
import { TREND_WINDOWS, compactWindow, compareRows, projectTrendWindow, type TrendWindow, type TrendWindowOut } from "../../projections/v2/trend.js";

const NAME = "whoop_trend";
type Metric = (typeof TREND_METRICS)[number];

export function registerTrend(server: McpServer, client: WhoopClient): void {
  defineTool(
    server,
    {
      name: NAME,
      description:
        "Trends for 1–5 metrics over a window ending end_date (default today; week = 7 days, month 30, six_month 180): average, " +
        "previous-window average, change % and direction. HR-zone and strength-time rows are weekly totals. compare_end_date adds a " +
        "second window and the deltas.",
      input: {
        metrics: z.array(z.enum(TREND_METRICS)).min(1).max(5)
          .refine((v) => new Set(v).size === v.length, "metrics must not repeat"),
        window: z.enum(TREND_WINDOWS).default("month"),
        end_date: z.iso.date().optional(),
        compare_end_date: z.iso.date().optional(),
        include_points: z.boolean().default(false).describe("One value per day or week"),
      },
      annotations: READ_ONLY,
    },
    async ({ metrics, window, end_date, compare_end_date, include_points }) => {
      const a = end_date ?? todayIso();
      if (compare_end_date === a) throw new Error("compare_end_date must differ from end_date.");
      const ends = compare_end_date ? [a, compare_end_date] : [a];
      // Up to 10 trend reads, paced ≤3 at a time with jitter rather than one burst.
      const fetched = await runPaced(
        metrics.flatMap((m: Metric) => ends.map((end) => async () => {
          try {
            const raw = await client.get(`/progression-service/v3/trends/${m}`, { endDate: end });
            return { m, end, w: projectTrendWindow(raw, end, window as TrendWindow, include_points), error: null as string | null };
          } catch (e) {
            return { m, end, w: null as TrendWindowOut | null, error: e instanceof Error ? e.message : String(e) };
          }
        })),
        { concurrency: 3, jitterMaxMs: 150 },
      );
      const pick = (m: Metric, end: string) => fetched.find((f) => f.m === m && f.end === end)!;
      const out = {
        window,
        metrics: metrics.map((m: Metric) => {
          const ra = pick(m, a);
          const row: Record<string, unknown> = { metric: m, a: ra.w && compactWindow(ra.w) };
          if (ra.error) row.error = ra.error;
          if (compare_end_date) {
            const rb = pick(m, compare_end_date);
            row.b = rb.w && compactWindow(rb.w);
            if (rb.error) row.error = row.error ?? rb.error;
            if (ra.w && rb.w) row.delta = compareRows(ra.w.rows, rb.w.rows);
          }
          return row;
        }),
      };
      return respond(NAME, TrendV2Out, out);
    },
  );
}
