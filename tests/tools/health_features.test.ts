// whoop_health (EXPERIMENTAL). No test account has these features, so the
// locked, empty and not-set-up shapes below are synthetic copies of what WHOOP
// answered on 2026-11-22, and the filled-in ones are invented to exercise the
// guarded paths: what the tool does with a shape it hasn't seen.
import { describe, expect, it } from "vitest";
import { registerHealth } from "../../src/tools/v2/health.js";
import { nextToken, passThrough, projectLabs, projectLabTests, projectLockable } from "../../src/projections/health_features.js";
import { screenContent } from "../../src/lib/screen_content.js";
import { WhoopApiError, WhoopAuthExpiredError } from "../../src/whoop/errors.js";
import { todayIso } from "../../src/lib/dates.js";
import { connect, mockWhoop, parse } from "./journal_profile_helpers.js";

const LOCK = (header: string, description: string) => ({
  locked_icon: "https://app-cdn.prod.whoop.com/tortoise/locked.png",
  header_text_display: header, description_display: description,
  button_style: "DEFAULT", button_text_display: "GOT IT", button_destination: null,
});
const HEALTHSPAN_LOCKED = {
  metadata: null, navigation_title: "HEALTHSPAN", navigation_subtitle: null,
  navigation_destination: { screen: "HEALTHSPAN", parameters: {} },
  unlocked_content: null,
  locked_content: LOCK("21 SLEEPS TO UNLOCK", "Log 21 sleeps in the last month. Keep wearing your WHOOP 24/7 to get insights."),
};
const SAGE_LOCKED = {
  navigation_title: "BLOOD PRESSURE INSIGHTS", navigation_tag: null, navigation_tag_dialog_content: null,
  unlocked_content: null,
  locked_content: LOCK("UPGRADE FOR ACCESS", "Unlock Blood Pressure Insights by upgrading to WHOOP Life."),
};
const biomarker = (id: string, title: string, value: string, unit: string | null, status: string) => ({
  id, title, icon: "CARET_RIGHT", value, unit, trend: null, status_type: status, disclaimer: null,
  destination: { screen: "BIOMARKER_DETAILS", parameters: { source: "biomarker_summary", biomarker_id: id } }, range_meter: null,
});
const labs = (rows: unknown[]) => ({
  metadata: { ai_context_metadata: {} },
  items: [
    { type: "BIOMARKER_PIE_CHART_SECTION", content: { id: "pie", trend_counts: [] } },
    { type: "SEARCHABLE_BIOMARKERS_LIST", content: { biomarkers: rows, statuses: [] } },
  ],
});
const LABS_EMPTY = labs([biomarker("ldl", "LDL Cholesterol", "--", null, "UNAVAILABLE"), biomarker("hba1c", "HbA1c", "--", null, "UNAVAILABLE")]);
const LABS_FULL = labs([
  biomarker("ldl", "LDL Cholesterol", "92", "mg/dL", "OPTIMAL"),
  biomarker("hba1c", "HbA1c", "--", null, "UNAVAILABLE"),
  biomarker("vitd", "Vitamin D", "24", "ng/mL", "OUT_OF_RANGE"),
]);
const HISTORY = (items: unknown[]) => ({ title: "Lab History", paginated_records: { sections: [{ id: "s", items }], next_token: null } });
const EMPTY_TILE = { type: "EMPTY_TILE", content: { id: "have_other_tests_tile", title: "Have other labs?", image_url: "https://x/e.png" } };
const notFound = (path: string, body: string) => new WhoopApiError(404, path, body, "404");

async function health(routes: Record<string, unknown>, args: Record<string, unknown>) {
  const whoop = mockWhoop(routes);
  const out = parse(await (await connect(registerHealth, whoop)).callTool({ name: "whoop_health", arguments: args }));
  // The mock is typed with the path alone; the query rides along as a second argument.
  const calls = whoop.get.mock.calls.map((c) => {
    const [path, query] = c as unknown as [string, Record<string, unknown> | undefined];
    return [path, query ?? {}] as [string, Record<string, unknown>];
  });
  return { out, calls };
}

describe("whoop_health", () => {
  it("says experimental on every answer and reports a locked Healthspan exactly, for today by default", async () => {
    const { out, calls } = await health({ "/healthspan-service/v1/healthspan/bff": HEALTHSPAN_LOCKED }, { feature: "healthspan" });
    expect(out).toEqual({
      feature: "healthspan", experimental: true, date: todayIso(), status: "locked",
      message: "21 SLEEPS TO UNLOCK: Log 21 sleeps in the last month. Keep wearing your WHOOP 24/7 to get insights.",
    }); // (an empty warnings list is dropped from the wire)
    expect(calls).toEqual([["/healthspan-service/v1/healthspan/bff", { date: todayIso() }]]);
  });

  it("reads blood pressure for the date asked", async () => {
    const { out, calls } = await health({ "/sage-service/v1/sage/bff": SAGE_LOCKED }, { feature: "blood_pressure", date: "2026-11-20" });
    expect(out).toMatchObject({ feature: "blood_pressure", experimental: true, date: "2026-11-20", status: "locked", message: expect.stringContaining("WHOOP Life") });
    expect(calls).toEqual([["/sage-service/v1/sage/bff", { date: "2026-11-20" }]]);
  });

  it("passes an unrecognised unlocked screen through without UI plumbing", async () => {
    const { out } = await health({
      "/healthspan-service/v1/healthspan/bff": {
        unlocked_content: { header: { title_display: "WHOOP AGE", value_display: "31.2", icon_url: "https://x/i.png", text_color: "#fff" }, pace: { label: "Pace of aging", value: 0.8, destination: { screen: "X" } } },
        locked_content: null,
      },
    }, { feature: "healthspan" });
    expect(out).toMatchObject({ status: "available", content: { header: { title_display: "WHOOP AGE", value_display: "31.2" }, pace: { label: "Pace of aging", value: 0.8 } } });
  });

  // Shaped like the unlocked screen seen on a real account (2026-11-22); every number here is invented.
  const amoeba = (age: string, diff: string, older: boolean, pace: string) => ({
    style_values: {}, age_value_display: age, age_title_display: "WHOOP AGE", age_subtitle_display: `${diff} years ${older ? "older" : "younger"}`,
    age_subtitle_style: older ? "OLDER" : "YOUNGER", years_difference_value_display: diff, years_difference_value_style: older ? "OLDER" : "YOUNGER",
    years_difference_subtitle_display: older ? "YEARS OLDER" : "YEARS YOUNGER", pace_of_aging_display: pace, pace_of_aging_subtitle_display: "PACE OF AGING", is_calibrating: false,
  });
  const contributor = (t: string, top: string, bottom: string, unit: string, impact: string, style: string) => ({
    title_display: t, is_enabled: true, is_open: false,
    content: {
      range_divisions: [{ style: "OLDER_1" }], top_range_value: { value_display: top, value_unit_display: unit, value_range_percentage: 0.5, style: "ENABLED", expanded_value_label_display: "6 Month avg." },
      impact_value_display: impact, impact_value_label_display: "years", impact_value_style: style,
      expanded_bottom_range_value: { value_display: bottom, value_unit_display: unit, value_range_percentage: 0.5, style: "ENABLED", expanded_value_label_display: "30 Day avg." },
      expanded_items: [{ type: "HEALTHSPAN_VOW", content: { title_display: "Keep it up", subtitle_display: "…", destination: { screen: "TRENDS" } } }],
    },
  });
  const section = (titleText: string, items: unknown[]) => ({ type: "TILE_SECTION", content: { title_display: titleText, primary_description_display: "6 Month avg.", secondary_description_display: "30 Day avg.", items: [{ type: "CONTRIBUTORS_CONTAINER", content: { contributors: items } }] } });
  const HEALTHSPAN_UNLOCKED = {
    navigation_title: "HEALTHSPAN", locked_content: null,
    unlocked_content: {
      date_picker: { current_date_range_display: "Jan 5 - Jan 11", previous_date_time: "2026-01-04" }, is_calibrating: false,
      whoop_age_amoeba: amoeba("41.2", "2.3", false, "0.8x"), previous_whoop_age_amoeba: amoeba("41.6", "1.9", false, "1.2x"),
      items: [
        { type: "PACE_OF_AGING_METER", content: { title_display: "PACE OF AGING", ticks: [{ top_value_display: "-1.0x", is_current_value: false }] } },
        section("Sleep", [contributor("SLEEP CONSISTENCY", "81%", "84%", "", "-0.6", "YOUNGER"), contributor("HOURS OF SLEEP", "7:10", "7:25", "h", "+0.2", "OLDER")]),
        section("Strain", [contributor("TIME IN HR ZONES 1-3 (WEEKLY)", "2:40", "3:05", "h", "-0.4", "YOUNGER"), contributor("STEPS", "8,120", "9,004", "Steps", "+0.1", "OLDER")]),
        section("Fitness", [contributor("VO₂ MAX", "44", "45", "ml/kg/min", "-1.0", "YOUNGER"), contributor("RHR", "51", "50", "bpm", "-0.3", "YOUNGER"), contributor("LEAN BODY MASS", "--", "--", "xx", "", "OLDER")]),
      ],
      featured_highlights: [], has_been_seen_by_user: true, has_onboarded: true, amoeba_onboarding_steps: [],
    },
  };

  it("projects an unlocked Healthspan: WHOOP Age, signed years, pace, previous period and contributors", async () => {
    const { out } = await health({ "/healthspan-service/v1/healthspan/bff": HEALTHSPAN_UNLOCKED }, { feature: "healthspan", date: "2026-01-08" });
    expect(out).toMatchObject({ feature: "healthspan", experimental: false, status: "available", date: "2026-01-08" });
    expect(out.healthspan).toEqual({
      period: "Jan 5 - Jan 11", calibrating: false, whoop_age: 41.2, years_vs_actual_age: -2.3, pace_of_aging: 0.8,
      previous: { whoop_age: 41.6, years_vs_actual_age: -1.9, pace_of_aging: 1.2 },
      contributor_cols: ["area", "name", "long_avg", "recent_avg", "impact_years"],
      contributors: [
        ["Sleep", "Sleep consistency", "81%", "84%", -0.6],
        ["Sleep", "Hours of sleep", "7:10 h", "7:25 h", 0.2],
        ["Strain", "Time in HR zones 1-3 (weekly)", "2:40 h", "3:05 h", -0.4],
        ["Strain", "Steps", "8,120 Steps", "9,004 Steps", 0.1],
        ["Fitness", "VO₂ max", "44 ml/kg/min", "45 ml/kg/min", -1.0],
        ["Fitness", "RHR", "51 bpm", "50 bpm", -0.3],
        ["Fitness", "Lean body mass", null, null, null],
      ],
    });
    expect(JSON.stringify(out)).not.toMatch(/destination|style|TRENDS/);
  });

  it("reads years older as positive, and keeps the sign WHOOP writes", async () => {
    const older = structuredClone(HEALTHSPAN_UNLOCKED);
    older.unlocked_content.whoop_age_amoeba = amoeba("47.0", "3.4", true, "1.3x");
    const { out } = await health({ "/healthspan-service/v1/healthspan/bff": older }, { feature: "healthspan" });
    expect(out.healthspan).toMatchObject({ whoop_age: 47, years_vs_actual_age: 3.4, pace_of_aging: 1.3 });
  });

  it("afib: not set up on a 404; a day by date; the next page by cursor", async () => {
    const screen = "/arrhythmia-service/v2/afibhistory/screen";
    const notSet = await health({ [screen]: notFound(screen, "No anf user found for userId 7") }, { feature: "afib" });
    expect(notSet.out).toMatchObject({ feature: "afib", experimental: true, status: "not_set_up" });

    const day = await health({ "/arrhythmia-service/v1/history/bff": { title: "Nov 20", events: [{ label: "Irregular rhythm", time_display: "3:12 AM" }] } }, { feature: "afib", date: "2026-11-20" });
    expect(day.calls).toEqual([["/arrhythmia-service/v1/history/bff", { historyDate: "2026-11-20" }]]);
    expect(day.out).toMatchObject({ status: "available", date: "2026-11-20", content: { events: [{ label: "Irregular rhythm" }] } });

    const first = await health({ [screen]: { sections: [{ title: "November" }], pagination: { next_token: "tok-2" } } }, { feature: "afib" });
    expect(first.out).toMatchObject({ status: "available", next_cursor: "tok-2" });
    const next = await health({ "/arrhythmia-service/v2/afibhistory/paginated": { sections: [] } }, { feature: "afib", cursor: "tok-2" });
    expect(next.calls).toEqual([["/arrhythmia-service/v2/afibhistory/paginated", { next_token: "tok-2" }]]);
  });

  it("labs: no results is no_data; results list the biomarkers that have one, with the tests", async () => {
    const SUM = "/advanced-labs-service/v1/advanced-labs/biomarkers/summary";
    const HIST = "/advanced-labs-service/v1/advanced-labs/tests/history";
    const none = await health({ [SUM]: LABS_EMPTY, [HIST]: HISTORY([EMPTY_TILE]) }, { feature: "labs" });
    expect(none.out).toMatchObject({ feature: "labs", experimental: true, status: "no_data", message: expect.stringContaining("No lab results") });
    expect(none.out).not.toHaveProperty("tests");

    const full = await health({ [SUM]: LABS_FULL, [HIST]: HISTORY([EMPTY_TILE, { type: "TEST_TILE", content: { id: "t-1", title: "Baseline panel", date_display: "Oct 2", image_url: "https://x" } }]) }, { feature: "labs" });
    expect(full.out).toMatchObject({
      status: "available",
      biomarkers: [
        { id: "ldl", name: "LDL Cholesterol", value: "92", unit: "mg/dL", status: "OPTIMAL" },
        { id: "vitd", name: "Vitamin D", value: "24", unit: "ng/mL", status: "OUT_OF_RANGE" },
      ],
      tests: [{ type: "TEST_TILE", content: { id: "t-1", title: "Baseline panel", date_display: "Oct 2" } }],
    });

    const noHistory = await health({ [SUM]: LABS_FULL, [HIST]: new Error("down") }, { feature: "labs" });
    expect(noHistory.out).toMatchObject({ status: "available", warnings: ["Lab history unavailable: down"] });
  });

  it("labs with an id: a biomarker's history, else a test's results and insights, else no_data", async () => {
    const B = "/advanced-labs-service/v1/advanced-labs/biomarkers/";
    const bio = await health({ [`${B}ldl`]: { title: "LDL Cholesterol", recordings: [{ value: "92", date_display: "Oct 2" }], next_token: "p2" } }, { feature: "labs", id: "ldl", cursor: "p1" });
    expect(bio.calls).toEqual([[`${B}ldl`, { next_token: "p1" }]]);
    expect(bio.out).toMatchObject({ status: "available", id: "ldl", content: { recordings: [{ value: "92" }] }, next_cursor: "p2" });

    // Shaped like the live answer (2026-11-22) for a biomarker without results.
    const EMPTY_BIOMARKER = {
      navigation_title: "BIOMARKER DETAILS",
      header: { title: "LDL Cholesterol", subtitle: "Cholesterol carried by LDL particles.", pills: ["Heart Health"] },
      sections: [
        { id: "empty_tile", items: [{ type: "EMPTY_TILE", content: { id: "biomarker_empty_data", title: "Add Lab Results", primary_button: { title: "SELECT TESTING FREQUENCY" } } }] },
        { id: "learn_more_carousel", items: [{ type: "EXPANDABLE_LIST", content: { title: "Learn more", items: [] } }] },
      ],
      analytics: { value: "UNAVAILABLE", label: "ldl_cholesterol" },
      status: "UNAVAILABLE",
    };
    const empty = await health({ [`${B}ldl_cholesterol`]: EMPTY_BIOMARKER }, { feature: "labs", id: "ldl_cholesterol" });
    expect(empty.out).toMatchObject({
      status: "no_data", id: "ldl_cholesterol", message: "No results for LDL Cholesterol yet.",
      content: { name: "LDL Cholesterol", about: "Cholesterol carried by LDL particles.", tags: ["Heart Health"] },
    });
    // Without the status field, the empty tile plus the education list still reads as empty.
    const { status: _s, ...noStatus } = EMPTY_BIOMARKER;
    expect((await health({ [`${B}ldl_cholesterol`]: noStatus }, { feature: "labs", id: "ldl_cholesterol" })).out).toMatchObject({ status: "no_data" });

    const test = await health({
      [`${B}t-1`]: notFound(`${B}t-1`, "no biomarker"),
      "/advanced-labs-service/v1/advanced-labs/tests/t-1": { title: "Baseline panel" },
      "/advanced-labs-service/v1/advanced-labs/insights": { insights: [{ title: "Raise vitamin D" }] },
    }, { feature: "labs", id: "t-1" });
    expect(test.out).toMatchObject({ status: "available", id: "t-1", content: { test: { title: "Baseline panel" }, insights: { insights: [{ title: "Raise vitamin D" }] } } });
    expect(test.calls).toContainEqual(["/advanced-labs-service/v1/advanced-labs/insights", { testId: "t-1" }]);

    const missing = await health({
      [`${B}zzz`]: notFound(`${B}zzz`, "no"),
      "/advanced-labs-service/v1/advanced-labs/tests/zzz": notFound("/t", "no"),
      "/advanced-labs-service/v1/advanced-labs/insights": notFound("/i", "no"),
    }, { feature: "labs", id: "zzz" });
    expect(missing.out).toMatchObject({ status: "no_data", message: expect.stringContaining("No biomarker or lab test zzz") });
  });

  it("never hides an expired login behind a feature status", async () => {
    const whoop = mockWhoop({ "/healthspan-service/v1/healthspan/bff": new WhoopAuthExpiredError("expired") });
    const res = await (await connect(registerHealth, whoop)).callTool({ name: "whoop_health", arguments: { feature: "healthspan" } });
    expect(res.isError).toBe(true);
  });
});

describe("health feature projections", () => {
  it("say when WHOOP sends neither content nor a lock", () => {
    expect(projectLockable({ unlocked_content: null, locked_content: null }).status).toBe("unavailable");
    expect(projectLabs({ items: [] }).status).toBe("unavailable");
    expect(projectLabTests(HISTORY([EMPTY_TILE]))).toBeNull();
  });

  it("find WHOOP's page token wherever it sits", () => {
    expect(nextToken({ a: { b: [{ nextToken: "x" }] } })).toBe("x");
    expect(nextToken({ next_token: null, list: [] })).toBeNull();
    expect(passThrough({ rows: [1], paging: { next_token: "n" } })).toMatchObject({ status: "available", next_cursor: "n" });
  });
});

describe("screenContent", () => {
  it("caps big screens by cutting lists, and says so", () => {
    const big = { rows: Array.from({ length: 200 }, (_, i) => ({ label: `Row ${i}`, value: i, image_url: "https://x" })) };
    const { content, truncated } = screenContent(big, 500);
    expect(truncated).toBe(true);
    expect(JSON.stringify(content).length).toBeLessThanOrEqual(500);
    expect((content as { rows: unknown[] }).rows[0]).toEqual({ label: "Row 0", value: 0 });
  });

  it("shortens long strings and drops empty branches", () => {
    const { content, truncated } = screenContent({ a: "x".repeat(400), b: { icon: "i", style: "s" }, c: [null, ""], d: 0 });
    expect(truncated).toBe(false);
    expect(content).toEqual({ a: `${"x".repeat(300)}…`, d: 0 });
  });
});
