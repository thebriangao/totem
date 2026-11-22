import { describe, expect, it, vi } from "vitest";
import { registerWeeklyPlan } from "../../src/tools/v2/weekly_plan.js";
import { registerWeeklyPlanSet, sliderRange, targetError } from "../../src/tools/v2/weekly_plan_set.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { todayIso } from "../../src/lib/dates.js";
import { call, connect, fx, mockClient, routedGet, seq } from "./health_plans_helpers.js";

const V1 = "/progression-service/v1/weekly-plan";
const V2 = "/progression-service/v2/weekly-plan";
const PID = "d027813c-507a-48d3-b06e-3d71a8f098c0";
const tileRoute = () => `${V2}/home-tile/${todayIso()}`;
const setup = (extra: Record<string, unknown> = {}) => ({ plan_id: PID, screens: [], ...extra });

function routes(state: "none" | "active" | Array<"none" | "active">, setupBody: unknown = setup()) {
  const pick = (s: "none" | "active") => ({ v1: fx(`weekly_plan_v1_${s}.json`), tile: fx(`weekly_plan_tile_${s}.json`) });
  const states = Array.isArray(state) ? state : [state];
  return routedGet({
    [V1]: seq(...states.map((s) => pick(s).v1)),
    [tileRoute()]: seq(...states.map((s) => pick(s).tile)),
    [`${V2}/setup`]: setupBody,
  });
}

describe("whoop_weekly_plan", () => {
  it("reads v1 + the home tile for the week (no experimental flag)", async () => {
    const get = routedGet({ [V1]: fx("weekly_plan_v1_active.json"), [`${V2}/home-tile/2026-11-21`]: fx("weekly_plan_tile_active.json") });
    const client = await connect((s) => registerWeeklyPlan(s, mockClient({ get })));
    const { out } = await call(client, "whoop_weekly_plan", { date: "2026-11-21" });
    expect(get).toHaveBeenCalledWith(V1, { date: "2026-11-21" }, { fresh: false });
    expect(out).toMatchObject({ has_plan: true, plan: "Custom", pct: 14 });
    expect(out.experimental).toBeUndefined();
  });
});

describe("whoop_weekly_plan_set validation (D12)", () => {
  it("only STEPS and STRENGTH_TRAINING_TIME are accepted", async () => {
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routedGet({}) })));
    const res = await client.callTool({ name: "whoop_weekly_plan_set", arguments: { action: "set_goal", type: "SLEEP_PERFORMANCE", target: 80 } });
    expect(res.isError).toBe(true);
  });

  it.each([
    [{ action: "set_goal", type: "STEPS" }, /needs type and target/],
    [{ action: "remove_goal" }, /needs type/],
    [{ action: "end_plan", type: "STEPS" }, /takes no type/],
  ])("%j", async (args, re) => {
    const get = routedGet({});
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get })));
    const { isError, out } = await call(client, "whoop_weekly_plan_set", args);
    expect(isError).toBe(true);
    expect(out.error).toMatch(re);
    expect(get).not.toHaveBeenCalled();
  });

  it("targets must fit WHOOP's live slider (range + increment)", () => {
    const strength = sliderRange(fx("weekly_plan_setup_strength.json"), "STRENGTH_TRAINING_TIME");
    expect(strength).toEqual({ min: 10, max: 720, step: 15 });
    expect(targetError("STRENGTH_TRAINING_TIME", 120, strength)).toBeNull();
    expect(targetError("STRENGTH_TRAINING_TIME", 10, strength)).toBeNull();
    expect(targetError("STRENGTH_TRAINING_TIME", 125, strength)).toMatch(/steps of 15/);
    expect(targetError("STRENGTH_TRAINING_TIME", 735, strength)).toMatch(/10–720/);
    const steps = { min: 100, max: 10000, step: 100 };
    expect(targetError("STEPS", 8000, steps)).toBeNull();
    expect(targetError("STEPS", 8050, steps)).toMatch(/steps of 100/);
    expect(sliderRange({ screens: [] }, "STEPS")).toEqual({ min: 100, max: 50000, step: 100 });
  });

  it("refuses an off-slider target after reading setup, without writing", async () => {
    const put = vi.fn();
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routes("none", fx("weekly_plan_setup_strength.json")), put })));
    const { isError, out } = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STRENGTH_TRAINING_TIME", target: 125, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/steps of 15/);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("whoop_weekly_plan_set writes", () => {
  it("set_goal: plan_id from setup, PUT {type,target}; preview warns a Custom plan starts", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const get = routes(["none", "none", "active"]);
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get, put })));
    const preview = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STEPS", target: 10000 });
    expect(preview.out.will_execute).toEqual({ method: "PUT", path: `${V2}/${PID}/goal/target`, body_summary: { type: "STEPS", target: 10000 } });
    expect(preview.out.warnings.join(" ")).toMatch(/starts a Custom weekly plan/);
    expect(get).toHaveBeenCalledWith(`${V2}/setup`, { screens: "STEPS" }, { fresh: true });
    expect(put).not.toHaveBeenCalled();

    const { out } = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STEPS", target: 10000, confirm: true });
    expect(put).toHaveBeenCalledWith(`${V2}/${PID}/goal/target`, { type: "STEPS", target: 10000 });
    expect(out).toMatchObject({ action: "set_goal", verified: true, plan: { has_plan: true } });
  });

  it("set_goal is unverified when the read-back target differs", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routes(["active", "active"]), put })));
    const { out } = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STEPS", target: 9000, confirm: true });
    expect(out.verified).toBe(false);
  });

  it("a strength goal is verified against the target read back (live shapes: v1 has no target, the tile does)", async () => {
    const twoGoals = { [V1]: fx("weekly_plan_v1_two_goals.json"), [tileRoute()]: fx("weekly_plan_tile_two_goals.json"), [`${V2}/setup`]: fx("weekly_plan_setup_strength.json") };
    const put = vi.fn().mockResolvedValue(undefined);
    const setupPid = (fx("weekly_plan_setup_strength.json") as { plan_id: string }).plan_id;
    // The account's plan id differs from the setup fixture's, so align the v1 plan tile with it.
    const v1 = JSON.parse(JSON.stringify(twoGoals[V1]).replaceAll(PID, setupPid)) as unknown;
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routedGet({ ...twoGoals, [V1]: v1 }), put })));
    // The plan reads back with 2:00 (120 min): asking for 120 verifies, asking for 90 does not.
    const ok = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STRENGTH_TRAINING_TIME", target: 120, confirm: true });
    expect(ok.out).toMatchObject({ verified: true, plan: { goals: [{ type: "STEPS" }, { type: "STRENGTH_TRAINING_TIME", target: 120 }] } });
    const wrong = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STRENGTH_TRAINING_TIME", target: 90, confirm: true });
    expect(wrong.out.verified).toBe(false);
  });

  it("a target that can't be read back is not verified", async () => {
    // The home tile fails, so the strength goal comes back from v1 alone, without its target.
    const setupPid = (fx("weekly_plan_setup_strength.json") as { plan_id: string }).plan_id;
    const v1 = JSON.parse(JSON.stringify(fx("weekly_plan_v1_two_goals.json")).replaceAll(PID, setupPid)) as unknown;
    const get = routedGet({ [V1]: v1, [tileRoute()]: new WhoopApiError(500, tileRoute(), ""), [`${V2}/setup`]: fx("weekly_plan_setup_strength.json") });
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get, put: vi.fn().mockResolvedValue(undefined) })));
    const { out } = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STRENGTH_TRAINING_TIME", target: 120, confirm: true });
    expect(out.verified).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/target couldn't be read back/);
  });

  it("remove_goal DELETEs …/goal/target/{type}; refuses a goal that isn't in the plan", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routes(["active", "none"]), delete: del })));
    const { out } = await call(client, "whoop_weekly_plan_set", { action: "remove_goal", type: "STRENGTH_TRAINING_TIME", confirm: true });
    expect(del).toHaveBeenCalledWith(`${V2}/${PID}/goal/target/STRENGTH_TRAINING_TIME`);
    expect(out.verified).toBe(true);

    const none = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routes("none"), delete: vi.fn() })));
    expect((await call(none, "whoop_weekly_plan_set", { action: "remove_goal", type: "STEPS", confirm: true })).out.error).toMatch(/isn't in the current plan/);
  });

  it("end_plan removes every goal (never DELETE /weekly-plan/{id})", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routes(["active", "none"]), delete: del })));
    const { out } = await call(client, "whoop_weekly_plan_set", { action: "end_plan", confirm: true });
    expect(del.mock.calls.map((c) => c[0])).toEqual([`${V2}/${PID}/goal/target/STEPS`, `${V2}/${PID}/goal/target/STRENGTH_TRAINING_TIME`]);
    expect(del.mock.calls.every((c) => /\/goal\/target\//.test(c[0] as string))).toBe(true);
    expect(out).toMatchObject({ action: "end_plan", verified: true, plan: { has_plan: false } });
  });

  it("end_plan that fails part-way says which goal is already gone", async () => {
    const del = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new WhoopApiError(400, `${V2}/${PID}/goal/target/STRENGTH_TRAINING_TIME`, "nope"));
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routes("active"), delete: del })));
    const { isError, out } = await call(client, "whoop_weekly_plan_set", { action: "end_plan", confirm: true });
    expect(isError).toBe(true);
    expect(out.hint).toBe(`Already applied before this failed: DELETE ${V2}/${PID}/goal/target/STEPS.`);
  });

  it("end_plan refuses a plan with goals totem doesn't manage", async () => {
    const tile = fx("weekly_plan_tile_active.json") as { tile: { content: { items: Array<{ id: string }> } } };
    tile.tile.content.items[0]!.id = "SLEEP_PERFORMANCE";
    const get = routedGet({ [V1]: fx("weekly_plan_v1_active.json"), [tileRoute()]: tile, [`${V2}/setup`]: setup() });
    const del = vi.fn();
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get, delete: del })));
    const { isError, out } = await call(client, "whoop_weekly_plan_set", { action: "end_plan", confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/SLEEP_PERFORMANCE/);
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses when setup and the current plan disagree on the plan id", async () => {
    const put = vi.fn();
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routes("active", setup({ plan_id: "other-id" })), put })));
    const { isError, out } = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STEPS", target: 8000, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/two plan ids/);
  });

  it("maps a WHOOP rejection to a structured error", async () => {
    const put = vi.fn().mockRejectedValue(new WhoopApiError(422, `${V2}/${PID}/goal/target`, ""));
    const client = await connect((s) => registerWeeklyPlanSet(s, mockClient({ get: routes("none"), put })));
    const { isError, out } = await call(client, "whoop_weekly_plan_set", { action: "set_goal", type: "STEPS", target: 8000, confirm: true });
    expect(isError).toBe(true);
    expect(out.status).toBe(422);
  });
});
