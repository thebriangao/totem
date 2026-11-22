import { describe, expect, it, vi } from "vitest";
import { IMPERIAL, body, connect, fixture, notFound, routes } from "./lift_v2_harness.js";
import { registerLiftTemplate, TEMPLATE_POST, templatePath } from "../../src/tools/v2/lift_template.js";

const BENCH = "BENCHPRESS_BARBELL";
const KEY = 18085254;
const catalogRow = (id: string) => (fixture("catalog") as { exercises: Array<{ exercise_id: string }> }).exercises.find((e) => e.exercise_id === id);
const template = fixture<Record<string, any>>("template");

/** A template store: GET returns whatever was last POSTed for that key. */
function store(initial: Record<number, unknown> = { [KEY]: template }) {
  const t = new Map<number, unknown>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  let next = 18090000;
  const post = vi.fn(async (_path: string, b: Record<string, any>) => {
    const key = typeof b.workout_template_key === "number" && b.workout_template_key > 0 && t.has(b.workout_template_key) ? b.workout_template_key : next++;
    const saved = { parent_template_key: null, workout_template_key: key, name: b.name, workout_groups: b.workout_groups, is_draft: false, source: b.source ?? "USER" };
    t.set(key, saved);
    return saved;
  });
  const del = vi.fn(async (path: string) => { t.delete(Number(path.split("/").pop())); });
  const get = routes({
    "/weightlifting-service/v2/exercise": fixture("catalog"),
    "/users-service/v2/bootstrap": IMPERIAL,
    "/weightlifting-service/v2/prebuilt-workout-template/430069": fixture("prebuilt"),
  });
  const getAll = vi.fn(async (path: string, query?: unknown, opts?: unknown) => {
    const m = path.match(/^\/weightlifting-service\/v2\/workout-template\/(\d+)$/);
    if (m) {
      const v = t.get(Number(m[1]));
      if (!v) throw notFound(path);
      return structuredClone(v);
    }
    return get(path, query as never, opts);
  });
  return { get: getAll, post, delete: del, templates: t };
}

describe("whoop_lift_template", () => {
  it("create: sets carry only reps/weight/time, weights converted to the display unit", async () => {
    const w = store({});
    const client = await connect(registerLiftTemplate, w);
    const args = { action: "create", name: "Push day", unit: "kg", exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 45.36 }, { reps: 5 }] }] };
    const prev = body(await client.callTool({ name: "whoop_lift_template", arguments: args }));
    expect(prev.will_execute).toMatchObject({ method: "POST", path: TEMPLATE_POST, body_summary: { name: "Push day", unit: "lb", converted_from: "kg", exercises: [{ id: BENCH, sets: [[100, 5], [0, 5]] }] } });
    expect(w.post).not.toHaveBeenCalled();

    const out = body(await client.callTool({ name: "whoop_lift_template", arguments: { ...args, confirm: true } }));
    expect(w.post).toHaveBeenCalledWith(TEMPLATE_POST, {
      name: "Push day",
      workout_groups: [{ workout_exercises: [{ exercise_details: catalogRow(BENCH), sets: [{ number_of_reps: 5, weight: 100 }, { number_of_reps: 5, weight: 0 }] }] }],
    });
    expect(out).toMatchObject({ action: "created", template_key: 18090000, exercises: 1, sets: 2, unit: "lb", verified: true });
  });

  it("edit: existence-checked, POSTs the existing key (rename keeps the exercises as read)", async () => {
    const w = store();
    const client = await connect(registerLiftTemplate, w);
    const out = body(await client.callTool({ name: "whoop_lift_template", arguments: { action: "edit", template_key: KEY, name: "Bench triples", confirm: true } }));
    expect(w.get).toHaveBeenCalledWith(templatePath(KEY), {}, { fresh: true });
    const sent = w.post.mock.calls[0]![1] as Record<string, any>;
    expect(sent).toMatchObject({ workout_template_key: KEY, source: "USER", name: "Bench triples" });
    expect(sent.workout_groups[0].workout_exercises[0].sets).toEqual([{ number_of_reps: 3, weight: 105 }, { number_of_reps: 3, weight: 105 }, { number_of_reps: 3, weight: 105 }]);
    expect(out).toMatchObject({ action: "edited", template_key: KEY, name: "Bench triples", verified: true });
  });

  it("edit of an unknown key refuses instead of silently creating a template", async () => {
    const w = store();
    const client = await connect(registerLiftTemplate, w);
    const result = await client.callTool({ name: "whoop_lift_template", arguments: { action: "edit", template_key: 1, name: "x", confirm: true } });
    expect(result.isError).toBe(true);
    expect(w.post).not.toHaveBeenCalled();
  });

  it("copy forks a template or a WHOOP workout into a new key", async () => {
    const w = store();
    const client = await connect(registerLiftTemplate, w);
    const own = body(await client.callTool({ name: "whoop_lift_template", arguments: { action: "copy", copy_from: KEY, confirm: true } }));
    expect(w.post.mock.calls[0]![1]).not.toHaveProperty("workout_template_key");
    expect(own).toMatchObject({ action: "copied", template_key: 18090000, name: "probe-strength T1 edited (copy)", verified: true });
    expect(w.templates.get(KEY)).toEqual(template); // the source is untouched

    const prebuilt = body(await client.callTool({ name: "whoop_lift_template", arguments: { action: "copy", copy_from: "430069", name: "Pitch power", confirm: true } }));
    expect(prebuilt).toMatchObject({ action: "copied", name: "Pitch power", exercises: 7, sets: 21, verified: true });
  });

  it("delete: preview shows the template; DELETE v2 then a 404 read-back verifies", async () => {
    const w = store();
    const client = await connect(registerLiftTemplate, w);
    const prev = body(await client.callTool({ name: "whoop_lift_template", arguments: { action: "delete", template_key: KEY } }));
    expect(prev.will_execute).toMatchObject({ method: "DELETE", path: templatePath(KEY), body_summary: { name: "probe-strength T1 edited", sets: 3 } });
    expect(w.delete).not.toHaveBeenCalled();
    const out = body(await client.callTool({ name: "whoop_lift_template", arguments: { action: "delete", template_key: KEY, confirm: true } }));
    expect(w.delete).toHaveBeenCalledWith(templatePath(KEY));
    expect(out).toMatchObject({ action: "deleted", template_key: KEY, verified: true });
  });

  it("validates action inputs", async () => {
    const client = await connect(registerLiftTemplate, store());
    for (const args of [{ action: "create", name: "x" }, { action: "edit", name: "x" }, { action: "copy" }, { action: "delete" }, { action: "edit", template_key: KEY }]) {
      expect((await client.callTool({ name: "whoop_lift_template", arguments: args })).isError, JSON.stringify(args)).toBe(true);
    }
  });
});
