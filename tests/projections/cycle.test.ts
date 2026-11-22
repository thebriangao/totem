import { describe, expect, it } from "vitest";
import {
  answeredSymptoms,
  loggedOnDate,
  projectCycleCalendar,
  projectCycles,
  projectCycleSummary,
  projectHormonalSettings,
  projectSymptomPatterns,
  projectSymptomScreen,
} from "../../src/projections/hormonal_insights.js";
import { CycleCalendar, CycleSummary, HormonalSettings } from "../../src/schemas/hormonal_insights.js";
import { fx } from "../tools/health_plans_helpers.js";

describe("projectCycleSummary — hormonal-insights overview", () => {
  it("parses cycle day, phase, next-period window, the date's calendar state and journal tags", () => {
    const out = projectCycleSummary(fx("hi_overview_cycle_day.json"), "2026-11-21");
    expect(() => CycleSummary.parse(out)).not.toThrow();
    expect(out).toMatchObject({
      status: "Cycle Day 21", detail: null, phase: "OVULATORY", cycle_day: 21, period_day: null,
      next_period: { min_days: 8, max_days: 16 },
      today: { state: "PERIOD", phase: "OVULATORY", symptoms: true },
      journal: { period: ["Started Today"], ovulation: ["Started Today"] },
    });
  });

  it("parses a period day and keeps an unparsed header description as detail", () => {
    expect(projectCycleSummary(fx("hi_overview_period_day.json"), "2026-10-16")).toMatchObject({
      status: "Period Day 2", period_day: 2, phase: "MENSTRUAL", next_period: null, journal: { symptoms: ["Heavy Flow"], period: ["Oct 15-16"] },
    });
  });

  it("reads the old menstrual-cycle-insights tiles (fallback), incl. TYPICAL_CYCLE_TILE nested in MCI_TILE_SECTION", () => {
    const old = fx("mci_insights_old.json") as { tiles: Array<{ type: string; content: { items?: Array<{ type: string; content: { stats: Array<{ value_display: string }> } }> } }> };
    expect(projectCycleSummary(old, "2026-11-21")).toMatchObject({ status: "On Hormonal Birth Control", detail: "Since November 21, 2026", phase: "HORMONAL_BIRTH_CONTROL" });
    // Populate the nested stats tile (the throwaway account shows "-" until it has history).
    for (const t of old.tiles) for (const i of t.content.items ?? []) if (i.type === "TYPICAL_CYCLE_TILE") {
      i.content.stats[0]!.value_display = "5"; i.content.stats[1]!.value_display = "28"; i.content.stats[2]!.value_display = "3";
    }
    expect(projectCycleSummary(old, "2026-11-21").typical).toEqual({ period_days: 5, cycle_days: 28, variation_days: 3 });
  });

  it("degrades to nulls on an empty body", () => {
    expect(projectCycleSummary({}, "2026-11-21")).toMatchObject({ status: null, phase: null, cycle_day: null, today: null, typical: { cycle_days: null } });
  });
});

describe("projectCycleCalendar", () => {
  it("run-length encodes the month as [from_day, to_day, state, phase] with symptom days", () => {
    const cal = projectCycleCalendar(fx("hi_overview_cycle_day.json"));
    expect(() => CycleCalendar.parse(cal)).not.toThrow();
    expect(cal).toEqual({
      month: "2026-11",
      runs: [[1, 20, "PERIOD", "MENSTRUAL"], [21, 21, "PERIOD", "OVULATORY"], [22, 22, "NONE", "OVULATORY"], [23, 30, "WHITE_NO_BACKGROUND", "NONE"]],
      symptom_days: [21],
    });
  });

  it("handles the old CALENDAR_TILE rows the same way", () => {
    expect(projectCycleCalendar(fx("mci_insights_old.json"))?.runs[3]).toEqual([28, 30, "PREDICTED_PERIOD", "HORMONAL_BIRTH_CONTROL"]);
  });

  it("never emits cycle ids", () => {
    expect(JSON.stringify(projectCycleCalendar(fx("hi_overview_cycle_day.json")))).not.toContain("cycle_id");
  });
});

describe("loggedOnDate", () => {
  it("period day = calendar PERIOD; ovulation from the ovulation tile's toggle action", () => {
    expect(loggedOnDate(fx("hi_overview_period_day.json"), "2026-10-16")).toEqual({ period_day: true, ovulation_logged: false });
    expect(loggedOnDate(fx("hi_overview_ovulation.json"), "2026-10-17")).toEqual({ period_day: false, ovulation_logged: true });
  });
  it("unknown when the date isn't on the screen", () => {
    expect(loggedOnDate(fx("hi_overview_period_day.json"), "2026-12-01")).toEqual({ period_day: null, ovulation_logged: null });
  });
});

describe("settings, cycles, symptom patterns", () => {
  it("settings from the drawers' selected flags and toggles", () => {
    const s = projectHormonalSettings(fx("hi_settings.json"));
    expect(() => HormonalSettings.parse(s)).not.toThrow();
    expect(s).toEqual({ enabled: true, trends_overlay: true, mode: "MENSTRUATING", contraception: "PILL", goals: ["TRY_TO_CONCEIVE", "MONITOR_PERIMENOPAUSE", "MANAGE_HORMONAL_CONDITION"] });
  });

  it("cycles with dates from the bottom sheet and MENSTRUAL tick counts", () => {
    expect(projectCycles(fx("mci_cycles.json"))).toEqual([
      { start: "2026-11-01", end: "2026-11-21", days: 21, period_days: 19, current: true, hidden: false },
      { start: "2026-10-15", end: "2026-10-31", days: 17, period_days: 2, current: false, hidden: false },
    ]);
  });

  it("symptom rows skip the phase strip", () => {
    const p = projectSymptomPatterns(fx("mci_symptoms.json"));
    expect(p.current).toMatchObject({ logged: 4, rows: [{ name: "Headache", logs: 2, next: "Possible in 30 days" }, { name: "Vaginal Discharge - Grey", logs: 1 }, { name: "Mood Swings" }, { name: "Vaginal Spotting" }] });
    expect(p.last_3?.rows).toHaveLength(4);
  });
});

describe("projectSymptomScreen — the day log and the live enums", () => {
  const s = projectSymptomScreen(fx("symptom_screen.json"));
  it("reads the day's flow, mucus and answered trackers", () => {
    expect(s.menstruation).toBe("light_flow");
    expect(s.cervical_mucus).toBe("vaginal-discharge---creamy");
    expect(answeredSymptoms(s)).toEqual([{ id: 211, name: "Fatigue", yes: true, mag: null }, { id: 177, name: "Headache", yes: true, mag: 1 }]);
  });
  it("exposes the live enums incl. vaginal-dryness and cervical_mucus_pink_brown_or_tan", () => {
    expect(s.options.menstruation).toEqual(["none", "light_flow", "medium_flow", "heavy_flow", "spotting"]);
    expect(s.options.cervical_mucus).toContain("vaginal-dryness");
    expect(s.options.cervical_mucus).toContain("cervical_mucus_pink_brown_or_tan");
  });
  it("captures each tracker's magnitude spec", () => {
    expect(s.trackers).toHaveLength(35);
    expect(s.trackers.find((t) => t.id === 177)?.magnitude).toEqual({ type: "step", choices: [0, 1, 2] });
    expect(s.trackers.find((t) => t.id === 95)?.magnitude).toEqual({ type: "step", choices: [0, 2, 4] });
    expect(s.trackers.find((t) => t.id === 362)?.magnitude).toEqual({ type: "range", min: 1, max: 1000 });
    expect(s.trackers.find((t) => t.id === 210)?.magnitude).toBeNull();
    expect(s.trackers.find((t) => t.id === 135)?.group).toBe("mind_and_mood");
  });
});
