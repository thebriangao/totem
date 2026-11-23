// The v2 tool surface is a contract: 41 tools (24 read, 17 write), every one annotated,
// plus 5 catalog resources. Changing it should be a deliberate edit to this file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, READ_TOOLS, WRITE_TOOLS } from "../../src/tools/register.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { render, SCREENS } from "../cli/screens.js";

const READ = [
  "whoop_calendar", "whoop_coach_history", "whoop_community", "whoop_cycle", "whoop_day", "whoop_journal",
  "whoop_lift_exercise", "whoop_lift_library", "whoop_lift_sessions", "whoop_memory", "whoop_milestones", "whoop_now",
  "whoop_health", "whoop_preferences", "whoop_profile", "whoop_recovery", "whoop_sleep", "whoop_smart_alarm", "whoop_strain",
  "whoop_stress", "whoop_trend", "whoop_weekly_plan", "whoop_weight", "whoop_workouts",
];
const WRITE_ADDITIVE = ["whoop_activity_log", "whoop_lift_log"];
const WRITE_DESTRUCTIVE = [
  "whoop_activity_delete", "whoop_activity_edit", "whoop_coach_ask", "whoop_cycle_log", "whoop_hr_zones_set",
  "whoop_journal_log", "whoop_lift_exercise_set", "whoop_lift_template", "whoop_memory_set", "whoop_preferences_set",
  "whoop_profile_update", "whoop_raw", "whoop_smart_alarm_set", "whoop_weekly_plan_set", "whoop_weight_log",
];

/** Every `description` under a schema's properties, with its path. */
function describes(node: unknown, path = "", out: Array<[string, string]> = []): Array<[string, string]> {
  if (node && typeof node === "object") {
    const d = (node as { description?: unknown }).description;
    if (path && typeof d === "string") out.push([path, d]);
    for (const [k, v] of Object.entries(node)) describes(v, `${path}.${k}`, out);
  }
  return out;
}

async function connect() {
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, {} as WhoopClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  return client;
}

describe("v2 tool registry", () => {
  it("registers exactly the 41 tools, 24 read and 17 write", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ, ...WRITE_ADDITIVE, ...WRITE_DESTRUCTIVE].sort());
    expect(READ_TOOLS).toHaveLength(24);
    expect(WRITE_TOOLS).toHaveLength(17);
  });

  it("annotates every tool so clients can group and gate reads, additive writes and destructive writes", async () => {
    const { tools } = await (await connect()).listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of READ) expect(by[name], name).toMatchObject({ readOnlyHint: true });
    for (const name of WRITE_ADDITIVE) expect(by[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const name of WRITE_DESTRUCTIVE) expect(by[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // Only the coach and the raw passthrough reach beyond WHOOP's typed data.
    expect(tools.filter((t) => t.annotations?.openWorldHint).map((t) => t.name).sort()).toEqual(["whoop_coach_ask", "whoop_raw"]);
  });

  it("keeps every tool definition within the token budget", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) {
      expect((t.description ?? "").length, `${t.name} description`).toBeLessThanOrEqual(450);
      // Every describe, nested ones included (exercises[].sets[].performed, custom.linked_exercise…).
      for (const [path, text] of describes(t.inputSchema)) expect(text.length, `${t.name}${path} describe`).toBeLessThanOrEqual(60);
      expect(t.outputSchema, `${t.name} must not declare an outputSchema`).toBeUndefined();
    }
  });

  it("keeps the whole tools/list payload within its budget", async () => {
    // Every MCP client sends this to the model on every turn. v1 was 45,283
    // characters for 55 tools and v2 started at 50,318 for 40; the budget is 20%
    // under v1 (36,226). whoop_day's heart-rate series and day table added 366
    // characters; plain-string time inputs (src/lib/instant.ts) took 189 back.
    // Merge, the journal calendar, raw PATCH and whoop_health (2026-11-22) were paid
    // for by trimming wording that repeated the schema, and by moving the 30 dashboard
    // metric keys out of whoop_preferences_set's schema into whoop_preferences' answer. Plain
    // [min, max] arrays for whoop_hr_zones_set's zones took 57 more off. Measured at 2.0.0: 35,907.
    const { tools } = await (await connect()).listTools();
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(36_000);
    // Write tools say once, the same way, that they preview by default.
    for (const t of tools.filter((x) => x.annotations?.readOnlyHint === false && x.name !== "whoop_raw")) {
      expect(t.description, t.name).toMatch(/Previews unless confirm:true\.$/);
    }
    for (const t of tools) expect(t.description, t.name).not.toMatch(/^WRITE|DESTRUCTIVE:/);
  });

  it("lists slim schemas: no date regexes, safe-integer bounds or $schema URLs", async () => {
    const { tools } = await (await connect()).listTools();
    const text = JSON.stringify(tools.map((t) => t.inputSchema));
    expect(text).not.toContain("$schema");
    expect(text).not.toContain("9007199254740991");
    expect(text).not.toMatch(/"format":"date(-time)?","pattern"/);
    expect(text).not.toMatch(/\\d\\d\[2468\]/); // zod's leap-year date regex
    // Date fields keep their format, and real constraints survive.
    expect(text).toContain('"format":"date"');
    expect(text).toContain('"enum"');
  });

  // The Anthropic API checks every input schema as JSON Schema 2020-12 and drops a
  // tool whose schema fails. The SDK writes a z.tuple in draft-07 form ("items" as
  // an array, plus "additionalItems"), which 2020-12 rejects: that hid
  // whoop_hr_zones_set from Claude until its zone pairs became plain arrays.
  it("lists input schemas that are valid JSON Schema 2020-12: no draft-07 tuples", async () => {
    const { tools } = await (await connect()).listTools();
    const bad: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${path}/${i}`));
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "items" && (Array.isArray(value) || value === null || !["object", "boolean"].includes(typeof value))) bad.push(`${path}/items`);
        if (key === "additionalItems") bad.push(`${path}/additionalItems`);
        walk(value, `${path}/${key}`);
      }
    };
    for (const t of tools) walk(t.inputSchema, t.name);
    expect(bad).toEqual([]);
  });

  it("lists nothing that only restates a default or an obvious bound", async () => {
    const { tools } = await (await connect()).listTools();
    const text = JSON.stringify(tools);
    expect(text).not.toMatch(/"format":"uuid","pattern"/);
    expect(text).not.toContain("[0-9a-fA-F]{8}-"); // zod's uuid regex
    expect(text).not.toContain('"default":false');
    expect(text).not.toContain('"default":[]');
    expect(text).not.toContain('"minLength":1');
    expect(text).not.toContain('"minItems":1');
    expect(text).not.toContain('"exclusiveMinimum":0');
    expect(text).not.toContain('"propertyNames"');
    expect(text).not.toContain('"const"');
    expect(text).not.toContain("taskSupport"); // "forbidden" is the MCP default when absent
    // What a model does choose from stays: informative defaults, numeric ranges, enums, required lists.
    const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema as { properties: Record<string, any>; required?: string[] }]));
    expect(by.whoop_trend!.properties.window).toMatchObject({ default: "month", enum: ["week", "month", "six_month"] });
    expect(by.whoop_trend!.required).toEqual(["metrics"]);
    expect(by.whoop_lift_sessions!.properties.limit).toMatchObject({ default: 3, minimum: 1, maximum: 20 });
    expect(by.whoop_cycle_log!.properties.period.properties.flow).toEqual({ type: "number", enum: [0, 1, 2] });
    expect(by.whoop_cycle_log!.properties.symptoms.items.properties.yes.default).toBe(true);
    expect(by.whoop_hr_zones_set!.properties.max_heart_rate).toMatchObject({ minimum: 101, maximum: 220 });
    expect(by.whoop_memory!.properties.memory_id).toEqual({ type: "string", format: "uuid" });
    expect(by.whoop_smart_alarm_set!.properties.goal.enum).toHaveLength(7); // the safe goals only
    // A field's name is never mistaken for a schema keyword.
    expect(Object.keys(by.whoop_preferences_set!.properties)).toContain("enabled");
    expect(Object.keys(by.whoop_raw!.properties)).toEqual(["path", "method", "query", "body", "allow_write", "confirm"]);
  });

  it("still validates input the slim schema no longer spells out", async () => {
    const client = await connect();
    const rejected = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      return (res.content as Array<{ text: string }>)[0]!.text;
    };
    await rejected("whoop_day", { date: "2026-02-30" }); // date regex
    await rejected("whoop_day", { include: [] }); // minItems 1
    await rejected("whoop_memory", { memory_id: "not-a-uuid" }); // uuid regex
    await rejected("whoop_activity_delete", { activity_id: "" }); // minLength 1
    await rejected("whoop_cycle_log", { date: "2026-11-01", period: { yes: true, flow: 3 } }); // literal union
    await rejected("whoop_weight_log", { action: "add", weight: 0, unit: "kg" }); // exclusiveMinimum 0
    await rejected("whoop_raw", { path: "/x", query: { a: { nested: true } } }); // record value types
    await rejected("whoop_hr_zones_set", { action: "custom", zones: [[100, 120, 140]] }); // a zone is exactly [min, max]
    await rejected("whoop_hr_zones_set", { action: "custom", zones: [[100.5, 120]] }); // whole bpm
  });

  it("validates the dashboard keys it no longer lists as enums, and names the valid ones", async () => {
    const client = await connect();
    const gauges = (client: { listTools: () => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }> }) =>
      client.listTools().then(({ tools }) => (tools.find((t) => t.name === "whoop_preferences_set")!.inputSchema as { properties: Record<string, any> }).properties);
    const props = await gauges(client);
    // Both take plain strings: whoop_preferences lists the keys, and the handler checks them.
    expect(props.pinned).toMatchObject({ type: "array", items: { type: "string" } });
    expect(props.pinned.items.enum).toBeUndefined();
    expect(props.gauges).toMatchObject({ type: "array", minItems: 2, maxItems: 2, items: { type: "string" } });
    expect(props.gauges.items.enum).toBeUndefined();
    const res = await client.callTool({ name: "whoop_preferences_set", arguments: { setting: "dashboard", gauges: ["HRV", "NOT_A_METRIC"] } });
    expect(res.isError).toBe(true);
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { error: string; gauge_options: string[] };
    expect(out.error).toMatch(/NOT_A_METRIC can't be a focus gauge/);
    expect(out.gauge_options).toContain("SLEEP_PERFORMANCE");
    expect(out.gauge_options).not.toContain("RECOVERY"); // the fixed gauges are never offered
  });

  it("serves the five catalogs as resources", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "whoop://catalog/behaviors", "whoop://catalog/endpoints", "whoop://catalog/exercises",
      "whoop://catalog/garments", "whoop://catalog/sports",
    ]);
    for (const r of resources) {
      const read = await client.readResource({ uri: r.uri });
      const body = JSON.parse((read.contents[0] as { text: string }).text) as { columns: string[]; rows: unknown[][] };
      expect(body.rows.length, r.uri).toBeGreaterThan(5);
      expect(body.rows[0]).toHaveLength(body.columns.length);
    }
  });

  it("states the same tool count wherever a person reads it", async () => {
    for (const file of ["package.json", "server.json"]) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(text, file).toMatch(/\b41 tools\b|\(41 total\)/);
      expect(text, file).not.toMatch(/\b55 tools\b|\(55 total\)/);
    }
    // The CLI doesn't carry a number or a list of its own: `totem tools` reads
    // the registry, so what it prints is what the server registers.
    const { text } = await render(SCREENS.find((s) => s.name === "tools")!);
    expect(text).toMatch(/\b41 tools: 24 read your WHOOP data and 17 change it\b/);
    for (const name of [...READ, ...WRITE_ADDITIVE, ...WRITE_DESTRUCTIVE]) expect(text, name).toMatch(new RegExp(`\\b${name}\\b`));
    expect(text.match(/\bwhoop_\w+/g)).toHaveLength(41);
  });
});
