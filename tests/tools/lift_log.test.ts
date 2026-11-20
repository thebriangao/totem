import { describe, it, expect } from "vitest";
import {
  registerLiftLog,
  resolveWindow,
  duringLiteral,
  parseDuring,
  findOverlaps,
  zeroRepWeightedSets,
  linkTarget,
  linkWorkoutGroups,
} from "../../src/tools/v2/lift_log.js";
import { buildExerciseGroups, setSlots } from "../../src/whoop/build_lift_body.js";

const START = "2030-01-15T10:00:00+02:00";
const END = "2030-01-15T11:00:00+02:00";
const START_MS = Date.parse(START);
const END_MS = Date.parse(END);
const DURING = "['2030-01-15T08:00:00.000Z','2030-01-15T09:00:00.000Z')";

function sets(n: number, weight = 60) {
  return Array.from({ length: n }, () => ({ reps: 5, weight, strap_location: "LEFT" as const }));
}

function setDurings(groups: unknown[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const g of groups as Array<{ workout_exercises: Array<{ sets: Array<{ during: string }> }> }>) {
    for (const s of g.workout_exercises[0]!.sets) out.push(parseDuring(s.during)!);
  }
  return out;
}

describe("time range", () => {
  it("resolves an explicit window with offsets to UTC epoch ms", () => {
    expect(resolveWindow(START, END, 0)).toEqual({ startTs: START_MS, endTs: END_MS });
    expect(duringLiteral(START_MS, END_MS)).toBe(DURING);
  });

  it("defaults to the 30 minutes ending now", () => {
    expect(resolveWindow(undefined, undefined, END_MS)).toEqual({ startTs: END_MS - 30 * 60 * 1000, endTs: END_MS });
  });

  it("rejects end <= start", () => {
    expect(resolveWindow(END, START, 0)).toHaveProperty("error");
    expect(resolveWindow(START, START, 0)).toHaveProperty("error");
  });

  it("spreads 24 sets across the whole window instead of 24 x 100ms from the start", () => {
    const exercises = [
      { exercise_id: "BACKSQUAT_BARBELL", sets: sets(6) },
      { exercise_id: "BENCHPRESS_BARBELL", sets: sets(6) },
      { exercise_id: "BACKSQUAT_BARBELL", sets: sets(6) },
      { exercise_id: "BENCHPRESS_BARBELL", sets: sets(6) },
    ];
    const { workout_groups, set_count } = buildExerciseGroups(exercises, START_MS, END_MS);
    expect(set_count).toBe(24);
    const d = setDurings(workout_groups);
    expect(d[0]![0]).toBe(START_MS);
    expect(d[23]![1]).toBe(END_MS);
    for (let i = 1; i < d.length; i++) expect(d[i]![0]).toBe(d[i - 1]![1]);
    expect(d[0]![1] - d[0]![0]).toBe(150_000);
  });

  it("gives the last set any remainder so it still ends exactly at end", () => {
    expect(setSlots(0, 1000, 3)).toEqual([[0, 333], [333, 666], [666, 1000]]);
  });

  it("keeps 100ms placeholder slots when no end is given (template save)", () => {
    expect(setSlots(0, undefined, 3)).toEqual([[0, 100], [100, 200], [200, 300]]);
  });

  it("parses Whoop's during range literal", () => {
    expect(parseDuring("['2030-01-15T08:00:00.000Z','2030-01-15T08:00:02.400Z')")).toEqual([START_MS, START_MS + 2400]);
    expect(parseDuring("[2030-01-15T08:00:00+00:00,2030-01-15T09:00:00+00:00)")).toEqual([START_MS, END_MS]);
    expect(parseDuring(null)).toBeNull();
    expect(parseDuring("garbage")).toBeNull();
  });
});

describe("findOverlaps", () => {
  const rec = (id: string, start: string, end: string) => ({ id, sport_name: "functional-fitness", start, end });

  it("finds an activity that contains the requested window", () => {
    const raw = { records: [rec("act-1", "2030-01-15T09:40:00+02:00", "2030-01-15T11:10:00+02:00")] };
    expect(findOverlaps(raw, START_MS, END_MS).map((o) => o.activity_id)).toEqual(["act-1"]);
  });

  it("finds partial overlaps at either end", () => {
    const raw = {
      records: [
        rec("before", "2030-01-15T09:30:00+02:00", "2030-01-15T10:05:00+02:00"),
        rec("after", "2030-01-15T10:55:00+02:00", "2030-01-15T12:00:00+02:00"),
      ],
    };
    expect(findOverlaps(raw, START_MS, END_MS).map((o) => o.activity_id)).toEqual(["before", "after"]);
  });

  it("ignores back-to-back activities and malformed records", () => {
    const raw = {
      records: [
        rec("ends-at-start", "2030-01-15T09:00:00+02:00", START),
        rec("starts-at-end", END, "2030-01-15T12:00:00+02:00"),
        { id: "no-times" },
        null,
      ],
    };
    expect(findOverlaps(raw, START_MS, END_MS)).toEqual([]);
    expect(findOverlaps(undefined, START_MS, END_MS)).toEqual([]);
  });
});

describe("zeroRepWeightedSets", () => {
  it("flags reps:0 with weight > 0", () => {
    expect(zeroRepWeightedSets([
      { exercise_id: "BACKSQUAT_BARBELL", sets: [{ reps: 1, weight: 80 }, { reps: 0, weight: 90 }] },
    ])).toEqual([{ exercise_id: "BACKSQUAT_BARBELL", set_number: 2, weight: 90 }]);
  });

  it("allows reps:0 with no weight, and timed sets", () => {
    expect(zeroRepWeightedSets([
      { exercise_id: "A", sets: [{ reps: 0 }, { reps: 0, weight: 0 }, { reps: 0, weight: 20, time_seconds: 60 }] },
    ])).toEqual([]);
  });
});

type Call = { method: string; path: string; query?: unknown; body?: unknown };

function harness(workouts: unknown, opts: { failGet?: boolean; receiptDuring?: string; cardio?: unknown; failLink?: boolean } = {}) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, query: unknown) => {
      calls.push({ method: "GET", path, query });
      if (opts.failGet) throw new Error("boom");
      return path.includes("cardio-details") ? opts.cardio : workouts;
    },
    delete: async (path: string, query: unknown) => {
      calls.push({ method: "DELETE", path, query });
      return undefined;
    },
    post: async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, body });
      if (path.endsWith("/workout-template")) return { workout_template_key: 4242 };
      if (path.endsWith("/link-cardio-workout")) {
        if (opts.failLink) throw new Error("link failed");
        return {
          original_activity_type: "functional-fitness",
          workout_metadata: { id: "act-1", type: "functional-fitness", during: "['2030-01-15T07:40:00.000Z','2030-01-15T09:10:00.000Z')", total_effective_volume_kg: 300 },
        };
      }
      return { id: "new-activity", during: opts.receiptDuring ?? (body as { during: string }).during };
    },
  };
  let handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
      handler = h;
    },
  };
  registerLiftLog(server as never, client as never);
  const run = async (args: Record<string, unknown>) => {
    const res = await handler({ replace_overlapping: false, keep_template: false, confirm: false, ...args });
    return { isError: res.isError ?? false, out: JSON.parse(res.content[0]!.text) };
  };
  return { calls, run };
}

const OVERLAPPING = { records: [{ id: "act-1", sport_name: "functional-fitness", start: "2030-01-15T07:40:00.000Z", end: "2030-01-15T09:10:00.000Z" }] };
const base = { start: START, end: END, exercises: [{ exercise_id: "BACKSQUAT_BARBELL", sets: sets(2) }] };

describe("whoop_lift_log handler", () => {
  it("preview shows the exact time range that will be sent", async () => {
    const { run, calls } = harness({ records: [] });
    const { out } = await run(base);
    const summary = out.will_execute.body_summary;
    expect(summary.time_range.during).toBe(DURING);
    expect(summary.time_range.duration_minutes).toBe(60);
    expect(Date.parse(summary.set_timing.first_set_start)).toBe(START_MS);
    expect(Date.parse(summary.set_timing.last_set_end)).toBe(END_MS);
    expect(summary.set_timing.seconds_per_set).toBe(1800);
    expect(summary.overlap_action).toBe("none");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("preview reports overlaps without writing anything", async () => {
    const { run, calls } = harness(OVERLAPPING);
    const { isError, out } = await run(base);
    expect(isError).toBe(false);
    expect(out.will_execute.body_summary.overlapping_activities[0].activity_id).toBe("act-1");
    expect(out.will_execute.body_summary.overlap_action).toMatch(/refuse/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("refuses an overlapping log by default, naming the clashing activity", async () => {
    const { run, calls } = harness(OVERLAPPING);
    const { isError, out } = await run({ ...base, confirm: true });
    expect(isError).toBe(true);
    expect(out.overlapping_activities).toHaveLength(1);
    expect(out.overlapping_activities[0]).toMatchObject({ activity_id: "act-1", sport_name: "functional-fitness" });
    expect(out.overlapping_activities[0].start_local).toBeTypeOf("string");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("with replace_overlapping deletes first, logs the full window, and says so", async () => {
    const { run, calls } = harness(OVERLAPPING);
    const { isError, out } = await run({ ...base, confirm: true, replace_overlapping: true });
    expect(isError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(calls[1]!.query).toEqual({ activityId: "act-1" });
    expect((calls[2]!.body as { during: string }).during).toBe(DURING);
    expect(out.deleted_overlapping[0].activity_id).toBe("act-1");
    expect(out.warning).toBeUndefined();
  });

  it("logs normally with no overlap", async () => {
    const { run, calls } = harness({ records: [] });
    const { isError, out } = await run({ ...base, confirm: true });
    expect(isError).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(out.deleted_overlapping).toBeUndefined();
    expect(out.saved_during).toBe(out.requested_during);
  });

  it("looks back far enough to catch a long activity that started earlier", async () => {
    const { run, calls } = harness({ records: [] });
    await run(base);
    expect(Date.parse((calls[0]!.query as { start: string }).start)).toBeLessThanOrEqual(START_MS - 24 * 3600 * 1000);
  });

  it("does not log if the overlap check fails", async () => {
    const { run, calls } = harness(null, { failGet: true });
    const { isError } = await run({ ...base, confirm: true });
    expect(isError).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("warns when Whoop saves a different window than requested", async () => {
    const { run } = harness({ records: [] }, { receiptDuring: "['2030-01-15T08:00:00.000Z','2030-01-15T08:00:02.400Z')" });
    const { out } = await run({ ...base, confirm: true });
    expect(out.warning).toMatch(/different time window/);
  });

  it("rejects 0-rep weighted sets before any network call", async () => {
    const { run, calls } = harness({ records: [] });
    const { isError, out } = await run({
      ...base,
      confirm: true,
      exercises: [{ exercise_id: "BACKSQUAT_BARBELL", sets: [{ reps: 0, weight: 90, strap_location: "LEFT" }] }],
    });
    expect(isError).toBe(true);
    expect(out.sets).toEqual([{ exercise_id: "BACKSQUAT_BARBELL", set_number: 1, weight: 90 }]);
    expect(out.reason).toMatch(/PR/);
    expect(calls).toEqual([]);
  });
});

const CARDIO = (linkable: boolean) => ({
  link_workout_option_enabled: linkable,
  details_edit_components: {
    activity_type_internal_name: "functional-fitness",
    start_time_selector: { initial_time: "2030-01-15T09:40:00.000+02:00" },
    end_time_selector: { initial_time: "2030-01-15T11:10:00.000+02:00" },
  },
});

describe("linkTarget / linkWorkoutGroups", () => {
  it("reads linkability, sport and window from cardio-details", () => {
    expect(linkTarget(CARDIO(true))).toEqual({
      linkable: true,
      sport_name: "functional-fitness",
      start: "2030-01-15T09:40:00.000+02:00",
      end: "2030-01-15T11:10:00.000+02:00",
    });
    expect(linkTarget({}).linkable).toBe(false);
    expect(linkTarget(null)).toEqual({ linkable: false, sport_name: null, start: null, end: null });
  });

  it("reduces sets to {weight, number_of_reps, time_in_seconds?} and keeps exercise_details", () => {
    const exercises = [{ exercise_id: "BACKSQUAT_BARBELL", sets: [{ reps: 2, weight: 80 }, { reps: 1, time_seconds: 30 }] }];
    const { workout_groups } = buildExerciseGroups(exercises, 0);
    const out = linkWorkoutGroups(workout_groups, exercises) as Array<{ workout_exercises: Array<{ sets: unknown[]; exercise_details: { exercise_id: string } }> }>;
    expect(out[0]!.workout_exercises[0]!.sets).toEqual([
      { weight: 80, number_of_reps: 2 },
      { weight: 0, number_of_reps: 1, time_in_seconds: 30 },
    ]);
    expect(out[0]!.workout_exercises[0]!.exercise_details.exercise_id).toBe("BACKSQUAT_BARBELL");
  });
});

describe("whoop_lift_log attach_to_activity_id", () => {
  it("preview reads the target and writes nothing", async () => {
    const { run, calls } = harness({ records: [] }, { cardio: CARDIO(true) });
    const { isError, out } = await run({ ...base, attach_to_activity_id: "act-1" });
    expect(isError).toBe(false);
    expect(out.will_execute.body_summary.attach_to.sport_name).toBe("functional-fitness");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(calls[0]!.query).toEqual({ activityId: "act-1" });
  });

  it("saves a template, links it, then deletes the template, without an overlap check or new activity", async () => {
    const { run, calls } = harness({ records: [] }, { cardio: CARDIO(true) });
    const { isError, out } = await run({ ...base, confirm: true, attach_to_activity_id: "act-1" });
    expect(isError).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /core-details-bff/v1/cardio-details",
      "POST /weightlifting-service/v3/workout-template",
      "POST /weightlifting-service/v2/weightlifting-workout/link-cardio-workout",
      "DELETE /weightlifting-service/v2/workout-template/4242",
    ]);
    const link = calls[2]!.body as Record<string, unknown> & { template: Record<string, unknown> };
    expect(link).toMatchObject({ rpe: 0, template_id: 4242, activity_id: "act-1" });
    expect(link.template).toMatchObject({ source: "USER", workout_template_key: 4242 });
    expect(out).toMatchObject({ attached: true, activity_id: "act-1", template_id: 4242, template_deleted: true, type: "functional-fitness", set_count: 2 });
  });

  it("keeps the template with keep_template:true", async () => {
    const { run, calls } = harness({ records: [] }, { cardio: CARDIO(true) });
    const { out } = await run({ ...base, confirm: true, attach_to_activity_id: "act-1", keep_template: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
    expect(out.template_deleted).toBe(false);
  });

  it("deletes the template if the link call fails", async () => {
    const { run, calls } = harness({ records: [] }, { cardio: CARDIO(true), failLink: true });
    await expect(run({ ...base, confirm: true, attach_to_activity_id: "act-1" })).rejects.toThrow("link failed");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "DELETE"]);
  });

  it("refuses when Whoop says the activity isn't linkable", async () => {
    const { run, calls } = harness({ records: [] }, { cardio: CARDIO(false) });
    const { isError, out } = await run({ ...base, confirm: true, attach_to_activity_id: "act-1" });
    expect(isError).toBe(true);
    expect(out.activity.activity_id).toBe("act-1");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("can't be combined with replace_overlapping", async () => {
    const { run, calls } = harness({ records: [] }, { cardio: CARDIO(true) });
    const { isError } = await run({ ...base, confirm: true, attach_to_activity_id: "act-1", replace_overlapping: true });
    expect(isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("still rejects 0-rep weighted sets", async () => {
    const { run, calls } = harness({ records: [] }, { cardio: CARDIO(true) });
    const { isError } = await run({
      ...base,
      confirm: true,
      attach_to_activity_id: "act-1",
      exercises: [{ exercise_id: "BACKSQUAT_BARBELL", sets: [{ reps: 0, weight: 90, strap_location: "LEFT" }] }],
    });
    expect(isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("whoop_lift_log exercise names", () => {
  it("resolves an exact catalog name to its ID", async () => {
    const { run, calls } = harness({ records: [] });
    const { isError } = await run({ ...base, confirm: true, exercises: [{ exercise: "Back Squat - Barbell", sets: sets(1) }] });
    expect(isError).toBe(false);
    const body = calls[1]!.body as { workout_groups: Array<{ workout_exercises: Array<{ exercise_details: { exercise_id: string } }> }> };
    expect(body.workout_groups[0]!.workout_exercises[0]!.exercise_details.exercise_id).toBe("BACKSQUAT_BARBELL");
  });

  it("rejects an exercise with neither id nor a known name, before any network call", async () => {
    const { run, calls } = harness({ records: [] });
    const { isError } = await run({ ...base, confirm: true, exercises: [{ exercise: "Not A Real Lift", sets: sets(1) }] });
    expect(isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
