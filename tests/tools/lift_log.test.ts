import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPERIAL, METRIC, body, connect, fixture, routes } from "./lift_v2_harness.js";
import { registerLiftLog, LIFT_PATH, LINK_PATH } from "../../src/tools/v2/lift_log.js";
import { WhoopApiError, WhoopConflictError } from "../../src/whoop/errors.js";
import { parsePgRange } from "../../src/lib/dates.js";
import { liftReadback } from "../../src/lib/lift_history.js";

liftReadback.delaysMs = [0, 0];

const BENCH = "BENCHPRESS_BARBELL";
const HISTORY = `/weightlifting-service/v3/exercise/${BENCH}/exercise_history`;
const catalogRow = (id: string) => (fixture("catalog") as { exercises: Array<{ exercise_id: string }> }).exercises.find((e) => e.exercise_id === id);

const BASE_ARGS = {
  unit: "kg",
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
    "/home-service/v1/home": {}, // the overlap pre-check: no activities that day
    [HISTORY]: fixture("history_bench"),
    ...overrides,
  });
}

/** A home screen listing one activity tile. */
function homeWith(tile: { id: string; internal_name: string; start: string; end: string }) {
  return { pillars: [{ content: { activity_v2_id: tile.id, internal_name: tile.internal_name, type: "CARDIO", status: "COMPLETE", during: { lower_endpoint: tile.start, upper_endpoint: tile.end } } }] };
}

describe("whoop_lift_log", () => {
  it("previews without writing: weights in the caller's unit, plus what WHOOP will be sent", async () => {
    const get = whoop();
    const post = vi.fn();
    const client = await connect(registerLiftLog, { get, post });
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: BASE_ARGS }));
    expect(post).not.toHaveBeenCalled();
    expect(out.preview).toBe(true);
    expect(out.will_execute).toMatchObject({ method: "POST", path: LIFT_PATH });
    expect(out.will_execute.body_summary).toMatchObject({
      during: "['2026-11-21T17:00:00.000Z','2026-11-21T17:20:00.000Z')",
      unit: "kg",
      sent_unit: "lb",
      exercises: [{ id: BENCH, sets: "2x5", weights: [45.36, 45.36], sent: [100, 100], skipped: 1 }],
    });
    // the unit is read fresh, never from cache
    expect(get).toHaveBeenCalledWith("/users-service/v2/bootstrap", {}, { fresh: true });
  });

  it("converts lb to kg for a metric account, and reports back in lb", async () => {
    const asKg = JSON.parse(JSON.stringify(fixture("history_bench")).replaceAll('"lbs"', '"kg"'));
    const get = whoop({ "/users-service/v2/bootstrap": METRIC, [HISTORY]: asKg });
    const post = vi.fn().mockResolvedValue(fixture("lift_receipt"));
    const client = await connect(registerLiftLog, { get, post });
    const args = { ...BASE_ARGS, unit: "lb", exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 220.46 }, { reps: 5, weight: 220.46 }] }] };
    const prev = body(await client.callTool({ name: "whoop_lift_log", arguments: args }));
    expect(prev.will_execute.body_summary).toMatchObject({ unit: "lb", sent_unit: "kg", exercises: [{ weights: [220.46, 220.46], sent: [100, 100] }] });
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...args, confirm: true } }));
    expect(post.mock.calls[0]![1].workout_groups[0].workout_exercises[0].sets.map((s: { weight: number }) => s.weight)).toEqual([100, 100]);
    expect(out).toMatchObject({ unit: "lb", sent_unit: "kg", sent_weights: [[100, 100]], verified: true });
  });

  it("sends the caller's numbers untouched when the units already match", async () => {
    const post = vi.fn().mockResolvedValue(fixture("lift_receipt"));
    const client = await connect(registerLiftLog, { get: whoop(), post });
    const args = { ...BASE_ARGS, unit: "lb", exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }] }], confirm: true };
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: args }));
    expect(post.mock.calls[0]![1].workout_groups[0].workout_exercises[0].sets.map((s: { weight: number }) => s.weight)).toEqual([100, 100]);
    expect(out).toMatchObject({ unit: "lb", verified: true });
    expect(out).not.toHaveProperty("sent_unit");
    expect(out).not.toHaveProperty("sent_weights");
  });

  it("weights need an explicit unit: nothing is assumed, nothing is read or sent", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const client = await connect(registerLiftLog, { get, post });
    const { unit: _unit, ...noUnit } = BASE_ARGS;
    const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...noUnit, confirm: true } });
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatch(/unit/);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    // bodyweight sets carry no weight, so no unit is needed
    const bodyweight = await connect(registerLiftLog, { get: whoop(), post });
    const prev = body(await bodyweight.callTool({ name: "whoop_lift_log", arguments: { ...noUnit, exercises: [{ exercise_id: BENCH, sets: [{ reps: 5 }] }] } }));
    expect(prev.preview).toBe(true);
  });

  it("reads the unit last: the fresh bootstrap GET is the final read before the POST", async () => {
    const order: string[] = [];
    const get = whoop();
    const tracked = vi.fn(async (path: string, query?: Record<string, unknown>, opts?: { fresh?: boolean }) => {
      order.push(`GET ${path}${opts?.fresh ? " fresh" : ""}`);
      return get(path, query, opts);
    });
    const post = vi.fn(async (path: string) => {
      order.push(`POST ${path}`);
      return fixture("lift_receipt");
    });
    const client = await connect(registerLiftLog, { get: tracked, post });
    await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, confirm: true } });
    const at = order.indexOf(`POST ${LIFT_PATH}`);
    expect(order[at - 1]).toBe("GET /users-service/v2/bootstrap fresh");
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
      unit: "kg",
      sent_unit: "lb",
      sent_weights: [[100, 100, 100]],
      verified: true,
    });
    expect(out.warnings).toBeUndefined(); // jsonOut drops empty arrays
  });

  it("read-back pages history (5 workouts per page) and retries while WHOOP catches up", async () => {
    const card = fixture<{ items: unknown[] }>("history_bench").items[0];
    const page1 = { id: "exercise_history", items: [], show_more: { next_start_date: "2026-11-21T18:42:00.000Z" } };
    let reads = 0;
    const get = whoop({
      [HISTORY]: (q: Record<string, unknown>) => {
        if (!q.startDate) return page1;
        reads++;
        return { id: "exercise_history", items: reads < 2 ? [] : [card], show_more: null };
      },
    });
    const client = await connect(registerLiftLog, { get, post: vi.fn().mockResolvedValue(fixture("lift_receipt")) });
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, confirm: true } }));
    expect(out.verified).toBe(true);
    expect(get).toHaveBeenCalledWith(HISTORY, { startDate: "2026-11-21T18:42:00.000Z" }, { fresh: true });
    expect(reads).toBe(2);
  });

  it("not found after the retries: verified false with a warning, never an error", async () => {
    const get = whoop({ [HISTORY]: { id: "exercise_history", items: [], show_more: null } });
    const client = await connect(registerLiftLog, { get, post: vi.fn().mockResolvedValue(fixture("lift_receipt")) });
    const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, confirm: true } });
    expect(result.isError).not.toBe(true);
    expect(body(result)).toMatchObject({ action: "logged", verified: false });
    expect(body(result).warnings[0]).toMatch(/lag/);
  });

  it("read-back compares the weights: a lift WHOOP read in another unit is not verified", async () => {
    // 45.36 kg was converted to 100 for an imperial account, but WHOOP shows the sets as 100 kg:
    // the account's unit changed between the unit read and the write.
    const asKg = JSON.parse(JSON.stringify(fixture("history_bench")).replaceAll('"lbs"', '"kg"'));
    const get = whoop({ [HISTORY]: asKg });
    const client = await connect(registerLiftLog, { get, post: vi.fn().mockResolvedValue(fixture("lift_receipt")) });
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, unit: "kg", confirm: true } }));
    expect(out.verified).toBe(false);
    expect(out.warnings.join()).toMatch(/WHOOP shows 100\/100 kg where 45\.36\/45\.36 kg was sent/);
    expect(out.warnings.join()).toMatch(/whoop_activity_delete/);
  });

  it("read-back tolerates WHOOP's whole-number display and a unit switched after the write", async () => {
    // Sent 44.09 lb (20 kg); WHOOP shows "44 lbs". Later shown in kg ("20 kg") it still matches.
    const shown = (value: string, units: string) => JSON.parse(JSON.stringify(fixture("history_bench")).replaceAll('"value":"100"', `"value":"${value}"`).replaceAll('"lbs"', `"${units}"`));
    for (const history of [shown("44", "lbs"), shown("20", "kg")]) {
      const client = await connect(registerLiftLog, { get: whoop({ [HISTORY]: history }), post: vi.fn().mockResolvedValue(fixture("lift_receipt")) });
      const args = { ...BASE_ARGS, unit: "kg", exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 20 }, { reps: 5, weight: 20 }] }], confirm: true };
      expect(body(await client.callTool({ name: "whoop_lift_log", arguments: args })).verified).toBe(true);
    }
  });

  it("an all-skipped lift reads back through the raw activity record, which answers while cardio-details 400s", async () => {
    const id = "1f27998b-95c6-4865-acdd-3d413063ce9b";
    const get = whoop({
      "/core-details-bff/v1/cardio-details": new WhoopApiError(400, "/core-details-bff/v1/cardio-details", "Cannot view activity details for a pending activity"),
      [`/activities-service/v2/activities/${id}`]: { id, type: "weightlifting_msk", score_type: "CARDIO", score_state: "pending", during: "['2026-11-21T17:00:00.000Z','2026-11-21T17:20:00.000Z')" },
    });
    const client = await connect(registerLiftLog, { get, post: vi.fn().mockResolvedValue(fixture("lift_receipt")) });
    const args = { ...BASE_ARGS, unit: "kg", exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 45.36, performed: false }] }], confirm: true };
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: args }));
    expect(out).toMatchObject({ action: "logged", verified: true });
    expect(out.warnings).toBeUndefined();
  });

  it("warns when WHOOP widens the saved window", async () => {
    const receipt = { ...fixture<Record<string, unknown>>("lift_receipt"), during: "['2026-11-21T16:50:00.000Z','2026-11-21T17:20:00.000Z')" };
    const client = await connect(registerLiftLog, { get: whoop({ "/users-service/v2/bootstrap": METRIC }), post: vi.fn().mockResolvedValue(receipt) });
    const out = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, unit: "kg", confirm: true } }));
    expect(out.warnings.join()).toMatch(/widened/);
    expect(out.sent_unit ?? null).toBeNull();
  });

  it("a 409 is reported truthfully: no activity, but WHOOP keeps the sets; nothing is retried or deleted", async () => {
    const post = vi.fn().mockRejectedValue(new WhoopConflictError(LIFT_PATH, "Client exception, status code: 409", []));
    const del = vi.fn();
    const client = await connect(registerLiftLog, { get: whoop(), post, delete: del });
    const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, confirm: true } });
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatch(/409/);
    expect(body(result).error).toMatch(/keeps the sets/);
    expect(body(result).error).not.toMatch(/Nothing was logged/);
    expect(body(result).fix).toMatch(/whoop_activity_delete/);
    expect(post).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
  });

  it("never sends a lift into an occupied window: WHOOP would 409 it and still keep its sets, undeletable", async () => {
    // a walk 09:10–09:40 PT; the lift asks for 09:00–09:20 PT
    const walk = { id: "0652e874-0000-4000-8000-000000000001", internal_name: "walking", start: "2026-11-21T17:10:00.000+0000", end: "2026-11-21T17:40:00.000+0000" };
    const post = vi.fn();
    const get = whoop({ "/home-service/v1/home": (q: Record<string, unknown>) => (q.date === "2026-11-21" ? homeWith(walk) : {}) });
    const client = await connect(registerLiftLog, { get, post });
    for (const confirm of [false, true]) {
      const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, confirm } });
      expect(result.isError).toBe(true);
      expect(body(result).overlaps).toEqual([{ activity_id: walk.id, type: "walking", start: "2026-11-21T09:10:00-08:00", end: "2026-11-21T09:40:00-08:00" }]);
      expect(body(result).fix).toMatch(/whoop_activity_delete/);
    }
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith("/home-service/v1/home", { date: "2026-11-21" }, { fresh: true });

    // back-to-back is fine: the lift may start exactly when the walk ends
    const after = await connect(registerLiftLog, { get, post: vi.fn().mockResolvedValue(fixture("lift_receipt")) });
    const ok = await after.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, start: "2026-11-21T09:40:00.000-08:00", end: "2026-11-21T10:00:00.000-08:00" } });
    expect(body(ok).preview).toBe(true);
  });

  it("refuses when the day's activities can't be read: an unchecked overlap can't be undone", async () => {
    const post = vi.fn();
    const get = whoop({ "/home-service/v1/home": new WhoopApiError(500, "/home-service/v1/home", "") });
    const client = await connect(registerLiftLog, { get, post });
    const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, confirm: true } });
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatch(/overlap/);
    expect(post).not.toHaveBeenCalled();
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

  it("time_seconds doesn't excuse a 0-rep weighted set on a rep exercise (it would still win a weight PR)", async () => {
    const post = vi.fn();
    const client = await connect(registerLiftLog, { get: whoop(), post });
    const bypass = await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, exercises: [{ exercise_id: BENCH, sets: [{ reps: 0, weight: 300, time_seconds: 5 }] }], confirm: true } });
    expect(bypass.isError).toBe(true);
    expect(body(bypass).sets).toEqual([{ exercise: "Bench Press - Barbell", set_number: 1, weight: 300 }]);
    expect(post).not.toHaveBeenCalled();
    // a timed exercise may carry weight with no reps (a weighted hold)
    const timed = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...BASE_ARGS, exercises: [{ exercise_id: "ASSAULT_AIRBIKE", sets: [{ weight: 10, time_seconds: 60 }] }] } }));
    expect(timed.preview).toBe(true);
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
      expect(out.effective_volume_kg).toBeCloseTo(171.78, 1);
    });

    it("maps 409 'already linked'; the link is not retried", async () => {
      const post = vi.fn().mockRejectedValue(new WhoopConflictError(LINK_PATH, "Activity already has a linked Strength Trainer workout", [], "Activity already has a linked Strength Trainer workout"));
      const client = await connect(registerLiftLog, { get: attachGet(), post });
      const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...args, confirm: true } });
      expect(result.isError).toBe(true);
      expect(body(result).error).toMatch(/already has Strength Trainer sets linked/);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("converts kg for the link too, reads the unit last, and finds a pending target through its raw record", async () => {
      const order: string[] = [];
      const get = whoop({
        // right after a create, the detail screen refuses; the record answers
        "/core-details-bff/v1/cardio-details": new WhoopApiError(400, "/core-details-bff/v1/cardio-details", "Cannot view activity details for a pending activity"),
        [`/activities-service/v2/activities/${TARGET}`]: { id: TARGET, type: "functional-fitness", score_type: "CARDIO", score_state: "pending", during: "['2026-11-21T18:30:00.000Z','2026-11-21T19:00:00.000Z')" },
        [`/weightlifting-service/v3/exercise/${OHP}/exercise_history`]: fixture("history_ohp_linked"),
      });
      const tracked = vi.fn(async (path: string, query?: Record<string, unknown>, opts?: { fresh?: boolean }) => {
        order.push(`GET ${path}${opts?.fresh ? " fresh" : ""}`);
        return get(path, query, opts);
      });
      const post = vi.fn(async (path: string) => {
        order.push(`POST ${path}`);
        return fixture("link_receipt");
      });
      const client = await connect(registerLiftLog, { get: tracked, post });
      const kg = { ...args, unit: "kg", exercises: [{ exercise_id: OHP, sets: [{ reps: 6, weight: 22.68 }] }] };
      const prev = body(await client.callTool({ name: "whoop_lift_log", arguments: kg }));
      expect(prev.will_execute.body_summary).toMatchObject({
        attach_to: { activity_id: TARGET, sport: "functional-fitness", start: "2026-11-21 10:30:00" },
        unit: "kg",
        sent_unit: "lb",
        exercises: [{ weights: [22.68], sent: [50] }],
      });
      expect(prev.will_execute.body_summary.warnings).toBeUndefined();

      order.length = 0;
      const out = body(await client.callTool({ name: "whoop_lift_log", arguments: { ...kg, confirm: true } }));
      expect((post.mock.calls[0] as unknown as [string, any])[1].template.workout_groups[0].workout_exercises[0].sets).toEqual([{ number_of_reps: 6, weight: 50 }]);
      expect(order[order.indexOf(`POST ${LINK_PATH}`) - 1]).toBe("GET /users-service/v2/bootstrap fresh");
      expect(out).toMatchObject({ action: "attached", unit: "kg", sent_unit: "lb", sent_weights: [[50]], verified: true });
    });

    it("refuses to attach on an account whose unit system it doesn't know", async () => {
      const post = vi.fn();
      const get = whoop({
        "/users-service/v2/bootstrap": { profile: { unit_system: "stone" } },
        "/core-details-bff/v1/cardio-details": fixture("cardio_details_pending_lift"),
      });
      const client = await connect(registerLiftLog, { get, post });
      const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...args, confirm: true } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/stone/);
      expect(post).not.toHaveBeenCalled();
    });

    it("refuses performed:false when attaching", async () => {
      const client = await connect(registerLiftLog, { get: vi.fn(), post: vi.fn() });
      const result = await client.callTool({ name: "whoop_lift_log", arguments: { ...args, exercises: [{ exercise_id: OHP, sets: [{ reps: 6, weight: 50, performed: false }] }] } });
      expect(result.isError).toBe(true);
    });
  });
});
