// The v2 tool surface is a contract: 40 tools (23 read, 17 write), every one annotated,
// plus 5 catalog resources. Changing it should be a deliberate edit to this file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, READ_TOOLS, WRITE_TOOLS } from "../../src/tools/register.js";
import type { WhoopClient } from "../../src/whoop/client.js";

const READ = [
  "whoop_calendar", "whoop_coach_history", "whoop_community", "whoop_cycle", "whoop_day", "whoop_journal",
  "whoop_lift_exercise", "whoop_lift_library", "whoop_lift_sessions", "whoop_memory", "whoop_milestones", "whoop_now",
  "whoop_preferences", "whoop_profile", "whoop_recovery", "whoop_sleep", "whoop_smart_alarm", "whoop_strain",
  "whoop_stress", "whoop_trend", "whoop_weekly_plan", "whoop_weight", "whoop_workouts",
];
const WRITE_ADDITIVE = ["whoop_activity_log", "whoop_lift_log"];
const WRITE_DESTRUCTIVE = [
  "whoop_activity_delete", "whoop_activity_edit", "whoop_coach_ask", "whoop_cycle_log", "whoop_hr_zones_set",
  "whoop_journal_log", "whoop_lift_exercise_set", "whoop_lift_template", "whoop_memory_set", "whoop_preferences_set",
  "whoop_profile_update", "whoop_raw", "whoop_smart_alarm_set", "whoop_weekly_plan_set", "whoop_weight_log",
];

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
  it("registers exactly the 40 tools, 23 read and 17 write", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ, ...WRITE_ADDITIVE, ...WRITE_DESTRUCTIVE].sort());
    expect(READ_TOOLS).toHaveLength(23);
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
      expect((t.description ?? "").length, `${t.name} description`).toBeLessThanOrEqual(600);
      const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [key, prop] of Object.entries(props)) {
        expect((prop.description ?? "").length, `${t.name}.${key} describe`).toBeLessThanOrEqual(80);
      }
      expect(t.outputSchema, `${t.name} must not declare an outputSchema`).toBeUndefined();
    }
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

  it("still validates input the slim schema no longer spells out", async () => {
    const res = await (await connect()).callTool({ name: "whoop_day", arguments: { date: "2026-02-30" } });
    expect(res.isError).toBe(true);
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

  it("states the same tool count wherever a person reads it", () => {
    for (const file of ["package.json", "server.json", "src/cli/index.ts"]) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(text, file).toMatch(/\b40 tools\b|\(40 total\)/);
      expect(text, file).not.toMatch(/\b55 tools\b|\(55 total\)/);
    }
  });
});
