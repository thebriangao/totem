// Women's health (SPEC.md D10, §4.9; specs/health.md §2.2). Pure projections over:
//   GET /womens-health-service/v1/hormonal-insights/overview?date=   (LIST of items)
//   GET /womens-health-service/v1/menstrual-cycle-insights?date=      (old tiles[] BFF, fallback)
//   GET …/hormonal-insights/settings, …/menstrual-cycle-insights/cycles, …/symptoms
//   GET …/symptom-insights/log/symptoms/screen?requestDate=           (day log + live enums)
// Both overview forms carry HEADER_TILE, a calendar and TYPICAL_CYCLE_TILE; in the old
// form the stats tile sits inside MCI_TILE_SECTION.content.items[], so everything is
// found by type with the BFF walker, never by position. Calendar `cycle_id`s are dropped.
import type {
  CycleCalendarT,
  CycleEntryT,
  CycleSummaryT,
  DayLogT,
  HormonalSettingsT,
  SymptomInputT,
  SymptomSegmentT,
} from "../schemas/hormonal_insights.js";
import { byId, byType, findAll, get, parseNumber, str, type Node } from "../whoop/bff.js";

const isObj = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const int = (re: RegExp, s: string | null): number | null => {
  const m = s?.match(re);
  return m ? Number(m[1]) : null;
};

/** Calendar days from either form: typed HORMONAL_INSIGHTS_CALENDAR_DAY items or CALENDAR_TILE rows. */
function calendarDays(raw: unknown): Node[] {
  const typed = byType(raw, "HORMONAL_INSIGHTS_CALENDAR_DAY")
    .map((d) => d.content)
    .filter(isObj);
  if (typed.length) return typed;
  const tile = byType(raw, "CALENDAR_TILE")[0];
  return arr(get(tile, "content", "calendar", "days_of_month")).filter(isObj);
}

function statValue(stats: unknown, title: RegExp): number | null {
  for (const s of arr(stats)) {
    if (isObj(s) && title.test(str(s.title_display) ?? "")) return parseNumber(s.value_display);
  }
  return null;
}

function tags(raw: unknown, id: string): string[] {
  return arr(get(byId(raw, id), "tags"))
    .map((t) => (isObj(t) ? str(t.title) : null))
    .filter((t): t is string => t !== null);
}

export function projectCycleSummary(raw: unknown, date: string): CycleSummaryT {
  const header = byType(raw, "HEADER_TILE")[0];
  const h = isObj(header?.content) ? header.content : null;
  const title = h ? str(h.title_display) : null;
  const subtitle = h ? str(h.subtitle_display) : null;
  const description = h ? str(h.description_display) : null;
  const nextText = [description, subtitle].find((s) => s && /next period/i.test(s)) ?? null;
  const range = nextText?.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s*day/i);
  const stats = get(byType(raw, "TYPICAL_CYCLE_TILE")[0], "content", "stats");
  const today = calendarDays(raw).find((d) => d.date === date);
  return {
    status: title,
    detail: description && description !== nextText ? description : null,
    phase: h ? str(h.style) : null,
    cycle_day: int(/cycle day\s+(\d+)/i, title),
    period_day: int(/period day\s+(\d+)/i, title),
    next_period: nextText
      ? { min_days: range ? Number(range[1]) : null, max_days: range ? Number(range[2] ?? range[1]) : null }
      : null,
    today: today ? { state: str(today.day_state), phase: str(today.phase), symptoms: today.bottom_state === "SYMPTOMS" } : null,
    journal: {
      symptoms: tags(raw, "cycle_journal_symptom_tile"),
      period: tags(raw, "cycle_journal_period_tile"),
      ovulation: tags(raw, "cycle_journal_ovulation_tile"),
    },
    typical: {
      period_days: statValue(stats, /PERIOD LENGTH/i),
      cycle_days: statValue(stats, /CYCLE LENGTH/i),
      variation_days: statValue(stats, /VARIATION/i),
    },
  };
}

/** The month as runs of consecutive days sharing a state and phase. */
export function projectCycleCalendar(raw: unknown): CycleCalendarT | null {
  const days = calendarDays(raw)
    .map((d) => ({ date: str(d.date), state: str(d.day_state), phase: str(d.phase), symptoms: d.bottom_state === "SYMPTOMS" }))
    .filter((d): d is { date: string; state: string | null; phase: string | null; symptoms: boolean } =>
      d.date !== null && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return null;
  const month = days[0]!.date.slice(0, 7);
  const runs: CycleCalendarT["runs"] = [];
  for (const d of days) {
    if (d.date.slice(0, 7) !== month) continue;
    const day = Number(d.date.slice(8, 10));
    const last = runs[runs.length - 1];
    if (last && last[1] === day - 1 && last[2] === d.state && last[3] === d.phase) last[1] = day;
    else runs.push([day, day, d.state, d.phase]);
  }
  return {
    month,
    runs,
    symptom_days: days.filter((d) => d.symptoms && d.date.startsWith(month)).map((d) => Number(d.date.slice(8, 10))),
  };
}

function sameDate(value: unknown, date: string): boolean {
  if (typeof value === "string") return value === date;
  if (Array.isArray(value) && value.length === 3) {
    return `${value[0]}-${String(value[1]).padStart(2, "0")}-${String(value[2]).padStart(2, "0")}` === date;
  }
  return false;
}

/**
 * What is logged on `date`, from an overview selected on that date:
 * - period_day: the calendar day is PERIOD (a logged period day, not a prediction);
 * - ovulation_logged: the ovulation tile's toggle action. When ovulation is logged
 *   the app's action is the REMOVE body (ovulation answered_yes:false); otherwise it
 *   is the LOG body (ovulation answered_yes:true). null when not determinable.
 */
export function loggedOnDate(raw: unknown, date: string): { period_day: boolean | null; ovulation_logged: boolean | null } {
  const day = calendarDays(raw).find((d) => d.date === date);
  let ovulation: boolean | null = null;
  const tile = byId(raw, "cycle_journal_ovulation_tile");
  for (const n of findAll(tile, (x) => Array.isArray(x.period_logs))) {
    const entry = arr(n.period_logs).find((e) => isObj(e) && sameDate(e.date, date));
    const yes = isObj(entry) ? get(entry, "ovulation", "answered_yes") : undefined;
    if (typeof yes === "boolean") ovulation = !yes;
  }
  return { period_day: day ? day.day_state === "PERIOD" : null, ovulation_logged: ovulation };
}

export function projectHormonalSettings(raw: unknown): HormonalSettingsT {
  const root = isObj(raw) ? raw : {};
  const toggle = (type: string): boolean | null => {
    const t = byType(root.tiles, "SETTINGS_TOGGLE").find((x) => get(x, "content", "type") === type);
    return bool(get(t, "content", "enabled"));
  };
  const selected = (drawer: unknown, flag: "selected" | "is_selected"): string[] =>
    arr(get(drawer, "options"))
      .filter((o) => isObj(o) && o[flag] === true)
      .map((o) => str((o as Node).value))
      .filter((v): v is string => v !== null);
  return {
    enabled: toggle("HORMONAL_INSIGHTS"),
    trends_overlay: toggle("MENSTRUAL_CYCLE_TRENDS_OVERLAY"),
    mode: selected(root.hormonal_insights_mode_drawer, "selected")[0] ?? null,
    contraception: selected(root.contraception_type_drawer, "selected")[0] ?? null,
    goals: selected(root.goals_drawer, "is_selected"),
  };
}

export function projectCycles(raw: unknown): CycleEntryT[] {
  return findAll(raw, (n) => isObj(n.cycle) && isObj(get(n, "cycle", "header"))).map((item) => {
    const label = str(get(item, "cycle", "header", "subtitle_display"));
    const sheet = get(item, "bottom_sheet");
    const rangeDates = arr(get(sheet, "hide_option", "date_range") ?? get(sheet, "unhide_option", "date_range"));
    const iso = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    return {
      start: iso(get(sheet, "edit_option", "date")) ?? iso(rangeDates[0]),
      end: iso(rangeDates[1]),
      days: int(/(\d+)\s*day/i, label),
      period_days: arr(get(item, "cycle", "tick_marks")).filter((t) => isObj(t) && t.style === "MENSTRUAL").length,
      current: /current/i.test(label ?? ""),
      hidden: item.hidden === true,
    };
  });
}

function symptomSegment(seg: unknown): SymptomSegmentT | null {
  if (!isObj(seg)) return null;
  const header = byType(seg.tiles, "HEADER_TILE")[0];
  return {
    logged: parseNumber(get(header, "content", "title_display")),
    rows: byType(seg.tiles, "DAILY_TICK_MARK").flatMap((row) => {
      // The first row is the phase strip (no header); the rest are one symptom each.
      const name = str(get(row, "content", "header", "subtitle_display"));
      if (!name) return [];
      return [{
        name,
        logs: parseNumber(get(row, "content", "header", "right_aligned_description")),
        next: str(get(row, "content", "footer", "title")),
      }];
    }),
  };
}

export function projectSymptomPatterns(raw: unknown) {
  const root = isObj(raw) ? raw : {};
  return {
    current: symptomSegment(root.current_cycle_segment),
    last_3: symptomSegment(root.last_three_cycles_segment),
  };
}

export interface ScreenTracker {
  id: number;
  name: string;
  group: string | null;
  magnitude: { type: "step"; choices: number[] } | { type: "range"; min: number; max: number } | null;
  input: SymptomInputT | null;
}

export interface SymptomScreen {
  menstruation: string | null;
  cervical_mucus: string | null;
  options: { menstruation: string[]; cervical_mucus: string[] };
  trackers: ScreenTracker[];
}

function cellList(raw: unknown, id: string): { options: string[]; selected: string | null } {
  const list = byType(raw, "SELECTABLE_CELL_LIST").find((l) => get(l, "content", "id") === id);
  const cells = arr(get(list, "content", "cells")).filter(isObj);
  return {
    options: cells.map((c) => str(c.id)).filter((v): v is string => v !== null),
    selected: str(cells.find((c) => c.selected === true)?.id),
  };
}

/** The symptom log screen: the day's selections and the live enums / tracker specs. */
export function projectSymptomScreen(raw: unknown): SymptomScreen {
  const state = get(raw, "lifecycle_interactions", "on_start", "action", "parameters", "state");
  const flow = cellList(raw, "menstruation");
  const mucus = cellList(raw, "cervical_mucus");
  const trackers: ScreenTracker[] = [];
  const sections = arr(get(raw, "content", "item", "content", "items"));
  const groups = sections.length ? sections : [raw];
  for (const section of groups) {
    const group = isObj(section) ? str(section.type) : null;
    for (const t of byType(section, "TRACKED_BEHAVIOR")) {
      const bt = get(t, "content", "behavior_tracker");
      const id = get(bt, "id");
      const name = str(get(bt, "title"));
      if (typeof id !== "number" || !name || trackers.some((x) => x.id === id)) continue;
      const mag = get(bt, "magnitude");
      const choices = arr(get(mag, "choices")).map((c) => get(c, "value")).filter((v): v is number => typeof v === "number");
      const min = get(mag, "minimum_inclusive");
      const max = get(mag, "maximum_inclusive");
      const ti = get(t, "content", "tracker_input");
      trackers.push({
        id,
        name,
        group: group && group !== "SINGLE_ITEM" ? group : null,
        magnitude: get(mag, "type") === "step" && choices.length
          ? { type: "step", choices }
          : typeof min === "number" && typeof max === "number"
            ? { type: "range", min, max }
            : null,
        input: isObj(ti)
          ? {
              id,
              name,
              yes: bool(ti.answered_yes),
              mag: typeof ti.magnitude_input_value === "number" ? ti.magnitude_input_value : null,
            }
          : null,
      });
    }
  }
  return {
    menstruation: flow.selected ?? str(get(state, "$menstruation_id")),
    cervical_mucus: mucus.selected ?? str(get(state, "$cervical_mucus_id")),
    options: { menstruation: flow.options, cervical_mucus: mucus.options },
    trackers,
  };
}

/** Answered symptom rows (yes:false = removed but still stored). */
export function answeredSymptoms(screen: SymptomScreen): SymptomInputT[] {
  return screen.trackers.flatMap((t) => (t.input && t.input.yes !== null ? [t.input] : []));
}

export function dayLogFromScreen(screen: SymptomScreen): DayLogT {
  return { flow: screen.menstruation, mucus: screen.cervical_mucus, symptoms: answeredSymptoms(screen) };
}
