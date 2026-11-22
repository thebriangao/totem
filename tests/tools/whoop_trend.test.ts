import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerTrend } from "../../src/tools/v2/trend.js";
import { compareRows, pointDate, projectTrendWindow, rangeLabelStart, windowBounds } from "../../src/projections/v2/trend.js";
import { call, closeAll, connect, err500, fx, oldFx, pinToday, routedGet, unpinToday } from "./reads_core_harness.js";

describe("whoop_trend projection", () => {
  it("derives inclusive window bounds from endDate (not next_date_time or the display string)", () => {
    expect(windowBounds("2026-11-21", "week")).toEqual({ start: "2026-11-15", end: "2026-11-21" });
    expect(windowBounds("2026-11-21", "month")).toEqual({ start: "2026-10-23", end: "2026-11-21" });
    expect(windowBounds("2026-11-21", "six_month")).toEqual({ start: "2026-05-26", end: "2026-11-21" });
    // Matches WHOOP's own labels: "NOV 15 - NOV 21", "OCT 23 - NOV 21", "MAY 26 - NOV 21".
    const prev = projectTrendWindow(fx("trend_day_strain_prev"), "2026-11-14", "week", false)!;
    expect([prev.start, prev.end]).toEqual(["2026-11-08", "2026-11-14"]);
  });

  // Live 2026-11-21: HR_ZONES_1_3 / 4_5 / ALL and STRENGTH_ACTIVITY_TIME label their month
  // "OCT 25 - NOV 21" (28 days) and six months "MAY 31 - NOV 21" (175), and name the figure
  // "WEEKLY TOTAL" / "AVG. WEEKLY TOTAL". With endDate 2026-11-18 the month is "OCT 22 - NOV 18".
  it("takes the window start from WHOOP's range label: weekly-total metrics span 28 and 175 days", () => {
    const month = projectTrendWindow(fx("trend_hr_zones_all"), "2026-11-21", "month", false)!;
    expect([month.start, month.end]).toEqual(["2026-10-25", "2026-11-21"]);
    expect(projectTrendWindow(fx("trend_hr_zones_all"), "2026-11-21", "six_month", false)!.start).toBe("2026-05-31");
    expect(month.rows[0]).toEqual({ key: "HR_ZONES_ALL", avg: 17, prev_avg: 0, change_pct: null, direction: null, unit: "min", per: "week" });
    const strain = projectTrendWindow(fx("trend_day_strain"), "2026-11-21", "month", false)!;
    expect(strain.start).toBe("2026-10-23");
    expect(strain.rows[0]!.per).toBeUndefined();
  });

  it("parses range labels across a year boundary and ignores one that does not end on endDate", () => {
    expect(rangeLabelStart("OCT 22 - NOV 18, 26", "2026-11-18")).toBe("2026-10-22");
    expect(rangeLabelStart("DEC 28, 26 - JAN 3, 27", "2027-01-03")).toBe("2026-12-28");
    expect(rangeLabelStart("JUL 8, 26 - JAN 3, 27", "2027-01-03")).toBe("2026-07-08");
    expect(rangeLabelStart("NOV 15 - NOV 21, 26", "2026-11-14")).toBeNull();
    expect(rangeLabelStart("LAST 30 DAYS", "2026-11-21")).toBeNull();
    expect(rangeLabelStart(null, "2026-11-21")).toBeNull();
  });

  it("reads WHOOP's averages and change, with compact daily points", () => {
    const w = projectTrendWindow(oldFx("trend_hrv"), "2026-05-23", "month", true)!;
    expect(w.rows).toEqual([{ key: "HRV", avg: 40, prev_avg: 54, change_pct: -26, direction: "DOWN", unit: "ms" }]);
    expect(w.points).toMatchObject({ start: "2026-04-24", step: "day" });
    expect(w.points!.values).toHaveLength(30);
    expect(w.points!.values[0]).toBe(44);
    expect(projectTrendWindow(oldFx("trend_hrv"), "2026-05-23", "month", false)!.points).toBeUndefined();
  });

  it("converts duration metrics to minutes (rows and points)", () => {
    const w = projectTrendWindow(oldFx("trend_time_in_bed"), "2026-05-30", "week", true)!;
    expect(w.rows[0]).toMatchObject({ key: "TIME_IN_BED", avg: 512.2, prev_avg: 500.1, unit: "min" });
    expect(w.points!.values.slice(0, 2)).toEqual([674, 538]); // 11:14 and 8:58 (bar values, not the clock-time top labels)
  });

  it("emits both HOURS_V_NEED rows and the strain breakdown", () => {
    expect(projectTrendWindow(fx("trend_hours_v_need"), "2026-11-21", "week", false)!.rows.map((r) => [r.key, r.unit]))
      .toEqual([["SLEEP_NEED", "min"], ["SLEEP_HOURS", "min"]]);
    const strain = projectTrendWindow(fx("trend_day_strain"), "2026-11-21", "week", true)!;
    expect(strain.breakdown?.[0]).toEqual(["All Out (>18.0)", 1]);
    expect(strain.rows[0]).toMatchObject({ key: "DAY_STRAIN", avg: null, direction: null });
    expect(strain.points!.values).toEqual([null, null, null, null, null, null, 20.9]);
  });

  it("reads stacked HR_ZONES_ALL days from the group total and flags VO2_MAX's hidden week", () => {
    const z = projectTrendWindow(fx("trend_hr_zones_all"), "2026-11-21", "week", true)!;
    expect(z.points!.values.slice(5)).toEqual([0, 17]);
    expect(projectTrendWindow(fx("trend_vo2"), "2026-11-21", "week", false)!.hidden).toBe(true);
  });

  it("parses point labels with and without a year", () => {
    expect(pointDate("SUN, MAY 17", "2026-05-23")).toBe("2026-05-17");
    expect(pointDate("TUE, NOV 25, 2025", "2026-05-23")).toBe("2025-11-25");
    expect(pointDate("WED, DEC 31", "2026-01-04")).toBe("2025-12-31");
  });

  it("computes a−b deltas per trend key", () => {
    expect(compareRows(
      [{ key: "HRV", avg: 40, prev_avg: null, change_pct: null, direction: null, unit: "ms" }],
      [{ key: "HRV", avg: 50, prev_avg: null, change_pct: null, direction: null, unit: "ms" }],
    )).toEqual([{ key: "HRV", diff: -10, diff_pct: -20 }]);
  });
});

describe("whoop_trend tool", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  it("always sends endDate (today by default) and returns the requested window", async () => {
    const get = routedGetByQuery({ "HRV@2026-11-21": oldFx("trend_hrv") });
    const out = await call(await connect(registerTrend, get), "whoop_trend", { metrics: ["HRV"] });
    expect(out.window).toBe("month");
    expect(out.metrics[0].a).toMatchObject({ start: "2026-10-23", end: "2026-11-21" });
  });

  it("compare_end_date fetches a second window per metric and returns deltas", async () => {
    const get = routedGetByQuery({ "DAY_STRAIN@2026-11-21": fx("trend_day_strain"), "DAY_STRAIN@2026-11-14": fx("trend_day_strain_prev") });
    const out = await call(await connect(registerTrend, get), "whoop_trend", { metrics: ["DAY_STRAIN"], window: "week", compare_end_date: "2026-11-14" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(out.metrics[0].a.start).toBe("2026-11-15");
    expect(out.metrics[0].b.start).toBe("2026-11-08");
    expect(out.metrics[0].delta).toEqual([expect.objectContaining({ key: "DAY_STRAIN" })]);
  });

  it("reports a per-metric error (TOTAL_VOLUME_LOAD-style 500s) without failing the others", async () => {
    const get = routedGetByQuery({ "HRV@2026-11-21": oldFx("trend_hrv"), "RHR@2026-11-21": err500("/progression-service/v3/trends/RHR") });
    const out = await call(await connect(registerTrend, get), "whoop_trend", { metrics: ["HRV", "RHR"] });
    expect(out.metrics[0].a.rows[0].key).toBe("HRV");
    expect(out.metrics[1].error).toMatch(/500/);
  });

  it("validates metrics: 1–5, no repeats, no year window, no TOTAL_VOLUME_LOAD", async () => {
    const get = routedGetByQuery({});
    const client = await connect(registerTrend, get);
    for (const args of [
      { metrics: [] },
      { metrics: ["HRV", "HRV"] },
      { metrics: ["HRV", "RHR", "STEPS", "CALORIES", "RECOVERY", "DAY_STRAIN"] },
      { metrics: ["TOTAL_VOLUME_LOAD"] },
      { metrics: ["HRV"], window: "year" },
      { metrics: ["HRV"], compare_end_date: "2026-11-21" },
    ]) {
      await expect(call(client, "whoop_trend", args)).rejects.toThrow();
    }
    expect(get).not.toHaveBeenCalled();
    const ok = routedGetByQuery({ "HR_ZONES_ALL@2026-11-21": fx("trend_hr_zones_all"), "RESTORATIVE_SLEEP_PERCENT@2026-11-21": fx("trend_vo2") });
    const out = await call(await connect(registerTrend, ok), "whoop_trend", { metrics: ["HR_ZONES_ALL", "RESTORATIVE_SLEEP_PERCENT"] });
    expect(out.metrics).toHaveLength(2);
  });
});

/** Route trend reads by "METRIC@endDate". */
function routedGetByQuery(routes: Record<string, unknown>) {
  const map: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(routes)) map[k] = v;
  const get = routedGet({});
  get.mockImplementation(async (path: string, query: { endDate?: string }) => {
    const key = `${path.replace("/progression-service/v3/trends/", "")}@${query?.endDate}`;
    if (!(key in map)) throw new Error(`unexpected GET ${key}`);
    const v = map[key];
    if (v instanceof Error) throw v;
    return v;
  });
  return get;
}
