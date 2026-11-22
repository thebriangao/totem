import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { WRITE_DESTRUCTIVE, idempotent } from "../annotations.js";
import { CERVICAL_MUCUS, CycleLogOut, MENSTRUATION } from "../../schemas/hormonal_insights.js";
import {
  answeredSymptoms,
  loggedOnDate,
  projectCycleSummary,
  projectSymptomScreen,
  type ScreenTracker,
  type SymptomScreen,
} from "../../projections/hormonal_insights.js";
import { previewWith, suggest, toolError, writeRejected } from "../../lib/health_plans_write.js";
import { WhoopApiError } from "../../whoop/errors.js";
import { todayIso } from "../../lib/dates.js";
import { fetchOverview, SYMPTOM_SCREEN_PATH, WH } from "./cycle.js";

const LOG_PATH = `${WH}/menstrual-cycle-insights/log`;
const SYMPTOM_POST_PATH = `${WH}/symptom-insights/log/symptoms`;

const SymptomArg = z.object({
  id: z.number().int().optional().describe("Symptom id (whoop_cycle include day_log)."),
  name: z.string().min(1).optional().describe("Or the symptom's name, e.g. Headache."),
  yes: z.boolean().default(true).describe("false removes the symptom."),
  magnitude: z.number().optional().describe("Graded symptoms only: a step choice (e.g. 0/1/2) or in range."),
});
type SymptomArgT = z.infer<typeof SymptomArg>;

type Resolved = { tracker: ScreenTracker; yes: boolean; magnitude: number | undefined };

function resolveSymptoms(args: SymptomArgT[], screen: SymptomScreen): Resolved[] | string {
  const out: Resolved[] = [];
  for (const a of args) {
    if ((a.id === undefined) === (a.name === undefined)) return "Give each symptom an id or a name (not both).";
    const tracker = a.id !== undefined
      ? screen.trackers.find((t) => t.id === a.id)
      : screen.trackers.find((t) => t.name.toLowerCase() === a.name!.trim().toLowerCase());
    if (!tracker) {
      const names = screen.trackers.map((t) => t.name);
      return a.id !== undefined
        ? `Symptom id ${a.id} isn't on WHOOP's symptom screen. Known: ${screen.trackers.map((t) => `${t.id} ${t.name}`).join(", ")}.`
        : `Unknown symptom "${a.name}". Closest: ${suggest(a.name!, names).join(", ")}.`;
    }
    if (out.some((r) => r.tracker.id === tracker.id)) return `${tracker.name} is listed twice.`;
    if (a.magnitude !== undefined) {
      if (!a.yes) return `${tracker.name}: magnitude only applies when yes is true.`;
      const m = tracker.magnitude;
      if (!m) return `${tracker.name} takes no magnitude.`;
      if (m.type === "step" && !m.choices.includes(a.magnitude)) return `${tracker.name} magnitude must be one of ${m.choices.join(", ")}.`;
      if (m.type === "range" && (a.magnitude < m.min || a.magnitude > m.max)) return `${tracker.name} magnitude must be between ${m.min} and ${m.max}.`;
    }
    out.push({ tracker, yes: a.yes, magnitude: a.magnitude });
  }
  return out;
}

export function registerCycleLog(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: "whoop_cycle_log",
    description:
      "WRITE: log or undo a date's period (flow 0 light, 1 medium, 2 heavy) or ovulation, and/or flow (menstruation), cervical mucus and symptoms. yes:false undoes. Not both period and ovulation on one date; no future dates. " +
      "Current flow and mucus are re-sent so symptom edits don't clear them; null clears one. Any flow except none also logs a period day, and a period on a fresh date creates a cycle that undo won't remove. Also writes journal rows. Preview unless confirm:true.",
    input: {
      date: z.iso.date(),
      period: z.object({ yes: z.boolean(), flow: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional() }).optional(),
      ovulation: z.object({ yes: z.boolean() }).optional(),
      menstruation: z.enum(MENSTRUATION).nullable().optional().describe("Flow chip; null clears it."),
      cervical_mucus: z.enum(CERVICAL_MUCUS).nullable().optional().describe("null clears it."),
      symptoms: z.array(SymptomArg).optional(),
      confirm: z.boolean().default(false),
    },
    annotations: idempotent(WRITE_DESTRUCTIVE),
  }, async ({ date, period, ovulation, menstruation, cervical_mucus, symptoms, confirm }) => {
    const wantLog = period !== undefined || ovulation !== undefined;
    const wantSymptoms = menstruation !== undefined || cervical_mucus !== undefined || (symptoms?.length ?? 0) > 0;
    if (!wantLog && !wantSymptoms) return toolError("Nothing to log: pass period, ovulation, menstruation, cervical_mucus or symptoms.");
    if (date > todayIso()) return toolError(`${date} is in the future. WHOOP accepts future logs and then keeps cycles it can't remove, so totem refuses them.`);
    if (period?.yes && ovulation?.yes) return toolError("WHOOP rejects a period and ovulation on the same date (400). Log one.");
    if (period?.flow !== undefined && !period.yes) return toolError("period.flow only applies with period.yes true.");
    const flowing = typeof menstruation === "string" && menstruation !== "none";
    if (flowing && (period?.yes === false || ovulation?.yes === true)) {
      return toolError(`menstruation "${menstruation}" logs a period day on ${date}, which contradicts ${period?.yes === false ? "removing the period" : "logging ovulation"}.`);
    }

    const warnings: string[] = [];
    const writes: Array<{ method: string; path: string; body: unknown }> = [];
    let before: { period_day: boolean | null; ovulation_logged: boolean | null } = { period_day: null, ovulation_logged: null };

    // Fresh pre-reads: what is logged on the date now.
    if (wantLog) {
      const ov = await fetchOverview(client, date, true);
      if (!("raw" in ov)) return toolError(`Couldn't read Hormonal Insights for ${date}: ${ov.error}. Hormonal Insights must be set up in the WHOOP app first.`);
      before = loggedOnDate(ov.raw, date);
      let p = period?.yes;
      let o = ovulation?.yes;
      if (p === undefined) {
        // Only ovulation given. WHOOP takes both fields; logging ovulation clears a period (as the app does).
        if (o === false && before.ovulation_logged !== true && before.period_day === true) {
          return toolError(`No ovulation is logged on ${date}, but a period is; sending the undo would also remove the period. Use period:{yes:false} to remove the period.`);
        }
        if (o === false && before.period_day === null) return toolError(`Couldn't tell what is logged on ${date}; pass both period and ovulation explicitly.`);
        if (o === true && before.period_day) warnings.push(`${date} is a logged period day; logging ovulation removes the period (WHOOP allows one per date).`);
        p = false;
      }
      if (o === undefined) {
        if (p === false && before.period_day !== true && before.ovulation_logged === true) {
          return toolError(`No period is logged on ${date}, but ovulation is; sending the undo would also remove the ovulation. Use ovulation:{yes:false} to remove it.`);
        }
        if (p === false && before.ovulation_logged === null) return toolError(`Couldn't tell what is logged on ${date}; pass both period and ovulation explicitly.`);
        if (p === true && before.ovulation_logged) warnings.push(`${date} has ovulation logged; logging a period replaces it.`);
        o = false;
      }
      if (p && before.period_day !== true) {
        warnings.push(`If ${date} starts a new period, WHOOP creates a cycle entry that undoing the period won't remove.`);
      }
      if (!p && !o) warnings.push("Undo leaves journal rows for this date answered No.");
      writes.push({
        method: "PUT",
        path: LOG_PATH,
        body: {
          period_logs: [{
            date,
            period: { answered_yes: p, magnitude_input_value: p ? period?.flow ?? null : null },
            ovulation: { answered_yes: o, magnitude_input_value: null },
          }],
        },
      });
    }

    let screenBefore: SymptomScreen | null = null;
    let resolved: Resolved[] = [];
    if (wantSymptoms) {
      screenBefore = projectSymptomScreen(await client.get(SYMPTOM_SCREEN_PATH, { requestDate: date }, { fresh: true }));
      for (const [field, value] of [["menstruation", menstruation], ["cervical_mucus", cervical_mucus]] as const) {
        const live = screenBefore.options[field];
        if (typeof value === "string" && live.length && !live.includes(value)) {
          return toolError(`${field} "${value}" isn't offered on WHOOP's symptom screen. Options: ${live.join(", ")}.`);
        }
      }
      const r = resolveSymptoms(symptoms ?? [], screenBefore);
      if (typeof r === "string") return toolError(r);
      resolved = r;
      // menstruation and cervical_mucus REPLACE on every POST (omitted = cleared), so resend the current ones.
      const flow = menstruation === undefined ? screenBefore.menstruation : menstruation;
      const mucus = cervical_mucus === undefined ? screenBefore.cervical_mucus : cervical_mucus;
      if (flow && flow !== "none") {
        warnings.push(`Flow "${flow}" also logs a period day on ${date}; clearing the flow later doesn't remove it (use period:{yes:false}).`);
      }
      writes.push({
        method: "POST",
        path: `${SYMPTOM_POST_PATH}?requestDate=${date}`,
        body: {
          tracker_inputs: resolved.map((s) => ({
            behavior_tracker_id: s.tracker.id,
            answered_yes: s.yes,
            ...(s.magnitude !== undefined ? { magnitude_input_value: s.magnitude } : {}),
            is_suggested: false,
          })),
          ...(flow ? { menstruation: flow } : {}),
          ...(mucus ? { cervical_mucus: mucus } : {}),
        },
      });
    }
    warnings.push("These logs also write journal rows for this date (menstruation 43, ovulation 79, cervical mucus, symptoms).");

    const current = {
      ...(wantLog ? before : {}),
      ...(screenBefore ? { menstruation: screenBefore.menstruation, cervical_mucus: screenBefore.cervical_mucus } : {}),
    };
    if (!confirm) {
      const [first, second] = writes;
      return respond("whoop_cycle_log", CycleLogOut, previewWith(
        first!.method,
        first!.path,
        second ? { requests: writes.map((w) => ({ method: w.method, path: w.path, body: w.body })) } : first!.body,
        warnings,
        current,
      ));
    }

    for (const w of writes) {
      const [path, query] = w.path.split("?requestDate=");
      try {
        if (w.method === "PUT") await client.put(path!, w.body);
        else await client.post(path!, w.body, { requestDate: query });
      } catch (error) {
        if (error instanceof WhoopApiError) {
          const done = writes.slice(0, writes.indexOf(w)).map((x) => `${x.method} ${x.path}`);
          return writeRejected(w.method === "PUT" ? "period/ovulation log" : "symptom log", path!, error,
            done.length ? `Already applied before this failed: ${done.join("; ")}.` : undefined);
        }
        throw error;
      }
    }

    // Fresh read-back of the date.
    const [ovAfter, screenRaw] = await Promise.all([
      fetchOverview(client, date, true),
      client.get(SYMPTOM_SCREEN_PATH, { requestDate: date }, { fresh: true }).catch(() => null),
    ]);
    const after = "raw" in ovAfter ? loggedOnDate(ovAfter.raw, date) : { period_day: null, ovulation_logged: null };
    const status = "raw" in ovAfter ? projectCycleSummary(ovAfter.raw, date).status : null;
    const screenAfter = screenRaw === null ? null : projectSymptomScreen(screenRaw);
    const mismatches: string[] = [];
    const logBody = writes.find((w) => w.method === "PUT")?.body as
      | { period_logs: Array<{ period: { answered_yes: boolean }; ovulation: { answered_yes: boolean } }> }
      | undefined;
    if (logBody) {
      const sent = logBody.period_logs[0]!;
      if (after.period_day !== sent.period.answered_yes && !(sent.period.answered_yes === false && screenAfter?.menstruation && screenAfter.menstruation !== "none")) {
        mismatches.push(`period day reads back ${after.period_day}`);
      }
      if (after.ovulation_logged !== null && after.ovulation_logged !== sent.ovulation.answered_yes) {
        mismatches.push(`ovulation reads back ${after.ovulation_logged}`);
      }
    }
    const symptomBody = writes.find((w) => w.method === "POST")?.body as { menstruation?: string; cervical_mucus?: string } | undefined;
    if (symptomBody) {
      if (!screenAfter) mismatches.push("symptom screen unreadable after the write");
      else {
        if ((symptomBody.menstruation ?? null) !== screenAfter.menstruation) mismatches.push(`menstruation reads back ${screenAfter.menstruation}`);
        if ((symptomBody.cervical_mucus ?? null) !== screenAfter.cervical_mucus) mismatches.push(`cervical_mucus reads back ${screenAfter.cervical_mucus}`);
        for (const s of resolved) {
          const got = screenAfter.trackers.find((t) => t.id === s.tracker.id)?.input;
          if (!got || got.yes !== s.yes) mismatches.push(`${s.tracker.name} reads back ${got?.yes ?? "unanswered"}`);
          else if (s.magnitude !== undefined && got.mag !== s.magnitude) mismatches.push(`${s.tracker.name} magnitude reads back ${got.mag}`);
        }
      }
    }
    return respond("whoop_cycle_log", CycleLogOut, {
      date,
      verified: mismatches.length === 0,
      day: {
        period_day: after.period_day,
        ovulation: after.ovulation_logged,
        status,
        flow: screenAfter?.menstruation ?? null,
        mucus: screenAfter?.cervical_mucus ?? null,
        symptoms: screenAfter ? answeredSymptoms(screenAfter) : [],
      },
      mismatches,
      warnings,
    });
  });
}
