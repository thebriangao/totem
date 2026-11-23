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
import { WhoopApiError, WhoopServerError } from "../../whoop/errors.js";
import { todayIso } from "../../lib/dates.js";
import { fetchOverview, SYMPTOM_SCREEN_PATH, WH } from "./cycle.js";

const LOG_PATH = `${WH}/menstrual-cycle-insights/log`;
const SYMPTOM_POST_PATH = `${WH}/symptom-insights/log/symptoms`;

const SymptomArg = z.object({
  id: z.number().int().optional().describe("From whoop_cycle include day_log"),
  name: z.string().min(1).optional().describe("Or the name, e.g. Headache"),
  yes: z.boolean().default(true).describe("false removes it"),
  magnitude: z.number().optional().describe("Graded symptoms only"),
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
      "Log or undo (yes:false) a date's period (flow 0 light, 1 medium, 2 heavy) or ovulation, and/or its menstruation flow, cervical " +
      "mucus and symptoms. Not period and ovulation on one date; no future dates. Any menstruation but none also logs a period day; to " +
      "remove a period fully, also pass menstruation:null. A period on a fresh date creates a cycle that undo won't remove. Previews " +
      "unless confirm:true.",
    input: {
      date: z.iso.date(),
      period: z.object({ yes: z.boolean(), flow: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional() }).optional(),
      ovulation: z.object({ yes: z.boolean() }).optional(),
      menstruation: z.enum(MENSTRUATION).nullable().optional().describe("null clears it"),
      cervical_mucus: z.enum(CERVICAL_MUCUS).nullable().optional().describe("null clears it"),
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
    /** What the period request says about the period (undefined: no period request). */
    let sentPeriod: boolean | undefined;

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
        if (o === false && before.period_day === true) {
          // Both are logged (a flow chip plus ovulation): the one request would clear both.
          return toolError(`${date} has both a period and ovulation logged, and WHOOP's request sets both at once. Add period:{yes:true} to keep the period, or period:{yes:false} to remove both.`);
        }
        if (o === true && before.period_day) warnings.push(`${date} is a logged period day; logging ovulation removes the period (WHOOP allows one per date).`);
        p = false;
      }
      if (o === undefined) {
        if (p === false && before.period_day !== true && before.ovulation_logged === true) {
          return toolError(`No period is logged on ${date}, but ovulation is; sending the undo would also remove the ovulation. Use ovulation:{yes:false} to remove it.`);
        }
        if (p === false && before.ovulation_logged === null) return toolError(`Couldn't tell what is logged on ${date}; pass both period and ovulation explicitly.`);
        if (p === false && before.ovulation_logged === true) {
          return toolError(`${date} has both a period and ovulation logged, and WHOOP's request sets both at once. Add ovulation:{yes:true} to keep the ovulation, or ovulation:{yes:false} to remove both.`);
        }
        if (p === true && before.ovulation_logged) warnings.push(`${date} has ovulation logged; logging a period replaces it.`);
        o = false;
      }
      if (p && before.period_day !== true) {
        warnings.push(`If ${date} starts a new period, WHOOP creates a cycle entry that undoing the period won't remove.`);
      }
      if (!p && !o) warnings.push("Undo leaves journal rows for this date answered No.");
      sentPeriod = p;
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
    // menstruation and cervical_mucus REPLACE on every POST (omitted = cleared), so whichever
    // the caller didn't set is re-sent as the screen shows it at that moment.
    const carriedFlow = (screen: SymptomScreen) => (menstruation === undefined ? screen.menstruation : menstruation);
    const symptomBody = (screen: SymptomScreen) => {
      const flow = carriedFlow(screen);
      const mucus = cervical_mucus === undefined ? screen.cervical_mucus : cervical_mucus;
      return {
        tracker_inputs: resolved.map((s) => ({
          behavior_tracker_id: s.tracker.id,
          answered_yes: s.yes,
          ...(s.magnitude !== undefined ? { magnitude_input_value: s.magnitude } : {}),
          is_suggested: false,
        })),
        ...(flow ? { menstruation: flow } : {}),
        ...(mucus ? { cervical_mucus: mucus } : {}),
      };
    };
    /** A field the caller left alone can only be carried if the screen showed its chips. */
    const unreadable = (screen: SymptomScreen): string | null => {
      for (const [field, value] of [["menstruation", menstruation], ["cervical_mucus", cervical_mucus]] as const) {
        if (value === undefined && !screen.options[field].length) {
          return `Couldn't read the current ${field} for ${date} (WHOOP's symptom screen changed), and a symptom log clears whatever isn't re-sent. Pass menstruation and cervical_mucus explicitly (null clears).`;
        }
      }
      return null;
    };
    if (wantSymptoms) {
      screenBefore = projectSymptomScreen(await client.get(SYMPTOM_SCREEN_PATH, { requestDate: date }, { fresh: true }));
      for (const [field, value] of [["menstruation", menstruation], ["cervical_mucus", cervical_mucus]] as const) {
        const live = screenBefore.options[field];
        if (typeof value === "string" && live.length && !live.includes(value)) {
          return toolError(`${field} "${value}" isn't offered on WHOOP's symptom screen. Options: ${live.join(", ")}.`);
        }
      }
      const lost = unreadable(screenBefore);
      if (lost) return toolError(lost);
      const r = resolveSymptoms(symptoms ?? [], screenBefore);
      if (typeof r === "string") return toolError(r);
      resolved = r;
      const flow = carriedFlow(screenBefore);
      const flows = Boolean(flow) && flow !== "none";
      const removesPeriod = sentPeriod === false;
      if (flows && removesPeriod) {
        // Re-sending the day's flow chip would log the period day right back.
        return toolError(`${date} has the flow chip "${flow}", which marks it as a period day, and this request removes the period. Add menstruation:null to clear the chip too.`);
      }
      if (flows) {
        warnings.push(`Flow "${flow}" also logs a period day on ${date}; clearing the flow later doesn't remove it (use period:{yes:false}).`);
      }
      const post = { method: "POST", path: `${SYMPTOM_POST_PATH}?requestDate=${date}`, body: symptomBody(screenBefore) };
      // Removing a period: clear the chips first, then the period (the order verified live).
      // Logging one: the period request goes first and the chips are read again before the POST.
      if (removesPeriod) writes.unshift(post);
      else writes.push(post);
      if (sentPeriod === true && (menstruation === undefined || cervical_mucus === undefined)) {
        warnings.push("Flow and mucus you didn't set are read again after the period request and re-sent as they stand then.");
      }
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
      const done = writes.slice(0, writes.indexOf(w)).map((x) => `${x.method} ${x.path}`);
      const applied = done.length ? `Already applied before this failed: ${done.join("; ")}.` : undefined;
      try {
        if (w.method === "PUT") await client.put(path!, w.body);
        else {
          if (done.length) {
            // The period request can change the day's flow chip (a period logged with a flow
            // shows as that chip), so carry what is there now, not what was there before it.
            const now = projectSymptomScreen(await client.get(SYMPTOM_SCREEN_PATH, { requestDate: date }, { fresh: true }));
            const lost = unreadable(now);
            if (lost) return toolError(lost, applied ? { hint: applied } : {});
            w.body = symptomBody(now);
          }
          await client.post(path!, w.body, { requestDate: query });
        }
      } catch (error) {
        if (error instanceof WhoopApiError) {
          return writeRejected(w.method === "PUT" ? "period/ovulation log" : "symptom log", path!, error, applied);
        }
        // A 5xx on the second step: the first one is already in. Say so instead of just throwing.
        if (error instanceof WhoopServerError && applied) {
          return toolError(`WHOOP answered ${error.status} on the ${w.method === "PUT" ? "period/ovulation" : "symptom"} step.`, { status: error.status, endpoint: path!, hint: applied });
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
      if (after.period_day !== sent.period.answered_yes) {
        mismatches.push(`period day reads back ${after.period_day}`);
        if (sent.period.answered_yes === false && screenAfter?.menstruation && screenAfter.menstruation !== "none") {
          warnings.push(`The flow chip "${screenAfter.menstruation}" is still set on ${date} and keeps it a period day; clear it with menstruation:null and remove the period again.`);
        }
      }
      if (after.ovulation_logged !== null && after.ovulation_logged !== sent.ovulation.answered_yes) {
        mismatches.push(`ovulation reads back ${after.ovulation_logged}`);
      }
    }
    const sentSymptoms = writes.find((w) => w.method === "POST")?.body as { menstruation?: string; cervical_mucus?: string } | undefined;
    if (sentSymptoms) {
      if (!screenAfter) mismatches.push("symptom screen unreadable after the write");
      else {
        if ((sentSymptoms.menstruation ?? null) !== screenAfter.menstruation) mismatches.push(`menstruation reads back ${screenAfter.menstruation}`);
        if ((sentSymptoms.cervical_mucus ?? null) !== screenAfter.cervical_mucus) mismatches.push(`cervical_mucus reads back ${screenAfter.cervical_mucus}`);
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
