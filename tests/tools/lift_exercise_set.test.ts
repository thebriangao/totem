import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IMPERIAL, METRIC, body, connect, fixture, routes } from "./lift_v2_harness.js";
import { CUSTOM_PATH, manualEntryPath, ormPath, registerLiftExerciseSet, sixMonthsBefore } from "../../src/tools/v2/lift_exercise_set.js";
import { todayIso } from "../../src/lib/dates.js";

const CUSTOM = "520AB719-E8B0-45CD-AE63-2F78A1877BDF";
const ENTRY = "cc8e19b0-fc1a-4fe8-8cb4-e1174dc255f9";
const v1 = (id: string) => `/weightlifting-service/v1/exercise/${id}`;

describe("whoop_lift_exercise_set: custom exercises", () => {
  it("create_custom: minimal body with the link, enums from WHOOP's filter options, v1 read-back", async () => {
    let created: Record<string, unknown> | null = null;
    const post = vi.fn(async (_p: string, b: Record<string, unknown>) => {
      created = { ...fixture<Record<string, unknown>>("custom_create_receipt"), ...b, custom_exercise_info: { linked_exercise: { exercise_id: "POWERCLEAN_BARBELL" } } };
      return created;
    });
    const get = vi.fn(async (path: string) => {
      if (path === "/weightlifting-service/v2/exercise") return fixture("catalog");
      if (path.startsWith("/weightlifting-service/v1/exercise/")) return created;
      throw new Error(`unexpected ${path}`);
    });
    const client = await connect(registerLiftExerciseSet, { get, post });
    const custom = { name: "Box clean", muscle_groups: ["LEGS"], equipment: "PLYO_BOX", movement_pattern: "OLY_LIFT", volume_input_format: "TIME", linked_exercise: "POWERCLEAN_BARBELL" };
    const out = body(await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "create_custom", custom, confirm: true } }));
    const [path, sent] = post.mock.calls[0]!;
    expect(path).toBe(CUSTOM_PATH);
    expect(sent).toEqual({
      exercise_id: expect.stringMatching(/^[0-9A-F-]{36}$/),
      name: "Box clean",
      muscle_groups: ["LEGS"],
      equipment: "PLYO_BOX",
      movement_pattern: "OLY_LIFT",
      volume_input_format: "TIME",
      custom_exercise_info: { linked_exercise: { exercise_id: "POWERCLEAN_BARBELL" } },
    });
    expect(sent).not.toHaveProperty("laterality");
    expect(sent).not.toHaveProperty("exercise_type");
    expect(out).toMatchObject({ action: "create_custom", exercise_id: (sent as { exercise_id: string }).exercise_id, verified: true, exercise: { name: "Box clean", linked: "POWERCLEAN_BARBELL" } });
  });

  it("create_custom without a link warns it will be untracked; bad enums are rejected by the schema", async () => {
    const client = await connect(registerLiftExerciseSet, { get: routes({ "/weightlifting-service/v2/exercise": fixture("catalog") }), post: vi.fn() });
    const out = body(await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "create_custom", custom: { name: "Sled push", muscle_groups: ["LEGS"], volume_input_format: "WEIGHT" } } }));
    expect(out.preview).toBe(true);
    expect(out.will_execute.body_summary.warnings[0]).toMatch(/untracked/);
    for (const bad of [{ equipment: "BAND" }, { movement_pattern: "OLYMPIC_LIFT" }, { muscle_groups: ["GLUTES"] }]) {
      const r = await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "create_custom", custom: { name: "x", muscle_groups: ["LEGS"], volume_input_format: "REPS", ...bad } } });
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it("edit_custom upserts with the same id, keeping omitted fields and the link", async () => {
    const current = fixture<Record<string, unknown>>("v1_exercise_custom_linked");
    const post = vi.fn().mockResolvedValue({});
    let reads = 0;
    const get = vi.fn(async (path: string) => {
      if (path === "/weightlifting-service/v2/exercise") return fixture("catalog");
      if (path === v1(CUSTOM)) return reads++ === 0 ? current : { ...current, name: "Renamed" };
      throw new Error(`unexpected ${path}`);
    });
    const client = await connect(registerLiftExerciseSet, { get, post });
    const out = body(await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "edit_custom", exercise_id: CUSTOM, custom: { name: "Renamed" }, confirm: true } }));
    expect(post).toHaveBeenCalledWith(CUSTOM_PATH, {
      exercise_id: CUSTOM,
      name: "Renamed",
      muscle_groups: current.muscle_groups,
      equipment: current.equipment,
      movement_pattern: current.movement_pattern,
      volume_input_format: current.volume_input_format,
      instructions: current.instructions,
      custom_exercise_info: { linked_exercise: { exercise_id: "BENCHPRESS_BARBELL" } },
    });
    expect(out.verified).toBe(true);
  });

  it("delete_custom is a soft delete verified by deleted:true; catalog exercises are refused", async () => {
    const del = vi.fn();
    let deleted = false;
    const get = vi.fn(async (path: string) => {
      if (path === "/weightlifting-service/v2/exercise") return fixture("catalog");
      if (path === v1(CUSTOM)) return { ...fixture<Record<string, unknown>>("v1_exercise_custom_linked"), deleted };
      if (path === v1("BENCHPRESS_BARBELL")) return fixture("v1_exercise_bench");
      throw new Error(`unexpected ${path}`);
    });
    del.mockImplementation(async () => { deleted = true; });
    const client = await connect(registerLiftExerciseSet, { get, delete: del });
    const out = body(await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "delete_custom", exercise_id: CUSTOM, confirm: true } }));
    expect(del).toHaveBeenCalledWith(`${CUSTOM_PATH}/${CUSTOM}`);
    expect(out).toMatchObject({ action: "delete_custom", verified: true, exercise: { deleted: true } });
    const catalog = await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "delete_custom", exercise_id: "BENCHPRESS_BARBELL", confirm: true } });
    expect(catalog.isError).toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe("whoop_lift_exercise_set: one-rep max", () => {
  // The 1RM date window is relative to today; pin the clock to the probe day.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T20:00:00.000Z"));
  });
  afterAll(() => vi.useRealTimers());

  it("sixMonthsBefore matches WHOOP's minimum_date and clamps month ends", () => {
    expect(sixMonthsBefore("2026-11-21")).toBe("2026-05-21");
    expect(sixMonthsBefore("2026-08-31")).toBe("2026-02-28");
    expect(sixMonthsBefore("2026-03-15")).toBe("2025-09-15");
  });

  it("set_1rm: PUT {date, value} in the display unit, read back from history", async () => {
    const today = todayIso();
    const put = vi.fn();
    let after = false;
    const history = (date: string, value: number) => ({ content: { items: [{ type: "MEASUREMENT_ENTRY_ITEM", content: {
      id: `MANUAL-${date}`, title: String(value), title_suffix: "kg", subtitle: "Manual",
      generic_interaction: { action: { request: { method: "DELETE", path: `weightlifting-service/v3/one-rep-max/manual-entry/${ENTRY}` } } },
    } }] } });
    const get = vi.fn(async (path: string) => {
      if (path === "/weightlifting-service/v2/exercise") return fixture("catalog");
      if (path === "/users-service/v2/bootstrap") return METRIC;
      if (path === `${ormPath("BENCHPRESS_BARBELL")}/history`) return after ? history(today, 100) : { content: { items: [] } };
      throw new Error(`unexpected ${path}`);
    });
    put.mockImplementation(async () => { after = true; });
    const client = await connect(registerLiftExerciseSet, { get, put });
    const out = body(await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "set_1rm", exercise_id: "BENCHPRESS_BARBELL", value: 220.46, unit: "lb", confirm: true } }));
    expect(put).toHaveBeenCalledWith(ormPath("BENCHPRESS_BARBELL"), { date: today, value: 100 });
    expect(out).toMatchObject({ action: "set_1rm", one_rep_max: { date: today, value: 100, unit: "kg", entry_id: ENTRY }, verified: true });
  });

  it("set_1rm with entry_id edits that entry; validation refuses range, future and old dates", async () => {
    const put = vi.fn();
    const get = routes({
      "/weightlifting-service/v2/exercise": fixture("catalog"),
      "/users-service/v2/bootstrap": IMPERIAL,
      [`${ormPath(CUSTOM)}/history`]: fixture("one_rep_max_history_manual"),
    });
    const client = await connect(registerLiftExerciseSet, { get, put });
    const prev = body(await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "set_1rm", exercise_id: CUSTOM, value: 140, unit: "lb", date: "2026-11-19", entry_id: ENTRY } }));
    expect(prev.will_execute).toMatchObject({ method: "PUT", path: ormPath(CUSTOM), body_summary: { date: "2026-11-19", value: 140, id: ENTRY, replaces: ["2026-11-20", 150] } });

    const bad = async (args: Record<string, unknown>) => (await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "set_1rm", exercise_id: CUSTOM, unit: "lb", ...args } })).isError;
    expect(await bad({ value: 1500 })).toBe(true);
    expect(await bad({ value: 100, date: "2099-01-01" })).toBe(true);
    expect(await bad({ value: 100, date: "2020-01-01" })).toBe(true);
    expect(await bad({ value: 100, entry_id: "not-an-entry" })).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("delete_1rm by date finds the manual entry and DELETEs it by entry id", async () => {
    let deleted = false;
    const del = vi.fn(async () => { deleted = true; });
    const get = vi.fn(async (path: string) => {
      if (path === "/weightlifting-service/v2/exercise") return fixture("catalog");
      if (path === `${ormPath(CUSTOM)}/history`) return deleted ? fixture("one_rep_max_history_after_delete") : fixture("one_rep_max_history_manual");
      throw new Error(`unexpected ${path}`);
    });
    const client = await connect(registerLiftExerciseSet, { get, delete: del });
    const out = body(await client.callTool({ name: "whoop_lift_exercise_set", arguments: { action: "delete_1rm", exercise_id: CUSTOM, date: "2026-11-20", confirm: true } }));
    expect(del).toHaveBeenCalledWith(manualEntryPath(ENTRY));
    expect(out).toMatchObject({ action: "delete_1rm", one_rep_max: { date: "2026-11-20", value: 150, entry_id: ENTRY }, verified: true });
  });
});
