import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { registerJournal } from "../../src/tools/v2/journal.js";
import { parseDraft } from "../../src/lib/journal_behaviors.js";
import { projectBehaviorImpacts, projectJournalDay } from "../../src/projections/journal_v2.js";
import { connect, fixture, mockWhoop, parse, toolBudget } from "./journal_profile_helpers.js";

const DATE = "2026-11-21";
const DRAFT = `/journal-service/v3/journals/drafts/mobile/${DATE}`;
const USER_LIST = `/journal-service/v2/journals/behaviors/user/${DATE}`;
const draft = () => fixture("journal_draft_2026-11-21.json");
const v1Fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

// The live per-user list: stock trackers incl. 171, plus one custom behaviour.
const liveList = [
  { id: 2, title: "Caffeine", internal_name: "caffeine", question_text: "Consumed caffeine?", time_label: "When was your last serving?",
    magnitude: { type: "range", units: "Servings", interval: 1, minimum_inclusive: 1, maximum_inclusive: 10, choices: [] } },
  { id: 177, title: "Headache", internal_name: "headache", question_text: "Had a headache?", time_label: null,
    magnitude: { type: "step", units: null, choices: [{ value: 0, label: "Slight" }, { value: 1, label: "Moderate" }, { value: 2, label: "Intense" }] } },
  { id: 171, title: "Momentous Sleep Pack", internal_name: "momentous-sleep-pack", question_text: "Took Momentous Sleep Pack?", time_label: null, magnitude: null },
  { id: 163752, title: "Probe Hip Mobility", internal_name: "custom-163752", question_text: "Did you do hip mobility work today?", time_label: null, magnitude: null },
];

describe("whoop_journal projection", () => {
  const day = projectJournalDay(parseDraft(draft(), DATE), { includeUnanswered: true });

  it("keeps answered rows only, with value, unit, source and custom flags", () => {
    expect(day.answered.map((r) => r.id).sort((a, b) => a - b)).toEqual([2, 6, 8, 43, 79, 177, 163752]);
    expect(day.answered.find((r) => r.id === 2)).toMatchObject({ name: "Caffeine", yes: true, value: 2, unit: "Servings", src: "AI", label: null });
    // Range magnitudes carry no label (it would only repeat the number).
    expect(day.answered.find((r) => r.id === 8)).toMatchObject({ value: 60, unit: "Minutes", label: null, src: null });
    expect(day.answered.find((r) => r.id === 6)).toMatchObject({ yes: false, value: null });
    expect(day.answered.find((r) => r.id === 163752)).toMatchObject({ name: "Probe Hip Mobility", custom: true });
    expect(day.notes).toBe("synthetic note");
  });

  it("lists unanswered as [id, name] pairs", () => {
    expect(day.unanswered).toEqual(expect.arrayContaining([[1, "Alcohol"], [52, "Sauna"], [171, "Momentous Sleep Pack"]]));
    expect(day.unanswered).toHaveLength(3);
  });

  it("walks the new-account impact screen and marks member-average cards", () => {
    const out = projectBehaviorImpacts(fixture("behavior_impact_new_account.json"));
    expect(out.personal).toBe(0);
    expect(out.rows.map((r) => [r.name, r.pct, r.dir, r.rec, r.id])).toEqual([
      ["Caffeine", 4, "positive", true, null],
      ["Read In Bed", 3, "positive", true, null],
      ["Late Meal", -2, "neutral", true, null],
      ["Alcohol", -12, "negative", true, null],
    ]);
  });

  it("reads personal impacts from the established-account shape", () => {
    const out = projectBehaviorImpacts(v1Fixture("behavior_impact_list.json"));
    expect(out.personal).toBe(5);
    expect(out.rows[0]).toMatchObject({ id: "aa0a7709-8ac2-4f92-b17c-e9eb594d2a46", name: "Daylight Eating", pct: 7, dir: "positive", rec: null });
    expect(out.rows.find((r) => r.name === "Early Workout")).toMatchObject({ dir: "insufficient", pct: null });
  });
});

describe("whoop_journal tool", () => {
  it("defaults to a small answered-rows payload", async () => {
    const whoop = mockWhoop({ [DRAFT]: draft() });
    const client = await connect(registerJournal, whoop);
    const result = await client.callTool({ name: "whoop_journal", arguments: { date: DATE } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    const out = parse(result);
    expect(result.isError).toBeFalsy();
    expect(out.answered).toHaveLength(7);
    expect(out).not.toHaveProperty("catalog");
    expect(out).not.toHaveProperty("unanswered");
    expect(text.length).toBeLessThan(1500);
    expect(whoop.get).toHaveBeenCalledTimes(1);
  });

  it("filters the live catalog by search (171 included) and category (custom)", async () => {
    const whoop = mockWhoop({ [DRAFT]: draft(), [USER_LIST]: liveList });
    const client = await connect(registerJournal, whoop);
    const bySearch = parse(await client.callTool({ name: "whoop_journal", arguments: { date: DATE, search: "sleep pack" } }));
    expect(bySearch.catalog.rows).toEqual([expect.objectContaining({ id: 171, name: "Momentous Sleep Pack", type: "yn" })]);
    expect(bySearch.catalog.rows[0]).not.toHaveProperty("min");
    const custom = parse(await client.callTool({ name: "whoop_journal", arguments: { date: DATE, category: "custom" } }));
    expect(custom.catalog.rows).toEqual([expect.objectContaining({ id: 163752, custom: true })]);
  });

  it("adds magnitude specs only with include magnitudes, and flags untracked stock behaviours", async () => {
    const whoop = mockWhoop({ [DRAFT]: draft(), [USER_LIST]: liveList });
    const client = await connect(registerJournal, whoop);
    const out = parse(await client.callTool({ name: "whoop_journal", arguments: { date: DATE, search: "caffeine", include: ["magnitudes"] } }));
    expect(out.catalog.rows[0]).toMatchObject({ id: 2, type: "range", unit: "Servings", min: 1, max: 10, time: true, time_q: "When was your last serving?" });
    const step = parse(await client.callTool({ name: "whoop_journal", arguments: { date: DATE, search: "headache", include: ["magnitudes"] } }));
    expect(step.catalog.rows[0]).toMatchObject({ type: "step", choices: "0=Slight, 1=Moderate, 2=Intense" });
    const alcohol = parse(await client.callTool({ name: "whoop_journal", arguments: { date: DATE, search: "alcohol" } }));
    expect(alcohol.catalog.rows[0]).toMatchObject({ id: 1, tracked: false });
  });

  it("never returns the whole catalog unfiltered: category counts and a short page", async () => {
    const whoop = mockWhoop({ [DRAFT]: draft(), [USER_LIST]: liveList });
    const client = await connect(registerJournal, whoop);
    const out = parse(await client.callTool({ name: "whoop_journal", arguments: { date: DATE, include: ["catalog"] } }));
    expect(out.catalog.total).toBe(310);
    expect(out.catalog.rows.length).toBeLessThanOrEqual(30);
    expect(out.catalog.truncated).toBe(true);
    expect(out.catalog.categories).toMatchObject({ Supplements: expect.any(Number), Custom: 1 });
  });

  it("falls back to the bundled catalog when WHOOP's lists can't be read", async () => {
    const whoop = mockWhoop({
      [DRAFT]: draft(),
      [USER_LIST]: new Error("boom"),
      "/activities-service/v1/journals/behaviors/user": new Error("boom"),
    });
    const client = await connect(registerJournal, whoop);
    const out = parse(await client.callTool({ name: "whoop_journal", arguments: { date: DATE, search: "sleep pack" } }));
    expect(out.catalog.source).toBe("bundled");
    expect(out.catalog.rows[0]).toMatchObject({ id: 171 });
    expect(out.warnings.join(" ")).toMatch(/custom behaviours can't be resolved/);
  });

  it("returns impact rows and refuses detail for a member-average card", async () => {
    const whoop = mockWhoop({ [DRAFT]: draft(), "/behavior-impact-service/v1/impact": fixture("behavior_impact_new_account.json") });
    const client = await connect(registerJournal, whoop);
    const out = parse(await client.callTool({
      name: "whoop_journal",
      arguments: { date: DATE, impact_id: "599fdf12-9565-4fca-9b3a-bb5c46d3dc78" },
    }));
    expect(out.impact.rows).toHaveLength(4);
    expect(out.impact).not.toHaveProperty("detail");
    expect(out.warnings.join(" ")).toMatch(/member-average/);
    expect(whoop.get).not.toHaveBeenCalledWith(expect.stringContaining("/impact/details/"));
  });

  it("fetches detail for a personal impact", async () => {
    const id = "aa0a7709-8ac2-4f92-b17c-e9eb594d2a46";
    const whoop = mockWhoop({
      [DRAFT]: draft(),
      "/behavior-impact-service/v1/impact": v1Fixture("behavior_impact_list.json"),
      [`/behavior-impact-service/v2/impact/details/${id}`]: v1Fixture("behavior_impact_details.json"),
    });
    const client = await connect(registerJournal, whoop);
    const out = parse(await client.callTool({ name: "whoop_journal", arguments: { date: DATE, impact_id: id } }));
    expect(out.impact.detail).toMatchObject({ behavior_name: "Daylight Eating" });
    expect(out.impact.detail.metrics[0]).toMatchObject({ metric: "RECOVERY IMPACT", delta_avg: 7 });
  });

  it("stays inside the description budgets", async () => {
    const client = await connect(registerJournal, mockWhoop({}));
    for (const t of await toolBudget(client)) {
      expect(t.description).toBeLessThanOrEqual(600);
      expect(t.longestDescribe).toBeLessThanOrEqual(80);
    }
  });
});
