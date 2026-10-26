import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { CompareOut, type CompareMetricRow } from "../../schemas/compare.js";
import { projectTrend } from "../../projections/trend.js";
import { METRICS } from "../../schemas/trend.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";
import { runPaced } from "../../lib/concurrency.js";
import { READ_ONLY } from "../annotations.js";

const COMPARE_METRICS = ["RECOVERY", "SLEEP_PERFORMANCE", "DAY_STRAIN", "HRV", "RHR"] as const;
type CompareMetric = typeof COMPARE_METRICS[number];

function dateBefore(end: string, days: number): string {
  return new Date(new Date(end).getTime() - days * 86400000).toISOString().slice(0, 10);
}

export function registerCompare(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_compare",
    "Compare two date windows side by side (e.g. 'this week vs last week') — each metric's average in window A vs window B plus the delta. window: week or month. metrics: any of RECOVERY, SLEEP_PERFORMANCE, DAY_STRAIN, HRV, RHR (defaults to all five).",
    {
      window: z.enum(["week", "month"]).default("week"),
      end_a: z.iso.date().optional(),
      end_b: z.iso.date().optional(),
      metrics: z.array(z.enum(COMPARE_METRICS)).min(1).max(COMPARE_METRICS.length).refine(
        (values) => new Set(values).size === values.length,
        "metrics must not contain duplicates",
      ).default([...COMPARE_METRICS]),
    },
    READ_ONLY,
    async ({ window, end_a, end_b, metrics }) => {
      const a = end_a ?? todayIso();
      const offsetDays = window === "week" ? 7 : 30;
      const b = end_b ?? dateBefore(a, offsetDays);

      // Up to 10 trend calls — paced (≤3 at a time, small jitter) rather than
      // fired as one simultaneous burst, which no real app screen produces.
      const flatResults = await runPaced(
        metrics.flatMap((m: CompareMetric) => [
          () => client.get(`/progression-service/v3/trends/${m}`, { endDate: a }).then((r) => ({ m, end: a, r })),
          () => client.get(`/progression-service/v3/trends/${m}`, { endDate: b }).then((r) => ({ m, end: b, r })),
        ]),
        { concurrency: 3, jitterMaxMs: 150 },
      );

      const projected: CompareMetricRow[] = metrics.map((m: CompareMetric) => {
        const aRes = flatResults.find((x) => x.m === m && x.end === a);
        const bRes = flatResults.find((x) => x.m === m && x.end === b);
        const aTrend = aRes ? projectTrend(aRes.r, m as typeof METRICS[number], a) : null;
        const bTrend = bRes ? projectTrend(bRes.r, m as typeof METRICS[number], b) : null;
        const aSeg = aTrend?.segments.find((s) => s.label === window) ?? null;
        const bSeg = bTrend?.segments.find((s) => s.label === window) ?? null;
        const aAvg = aSeg?.avg ?? null;
        const bAvg = bSeg?.avg ?? null;
        const deltaAbs = aAvg !== null && bAvg !== null ? aAvg - bAvg : null;
        const deltaPct =
          deltaAbs !== null && bAvg !== null && bAvg !== 0
            ? Math.round((deltaAbs / bAvg) * 1000) / 10
            : null;
        return {
          metric: m,
          a_avg: aAvg,
          b_avg: bAvg,
          delta_abs: deltaAbs,
          delta_pct: deltaPct,
          unit: aSeg?.unit ?? bSeg?.unit ?? null,
        };
      });

      const out = {
        window,
        a: { start_date: dateBefore(a, offsetDays), end_date: a },
        b: { start_date: dateBefore(b, offsetDays), end_date: b },
        metrics: projected,
      };
      try {
        const parsed = CompareOut.parse(out);
        return { content: [{ type: "text", text: jsonOut(parsed) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_compare", e);
        throw e;
      }
    },
  );
}
