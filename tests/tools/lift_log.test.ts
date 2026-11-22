import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPERIAL, METRIC, body, connect, fixture, routes } from "./lift_v2_harness.js";
import { registerLiftLog, LIFT_PATH, LINK_PATH } from "../../src/tools/v2/lift_log.js";
import { WhoopConflictError } from "../../src/whoop/errors.js";
import { parsePgRange } from "../../src/lib/dates.js";

const BENCH = "BENCHPRESS_BARBELL";
const HISTORY = `/weightlifting-service/v3/exercise/${BENCH}/exercise_history`;
const catalogRow = (id: string) => (fixture("catalog") as { exercises: Array<{ exercise_id: string }> }).exercises.find((e) => e.exercise_id === id);

const BASE_ARGS = {
  start: "2026-11-21T09:00:00.000-08:00",
  end: "2026-11-21T09:20:00.000-08:00",
  exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 45.36 }, { reps: 5, weight: 45.36 }, { reps: 5, weight: 45.36, performed: false }] }],
};

let tz: string | undefined;
beforeEach(() => {
  tz = process.env.WHOOP_TIMEZONE;
  process.env.WHOOP_TIMEZONE = "America/Los_Angeles";
});
afterEach(() => {
  if (tz === undefined) delete process.env.WHOOP_TIMEZONE;
  else process.env.WHOOP_TIMEZONE = tz;
});

function whoop(overrides: Record<string, unknown> = {}) {
  return routes({
    "/weightlifting-service/v2/exercise": fixture("catalog"),
    "/users-service/v2/bootstrap": IMPERIAL,
    [HISTORY]: fixture("history_bench"),
    ...overrides,
  });
}

describe("whoop_lift_log", () => {
  it("previews without writing, with weights converted to the display unit", async () => {
    const get = whoop();
    const post = vi.fn();
    const client = await connect(registerLiftLog, { get, post });
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: BASE_ARGS }));
    expect(post).not.toHaveBeenCalled();
    expect(out.preview).toBe(true);
    expect(out.will_execute).toMatchObject({ method: "POST", path: LIFT_PATH });
    expect(out.will_execute.body_summary).toMatchObject({
      during: "['2026-11-21T17:00:00.000Z','2026-11-21T17:20:00.000Z')",
      unit: "lb",
      converted_from: "kg",
      exercises: [{ id: BENCH, sets: "2x5", weights: [100, 100], skipped: 1 }],
    });
    // the unit is read fresh, never from cache
    expect(get).toHaveBeenCalledWith("/users-service/v2/bootstrap", {}, { fresh: true });
  });

  it("sends the catalog row verbatim, spreads performed sets over the window, omits during for skipped sets", async () => {
    const get = whoop();
    const post = vi.fn().mockResolvedValue(fixture("lift_receipt"));
    const client = await connect(registerLiftLog, { get, post });
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, rpe: 7, confirm: true } }));

    expect(post).toHaveBeenCalledTimes(1);
    const [path, sent] = post.mock.calls[0]!;
    expect(path).toBe(LIFT_PATH);
    expect(sent).toMatchObject({
      name: "2026-11-21",
      during: "['2026-11-21T17:00:00.000Z','2026-11-21T17:20:00.000Z')",
      timezone: "America/Los_Angeles",
      scaled_msk_strain_score: 0, msk_total_volume_kg: 0, msk_intensity_percent: 0, raw_msk_strain_score: 0,
      workout_template_id: -1,
      rpe: 7,
    });
    expect(sent).not.toHaveProperty("replace_overlapping");
    const ex = sent.workout_groups[0].workout_exercises[0];
    expect(ex.exercise_details).toEqual(catalogRow(BENCH));
    expect(ex.sets).toHaveLength(3);
    for (const s of ex.sets) {
      expect(s.weightlifting_workout_set_id).toMatch(/^[0-9A-F-]{36}$/);
      expect(s).toMatchObject({ number_of_reps: 5, weight: 100 });
    }
    expect(parsePgRange(ex.sets[0].during)).toEqual({ start: "2026-11-21T17:00:00.000Z", end: "2026-11-21T17:10:00.000Z" });
    expect(parsePgRange(ex.sets[1].during)).toEqual({ start: "2026-11-21T17:10:00.000Z", end: "2026-11-21T17:20:00.000Z" });
    expect(ex.sets[2]).not.toHaveProperty("during");

    expect(get).toHaveBeenCalledWith(HISTORY, {}, { fresh: true });
    expect(out).toMatchObject({
      action: "logged",
      activity_id: "1f27998b-95c6-4865-acdd-3d413063ce9b",
      saved_during: "['2026-11-21T17:00:00.000Z','2026-11-21T17:20:00.000Z')",
      score_state: "pending",
      unit: "lb",
      converted_from: "kg",
      sent_weights: [[100, 100, 100]],
      verified: true,
      warnings: [],
    });
  });

  it("warns when WHOOP widens the saved window", async () => {
    const receipt = { ...fixture<Record<string, unknown>>("lift_receipt"), during: "['2026-11-21T16:50:00.000Z','2026-11-21T17:20:00.000Z')" };
    const client = await connect(registerLiftLog, { get: whoop({ "/users-service/v2/bootstrap": METRIC }), post: vi.fn().mockResolvedValue(receipt) });
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, unit: "kg", confirm: true } }));
    expect(out.warnings.join()).toMatch(/widened/);
    expect(out.converted_from ?? null).toBeNull();
  });

  it("maps a 409 to an overlap error naming whoop_activity_delete; nothing is deleted", async () => {
    const post = vi.fn().mockRejectedValue(new WhoopConflictError(LIFT_PATH, "Client exception, status code: 409", []));
    const del = vi.fn();
    const client = await connect(registerLiftLog, { get: whoop(), post, delete: del });
    const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, confirm: true } });
    expect(result.isError).toBe(true);
    expect(body(result).fix).toMatch(/whoop_activity_delete/);
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses 0-rep weighted sets and future ends before any network call", async () => {
    const get = vi.fn();
    const client = await connect(registerLiftLog, { get, post: vi.fn() });
    const zero = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, exercises: [{ exercise_id: BENCH, sets: [{ reps: 0, weight: 300 }] }], confirm: true } });
    expect(zero.isError).toBe(true);
    expect(body(zero).sets).toEqual([{ exercise: BENCH, set_number: 1, weight: 300 }]);
    const future = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, start: "2099-01-01T00:00:00.000Z", end: "2099-01-01T00:30:00.000Z" } });
    expect(future.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("timed exercises need time_seconds; unknown names get suggestions", async () => {
    const client = await connect(registerLiftLog, { get: whoop(), post: vi.fn() });
    const timed = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, exercises: [{ exercise_id: "ASSAULT_AIRBIKE", sets: [{ reps: 1 }] }] } });
    expect(timed.isError).toBe(true);
    expect(body(timed).problems[0]).toMatch(/time_seconds/);
    const unknown = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, exercises: [{ name: "bench pres", sets: [{ reps: 5 }] }] } });
    expect(body(unknown).misses[0].suggestions.length).toBeGreaterThan(0);
  });

  it("refuses when the account's unit can't be read", async () => {
    const post = vi.fn();
    const client = await connect(registerLiftLog, { get: whoop({ "/users-service/v2/bootstrap": { profile: { unit_system: "stone" } } }), post });
    const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, confirm: true } });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  describe("attach_to_activity_id (PR #49)", () => {
    const TARGET = "442bc3f0-dcb5-4dd3-a9d0-c6b7f4b4cee7";
    const OHP = "OVERHEADPRESS_BARBELL";
    const args = { attach_to_activity_id: TARGET, unit: "lb", exercises: [{ exercise_id: OHP, sets: [{ reps: 6, weight: 50 }] }] };
    const attachGet = () => whoop({
      // pending activity: link_workout_option_enabled is false, yet WHOOP links it
      "/core-details-bff/v1/cardio-details": fixture("cardio_details_pending_lift"),
      [`/weightlifting-service/v3/exercise/${OHP}/exercise_history`]: fixture("history_ohp_linked"),
    });

    it("previews the link as permanent", async () => {
      const post = vi.fn();
      const client = await connect(registerLiftLog, { get: attachGet(), post });
      const out = body(await client.callTool({ name: "whoop_lift_log", arguments: args }));
      expect(post).not.toHaveBeenCalled();
      expect(out.will_execute.path).toBe(LINK_PATH);
      expect(out.will_execute.body_summary.permanent).toMatch(/can't be undone/);
    });

    it("links in one call with template_id -1, no template saved or deleted", async () => {
      const post = vi.fn().mockResolvedValue(fixture("link_receipt"));
      const del = vi.fn();
      const client = await connect(registerLiftLog, { get: attachGet(), post, delete: del });
      const out = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...args, rpe: 6, confirm: true } }));
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(LINK_PATH, {
        activity_id: TARGET,
        rpe: 6,
        template_id: -1,
        template: {
          name: "2026-11-21",
          source: "USER",
          workout_template_key: -1,
          workout_groups: [{ workout_exercises: [{ exercise_details: catalogRow(OHP), sets: [{ number_of_reps: 6, weight: 50 }] }] }],
        },
      });
      expect(del).not.toHaveBeenCalled();
      expect(out).toMatchObject({ action: "attached", activity_id: TARGET, score_state: "incomplete", unit: "lb", verified: true });
      expect(out.volume_kg).toBeCloseTo(171.78, 1);
    });

    it("maps 409 'already linked'", async () => {
      const post = vi.fn().mockRejectedValue(new WhoopConflictError(LINK_PATH, "Activity already has a linked Strength Trainer workout", [], "Activity already has a linked Strength Trainer workout"));
      const client = await connect(registerLiftLog, { get: attachGet(), post });
      const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...args, confirm: true } });
      expect(result.isError).toBe(true);
      expect(body(result).error).toMatch(/already has Strength Trainer sets linked/);
    });

    it("refuses performed:false when attaching", async () => {
      const client = await connect(registerLiftLog, { get: vi.fn(), post: vi.fn() });
      const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...args, exercises: [{ exercise_id: OHP, sets: [{ reps: 6, weight: 50, performed: false }] }] } });
      expect(result.isError).toBe(true);
    });
  });
});
