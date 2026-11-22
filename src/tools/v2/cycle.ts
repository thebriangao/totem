import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { CycleOut } from "../../schemas/hormonal_insights.js";
import {
  dayLogFromScreen,
  projectCycleCalendar,
  projectCycleSummary,
  projectCycles,
  projectHormonalSettings,
  projectSymptomPatterns,
  projectSymptomScreen,
} from "../../projections/hormonal_insights.js";
import { WhoopApiError, WhoopServerError } from "../../whoop/errors.js";
import { todayIso } from "../../lib/dates.js";

export const WH = "/womens-health-service/v1";
export const OVERVIEW_PATH = `${WH}/hormonal-insights/overview`;
export const OLD_INSIGHTS_PATH = `${WH}/menstrual-cycle-insights`;
export const SYMPTOM_SCREEN_PATH = `${WH}/symptom-insights/log/symptoms/screen`;

const INCLUDE = ["calendar", "settings", "cycles", "symptoms", "day_log"] as const;

const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/**
 * The hormonal-insights overview for a date (D10), falling back to the old
 * menstrual-cycle-insights screen. Before onboarding both answer 400.
 */
export async function fetchOverview(
  client: WhoopClient,
  date: string,
  fresh = false,
): Promise<{ raw: unknown; source: "hormonal_insights" | "menstrual_cycle_insights" } | { error: string }> {
  try {
    return { raw: await client.get(OVERVIEW_PATH, { date }, { fresh }), source: "hormonal_insights" };
  } catch (first) {
    if (!(first instanceof WhoopApiError || first instanceof WhoopServerError)) throw first;
    try {
      return { raw: await client.get(OLD_INSIGHTS_PATH, { date }, { fresh }), source: "menstrual_cycle_insights" };
    } catch (second) {
      if (!(second instanceof WhoopApiError || second instanceof WhoopServerError)) throw second;
      return { error: first.message };
    }
  }
}

export function registerCycle(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_cycle",
    description:
      "Menstrual cycle / Hormonal Insights for a date: status (cycle or period day), phase, next-period window, the date's calendar state, cycle-journal tags and typical cycle stats. " +
      "include adds: calendar (the month as runs [from_day, to_day, state, phase]; PERIOD = logged, PREDICTED_PERIOD), settings (mode, contraception, goals), cycles (past cycles), symptoms (symptom patterns), day_log (the date's flow, mucus, symptoms with ids). " +
      "available:false with a reason when Hormonal Insights isn't set up.",
    input: {
      date: z.iso.date().optional().describe("YYYY-MM-DD (default today); also picks the calendar month."),
      include: z.array(z.enum(INCLUDE)).default([]).describe("Extra sections."),
    },
    annotations: READ_ONLY,
  }, async ({ date, include }) => {
    const d = date ?? todayIso();
    const want = new Set(include ?? []);
    const [overview, settings, cycles, symptoms, screen] = await Promise.all([
      fetchOverview(client, d),
      want.has("settings") ? optional(client.get(`${WH}/hormonal-insights/settings`)) : Promise.resolve(undefined),
      want.has("cycles") ? optional(client.get(`${WH}/menstrual-cycle-insights/cycles`)) : Promise.resolve(undefined),
      want.has("symptoms") ? optional(client.get(`${WH}/menstrual-cycle-insights/symptoms`)) : Promise.resolve(undefined),
      want.has("day_log") ? optional(client.get(SYMPTOM_SCREEN_PATH, { requestDate: d })) : Promise.resolve(undefined),
    ]);
    const ok = "raw" in overview;
    return respond("whoop_cycle", CycleOut, {
      date: d,
      available: ok,
      reason: ok ? null : overview.error,
      source: ok ? overview.source : null,
      cycle: ok ? projectCycleSummary(overview.raw, d) : null,
      ...(want.has("calendar") ? { calendar: ok ? projectCycleCalendar(overview.raw) : null } : {}),
      ...(settings === undefined ? {} : { settings: settings === null ? null : projectHormonalSettings(settings) }),
      ...(cycles === undefined ? {} : { cycles: cycles === null ? null : projectCycles(cycles) }),
      ...(symptoms === undefined ? {} : { symptoms: symptoms === null ? null : projectSymptomPatterns(symptoms) }),
      ...(screen === undefined ? {} : { day_log: screen === null ? null : dayLogFromScreen(projectSymptomScreen(screen)) }),
    });
  });
}
