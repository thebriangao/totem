import { describe, expect, it, vi } from "vitest";
import { body, connect, fixture, notFound, routes } from "./lift_v2_harness.js";
import { registerLiftTemplate, TEMPLATE_POST, templatePath } from "../../src/tools/v2/lift_template.js";

const BENCH = "BENCHPRESS_BARBELL";
const KEY = 18085254;
const catalogRow = (id: string) => (fixture("catalog") as { exercises: Array<{ exercise_id: string }> }).exercises.find((e) => e.exercise_id === id);
const template = fixture<Record<string, any>>("template");

/** A template store: GET returns whatever was last POSTed for that key. */
function store(initial: Record<number, unknown> = { [KEY]: template }) {
  const t = new Map<number, unknown>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  let next = 18090000;
  const unit = { system: "imperial" };
  /** What WHOOP stores for a sent weight (identity unless a test breaks it). */
  const mangle = { weight: (n: number) => n };
  const post = vi.fn(async (_path: string, b: Record<string, any>) => {
    const key = typeof b.workout_template_key === "number" && b.workout_template_key > 0 && t.has(b.workout_template_key) ? b.workout_template_key : next++;
    const groups = structuredClone(b.workout_groups);
    for (const g of groups) for (const we of g.workout_exercises) for (const s of we.sets) if (typeof s.weight === "number") s.weight = mangle.weight(s.weight);
    const saved = { parent_template_key: null, workout_template_key: key, name: b.name, workout_groups: groups, is_draft: false, source: b.source ?? "USER" };
    t.set(key, saved);
    return saved;
  });
  const del = vi.fn(async (path: string) => { t.delete(Number(path.split("/").pop())); });
  const get = routes({
    "/weightlifting-service/v2/exercise": fixture("catalog"),
    "/users-service/v2/bootstrap": () => ({ profile: { unit_system: unit.system } }),
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
  return { get: getAll, post, delete: del, templates: t, unit, mangle };
}

describe("whoop_lift_template", () => {
  it("create: sets carry only reps/weight/time, weights converted to the display unit", async () => {
    const w = store({});
    const client = await connect(registerLiftTemplate, w);
    const args = { action: "create", name: "Push day", unit: "kg", exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 45.36 }, { reps: 5 }] }] };
    const prev = body(await client.callTool({ name: "whoop_lift_template", arguments: args }));
    expect(prev.will_execute).toMatchObject({ method: "POST", path: TEMPLATE_POST, body_summary: { name: "Push day", unit: "kg", sent_unit: "lb", exercises: [{ id: BENCH, sets: [[45.36, 5], [0, 5]], sent: [100, 0] }] } });
    expect(w.post).not.toHaveBeenCalled();

    const out = body(await client.callTool({ name: "whoop_lift_template", arguments: { ...args, confirm: true } }));
    expect(w.post).toHaveBeenCalledWith(TEMPLATE_POST, {
      name: "Push day",
      workout_groups: [{ workout_exercises: [{ exercise_details: catalogRow(BENCH), sets: [{ number_of_reps: 5, weight: 100 }, { number_of_reps: 5, weight: 0 }] }] }],
    });
    expect(out).toMatchObject({ action: "created", template_key: 18090000, exercises: 1, sets: 2, unit: "kg", sent_unit: "lb", verified: true });
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

  describe("units and read-back", () => {
    const create = { action: "create", name: "Push day", exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 45.36 }, { reps: 5 }] }] };
    const sentSets = (w: ReturnType<typeof store>, call = 0) => (w.post.mock.calls[call]![1] as Record<string, any>).workout_groups[0].workout_exercises[0].sets;

    it("converts lb to kg for a metric account and reports back in lb; same-unit weights go through untouched", async () => {
      const w = store({});
      w.unit.system = "metric";
      const client = await connect(registerLiftTemplate, w);
      const lb = { ...create, exercises: [{ exercise_id: BENCH, sets: [{ reps: 5, weight: 220.46 }] }] };
      const out = body(await client.callTool({ name: "whoop_lift_template", arguments: { ...lb, unit: "lb", confirm: true } }));
      expect(sentSets(w)).toEqual([{ number_of_reps: 5, weight: 100 }]);
      expect(out).toMatchObject({ unit: "lb", sent_unit: "kg", verified: true });

      const same = body(await client.callTool({ name: "whoop_lift_template", arguments: { ...lb, unit: "kg", confirm: true } }));
      expect(sentSets(w, 1)).toEqual([{ number_of_reps: 5, weight: 220.46 }]);
      expect(same).toMatchObject({ unit: "kg", verified: true });
      expect(same).not.toHaveProperty("sent_unit");
    });

    it("weights need an explicit unit, and an unknown unit system is refused before anything is sent", async () => {
      const w = store({});
      const client = await connect(registerLiftTemplate, w);
      const noUnit = await client.callTool({ name: "whoop_lift_template", arguments: { ...create, confirm: true } });
      expect(noUnit.isError).toBe(true);
      expect(body(noUnit).error).toMatch(/unit/);
      w.unit.system = "stone";
      const stone = await client.callTool({ name: "whoop_lift_template", arguments: { ...create, unit: "kg", confirm: true } });
      expect(stone.isError).toBe(true);
      expect(JSON.stringify(stone.content)).toMatch(/stone/);
      expect(w.post).not.toHaveBeenCalled();
    });

    it("reads the unit fresh, as the last GET before the POST", async () => {
      const w = store();
      const order: string[] = [];
      const get = vi.fn(async (path: string, query?: unknown, opts?: { fresh?: boolean }) => {
        order.push(`GET ${path}${opts?.fresh ? " fresh" : ""}`);
        return w.get(path, query, opts);
      });
      const post = vi.fn(async (path: string, b: Record<string, any>) => {
        order.push(`POST ${path}`);
        return w.post(path, b);
      });
      const client = await connect(registerLiftTemplate, { ...w, get, post });
      await client.callTool({ name: "whoop_lift_template", arguments: { action: "edit", template_key: KEY, exercises: create.exercises, unit: "kg", confirm: true } });
      expect(order[order.indexOf(`POST ${TEMPLATE_POST}`) - 1]).toBe("GET /users-service/v2/bootstrap fresh");
    });

    it("a weight that reads back different from what was sent is not verified", async () => {
      const w = store({});
      w.mangle.weight = (n: number) => n * 2;
      const client = await connect(registerLiftTemplate, w);
      const out = body(await client.callTool({ name: "whoop_lift_template", arguments: { ...create, unit: "lb", confirm: true } }));
      expect(out.verified).toBe(false);
      expect(out.warnings.join()).toMatch(/read back differently/);
    });

    it("an edit WHOOP answers with a new key is not verified: it created a template instead", async () => {
      const w = store();
      const client = await connect(registerLiftTemplate, w);
      // the template disappears between the existence check and the POST
      const realPost = w.post.getMockImplementation()!;
      w.post.mockImplementation(async (path: string, b: Record<string, any>) => {
        w.templates.delete(KEY);
        return realPost(path, b);
      });
      const out = body(await client.callTool({ name: "whoop_lift_template", arguments: { action: "edit", template_key: KEY, name: "Renamed", confirm: true } }));
      expect(out).toMatchObject({ action: "created", template_key: 18090000, verified: false });
      expect(out.warnings.join()).toMatch(/instead of editing 18085254/);
    });

    it("an edit that replaces the exercise list previews what it replaces; a rename or copy lists no unlabelled weights", async () => {
      const w = store();
      const client = await connect(registerLiftTemplate, w);
      const prev = body(await client.callTool({ name: "whoop_lift_template", arguments: { action: "edit", template_key: KEY, exercises: create.exercises, unit: "lb" } }));
      expect(prev.will_execute.body_summary).toMatchObject({ template_key: KEY, replaces: { exercises: 1, sets: 3 } });
      const copy = body(await client.callTool({ name: "whoop_lift_template", arguments: { action: "copy", copy_from: KEY } }));
      expect(copy.will_execute.body_summary).toMatchObject({ copy_of: `template ${KEY}`, exercises: 1, sets: 3 });
      expect(copy.will_execute.body_summary).not.toHaveProperty("unit");
    });
  });
});
