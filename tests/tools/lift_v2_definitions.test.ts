import { describe, expect, it } from "vitest";
import { connect } from "./lift_v2_harness.js";
import { registerLiftSessions } from "../../src/tools/v2/lift_sessions.js";
import { registerLiftExercise } from "../../src/tools/v2/lift_exercise.js";
import { registerLiftLibrary } from "../../src/tools/v2/lift_library.js";
import { registerLiftLog } from "../../src/tools/v2/lift_log.js";
import { registerLiftTemplate } from "../../src/tools/v2/lift_template.js";
import { registerLiftExerciseSet } from "../../src/tools/v2/lift_exercise_set.js";

function describes(node: unknown, path: string, out: Array<[string, string]>): Array<[string, string]> {
  if (node && typeof node === "object") {
    const d = (node as { description?: unknown }).description;
    if (path && typeof d === "string") out.push([path, d]);
    for (const [k, v] of Object.entries(node)) describes(v, `${path}.${k}`, out);
  }
  return out;
}

describe("v2 strength tool definitions", () => {
  it("registers six tools with budgeted descriptions and the right annotation classes", async () => {
    const client = await connect([registerLiftSessions, registerLiftExercise, registerLiftLibrary, registerLiftLog, registerLiftTemplate, registerLiftExerciseSet], {});
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual([
      "whoop_lift_exercise", "whoop_lift_exercise_set", "whoop_lift_library", "whoop_lift_log", "whoop_lift_sessions", "whoop_lift_template",
    ]);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeLessThanOrEqual(600);
      for (const [path, d] of describes(t.inputSchema, "", [])) expect(d.length, `${t.name}${path}`).toBeLessThanOrEqual(80);
    }
    for (const name of ["whoop_lift_sessions", "whoop_lift_exercise", "whoop_lift_library"]) expect(byName.get(name)!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("whoop_lift_log")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get("whoop_lift_template")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get("whoop_lift_exercise_set")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
