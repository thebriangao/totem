import { describe, expect, it } from "vitest";
import { registerCycle } from "../../src/tools/v2/cycle.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { call, connect, fx, mockClient, routedGet } from "./health_plans_helpers.js";

const WH = "/womens-health-service/v1";
const OVERVIEW = `${WH}/hormonal-insights/overview`;
const OLD = `${WH}/menstrual-cycle-insights`;

describe("whoop_cycle", () => {
  it("default = one overview call, summary only (small)", async () => {
    const get = routedGet({ [OVERVIEW]: fx("hi_overview_cycle_day.json") });
    const client = await connect((s) => registerCycle(s, mockClient({ get })));
    const { out, text } = await call(client, "whoop_cycle", { date: "2026-11-21" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(OVERVIEW, { date: "2026-11-21" }, { fresh: false });
    expect(out).toMatchObject({ available: true, source: "hormonal_insights", cycle: { cycle_day: 21, phase: "OVULATORY" } });
    expect(out.calendar).toBeUndefined();
    expect(text.length).toBeLessThan(1500);
  });

  it("include adds calendar, settings, cycles, symptoms and the day log", async () => {
    const get = routedGet({
      [OVERVIEW]: fx("hi_overview_period_day.json"),
      [`${WH}/hormonal-insights/settings`]: fx("hi_settings.json"),
      [`${WH}/menstrual-cycle-insights/cycles`]: fx("mci_cycles.json"),
      [`${WH}/menstrual-cycle-insights/symptoms`]: fx("mci_symptoms.json"),
      [`${WH}/symptom-insights/log/symptoms/screen`]: fx("symptom_screen.json"),
    });
    const client = await connect((s) => registerCycle(s, mockClient({ get })));
    const { out } = await call(client, "whoop_cycle", { date: "2026-10-16", include: ["calendar", "settings", "cycles", "symptoms", "day_log"] });
    expect(get).toHaveBeenCalledWith(`${WH}/symptom-insights/log/symptoms/screen`, { requestDate: "2026-10-16" });
    expect(out.calendar.month).toBe("2026-10");
    expect(out.settings.contraception).toBe("PILL");
    expect(out.cycles).toHaveLength(2);
    expect(out.symptoms.current.logged).toBe(4);
    expect(out.day_log).toEqual({ flow: "light_flow", mucus: "vaginal-discharge---creamy", symptoms: [{ id: 211, name: "Fatigue", yes: true, mag: null }, { id: 177, name: "Headache", yes: true, mag: 1 }] });
  });

  it("falls back to the old menstrual-cycle-insights screen (D10)", async () => {
    const get = routedGet({ [OVERVIEW]: new WhoopApiError(404, OVERVIEW, ""), [OLD]: fx("mci_insights_old.json") });
    const client = await connect((s) => registerCycle(s, mockClient({ get })));
    const { out } = await call(client, "whoop_cycle", { date: "2026-11-21" });
    expect(out).toMatchObject({ available: true, source: "menstrual_cycle_insights", cycle: { phase: "HORMONAL_BIRTH_CONTROL" } });
  });

  it("available:false with WHOOP's reason before onboarding", async () => {
    const err = new WhoopApiError(400, OVERVIEW, "User has no contraception status", "User has no contraception status");
    const get = routedGet({ [OVERVIEW]: err, [OLD]: new WhoopApiError(400, OLD, "") });
    const client = await connect((s) => registerCycle(s, mockClient({ get })));
    const { out, isError } = await call(client, "whoop_cycle", {});
    expect(isError).toBe(false);
    expect(out).toMatchObject({ available: false, cycle: null });
    expect(out.reason).toMatch(/no contraception status/);
  });
});
