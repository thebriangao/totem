import { describe, expect, it } from "vitest";
import {
  displayDate,
  nearestBadges,
  projectDataStreak,
  projectMilestoneDetail,
  projectMilestonesHub,
  topBadges,
} from "../../src/projections/milestones.js";
import { MilestoneDetailOut, Streak } from "../../src/schemas/milestones.js";
import { fx } from "../tools/health_plans_helpers.js";

describe("projectMilestonesHub", () => {
  const hub = projectMilestonesHub(fx("milestones_hub.json"));

  it("reads the Total / Unique / Rare header pairs", () => {
    expect(hub.totals).toEqual({ total: 4, unique: 3, rare: 2 });
  });

  it("lists badges once each by tag (skipping the duplicate 'all' map), incl. healthspan", () => {
    const types = hub.badges.map((b) => b.type);
    expect(new Set(types).size).toBe(types.length);
    expect(hub.badges.filter((b) => b.tag === "healthspan")).toHaveLength(9);
    expect(hub.badges.some((b) => b.tag === "all")).toBe(false);
    expect(hub.badges.find((b) => b.type === "ACTIVITY_WEIGHTLIFTING_MSK")).toEqual({ type: "ACTIVITY_WEIGHTLIFTING_MSK", tag: "activities", name: "Barbell Boss", count: 5, status: "top 7%" });
    expect(hub.badges.find((b) => b.type === "ACTIVITY_WALKING")).toMatchObject({ count: 0, status: "3/5" });
  });

  it("top earned badges and the closest unearned ones", () => {
    expect(topBadges(hub.badges).map((b) => b.type)).toEqual(["JACK_OF_ALL_TRADES", "ACTIVITY_WEIGHTLIFTING_MSK", "TWENTY_PLUS_STRAIN_DAY"]);
    expect(nearestBadges(hub.badges).map((b) => b.status)).toEqual(["3/5", "2/5", "1/5"]);
  });

  it("degrades to empty", () => {
    expect(projectMilestonesHub({})).toEqual({ totals: { total: null, unique: null, rare: null }, badges: [] });
  });
});

describe("projectDataStreak", () => {
  it("streak value, start, max, next milestone and this week", () => {
    const s = projectDataStreak(fx("data_streak.json"));
    expect(() => Streak.parse(s)).not.toThrow();
    expect(s).toEqual({ days: 1, state: "ACTIVE", started: "2026-11-21", max: 1, next_milestone_in_days: 4, this_week: { worn: ["SAT"], missed: ["MON", "TUE", "WED", "THU", "FRI"] } });
  });
});

describe("projectMilestoneDetail", () => {
  it("an earned badge: count, progress to next, levels with dates", () => {
    const d = projectMilestoneDetail(fx("milestone_details_earned.json"), "ACTIVITY_WEIGHTLIFTING_MSK");
    expect(() => MilestoneDetailOut.parse(d)).not.toThrow();
    expect(d).toEqual({ type: "ACTIVITY_WEIGHTLIFTING_MSK", name: "Barbell Boss", about: "Total Strength Trainer activities logged", count: 5, next: { more: 5, pct: 0 }, earned: [[5, "2026-11-21"]] });
  });
  it("an unearned badge", () => {
    expect(projectMilestoneDetail(fx("milestone_details_progress.json"), "HIGH_STRAIN")).toMatchObject({ name: "Strain Seeker", count: 0, next: { more: 4, pct: 20 }, earned: [] });
  });
  it("display dates", () => {
    expect(displayDate("Nov 21, 2026")).toBe("2026-11-21");
    expect(displayDate("Sept 3, 2026")).toBe("2026-09-03");
    expect(displayDate("Top 7%")).toBeNull();
  });
});
