import { describe, expect, it } from "vitest";
import { registerMilestones } from "../../src/tools/v2/milestones.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { call, connect, fx, mockClient, routedGet } from "./health_plans_helpers.js";

const BFF = "/milestones-service/v1/bff/milestones";
const STREAK = "/streaks-service/v1/bff/streaks/data-streak";

describe("whoop_milestones", () => {
  it("default: totals, streak, top and in-progress badges — under ~1.5 KB, no full list", async () => {
    const get = routedGet({ [`${BFF}/hub`]: fx("milestones_hub.json"), [STREAK]: fx("data_streak.json") });
    const client = await connect((s) => registerMilestones(s, mockClient({ get })));
    const { out, text } = await call(client, "whoop_milestones", {});
    expect(out.totals).toEqual({ total: 4, unique: 3, rare: 2 });
    expect(out.streak.days).toBe(1);
    expect(out.top[1]).toEqual({ type: "ACTIVITY_WEIGHTLIFTING_MSK", name: "Barbell Boss", count: 5, status: "top 7%" });
    expect(out.badges).toBeUndefined();
    expect(text.length).toBeLessThan(1500);
    expect(get).not.toHaveBeenCalledWith("/achievements-service/v1/progression", expect.anything());
  });

  it("include badges adds every badge as columnar rows", async () => {
    const get = routedGet({ [`${BFF}/hub`]: fx("milestones_hub.json"), [STREAK]: new Error("down") });
    const client = await connect((s) => registerMilestones(s, mockClient({ get })));
    const { out } = await call(client, "whoop_milestones", { include: ["badges"] });
    expect(out.streak).toBeUndefined();
    expect(out.badges.columns).toEqual(["type", "tag", "name", "count", "status"]);
    expect(out.badges.rows).toContainEqual(["HEALTHSPAN_STEPS", "healthspan", "Stepping It Up", 0, null]);
  });

  it("milestone_type returns one badge's detail; an unknown type is a tool error", async () => {
    const get = routedGet({
      [`${BFF}/HIGH_STRAIN/details`]: fx("milestone_details_progress.json"),
      [`${BFF}/NOPE/details`]: new WhoopApiError(400, `${BFF}/NOPE/details`, "Unsupported milestone type when building achievement details page."),
    });
    const client = await connect((s) => registerMilestones(s, mockClient({ get })));
    expect((await call(client, "whoop_milestones", { milestone_type: "HIGH_STRAIN" })).out).toMatchObject({ type: "HIGH_STRAIN", next: { more: 4 } });
    const bad = await call(client, "whoop_milestones", { milestone_type: "NOPE" });
    expect(bad.isError).toBe(true);
    expect(bad.out.error).toMatch(/doesn't know milestone type NOPE/);
  });

  it("milestone_type must be an uppercase id (no path injection)", async () => {
    const client = await connect((s) => registerMilestones(s, mockClient({ get: routedGet({}) })));
    const res = await client.callTool({ name: "whoop_milestones", arguments: { milestone_type: "../hub" } });
    expect(res.isError).toBe(true);
  });
});
