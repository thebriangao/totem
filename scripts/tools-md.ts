// TOOLS.md, written from the tool registry itself, so the reference can't
// drift from the code. tests/tools/tools_md.test.ts fails when it is stale.
//
//   npx tsx scripts/tools-md.ts > TOOLS.md
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools/register.js";
import type { WhoopClient } from "../src/whoop/client.js";

const GROUPS: Array<{ title: string; intro: string; tools: string[] }> = [
  { title: "Today and any day", intro: "Scores, sleep, strain, stress and heart rate for a day, or a table of many days.", tools: ["whoop_now", "whoop_day", "whoop_recovery", "whoop_sleep", "whoop_strain", "whoop_stress"] },
  { title: "Trends", intro: "Averages and changes over weeks and months, and the calendar of scores.", tools: ["whoop_trend", "whoop_calendar"] },
  { title: "Activities", intro: "Workouts, naps and sleeps: read them, log new ones, fix or remove them.", tools: ["whoop_workouts", "whoop_activity_log", "whoop_activity_edit", "whoop_activity_delete"] },
  { title: "Strength Trainer", intro: "Lifting sessions, exercise history and records, the exercise library, logging lifts and templates.", tools: ["whoop_lift_sessions", "whoop_lift_exercise", "whoop_lift_library", "whoop_lift_log", "whoop_lift_template", "whoop_lift_exercise_set"] },
  { title: "Journal", intro: "Daily journal answers and what they do to your recovery.", tools: ["whoop_journal", "whoop_journal_log"] },
  { title: "WHOOP Coach", intro: "Ask WHOOP's own Coach, read past conversations and the outlook, manage what it remembers.", tools: ["whoop_coach_ask", "whoop_coach_history", "whoop_memory", "whoop_memory_set"] },
  { title: "Body", intro: "Weight and body composition, and cycle tracking.", tools: ["whoop_weight", "whoop_weight_log", "whoop_cycle", "whoop_cycle_log"] },
  { title: "Plans and alarms", intro: "The weekly plan and Smart Alarm.", tools: ["whoop_weekly_plan", "whoop_weekly_plan_set", "whoop_smart_alarm", "whoop_smart_alarm_set"] },
  { title: "Profile, settings and community", intro: "Your profile, heart-rate zones, app settings, milestones and teams.", tools: ["whoop_profile", "whoop_profile_update", "whoop_hr_zones_set", "whoop_preferences", "whoop_preferences_set", "whoop_milestones", "whoop_community"] },
  { title: "Anything else", intro: "Any WHOOP endpoint, for what no tool covers yet.", tools: ["whoop_raw"] },
];

type Schema = { type?: string | string[]; enum?: unknown[]; items?: Schema; anyOf?: Schema[]; description?: string; properties?: Record<string, Schema>; required?: string[] };

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function typeOf(s: Schema): string {
  if (s.enum) return s.enum.map((v) => `\`${String(v)}\``).join(", ");
  if (s.anyOf) return [...new Set(s.anyOf.map(typeOf))].join(" or ");
  if (s.type === "array") return s.items ? `list of ${typeOf(s.items).replace(/^(\w)/, (m) => m)}` : "list";
  if (s.type === "object") return "object";
  return Array.isArray(s.type) ? s.type.join(" or ") : (s.type ?? "any");
}

export async function toolsMarkdown(): Promise<string> {
  const server = new McpServer({ name: "totem", version: "0" });
  registerTools(server, {} as WhoopClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "docs", version: "0" });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  await client.close();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const grouped = GROUPS.flatMap((g) => g.tools);
  const missing = tools.map((t) => t.name).filter((n) => !grouped.includes(n));
  if (missing.length) throw new Error(`TOOLS.md groups are missing: ${missing.join(", ")}`);

  const reads = tools.filter((t) => t.annotations?.readOnlyHint).length;
  const out: string[] = [
    `# The ${tools.length} tools`,
    "",
    `What totem gives an AI app: ${reads} tools that read your WHOOP data and ${tools.length - reads} that change it.`,
    "This page is written from the tool registry (`npx tsx scripts/tools-md.ts`), so it says exactly what an app sees.",
    "",
    "- **Changes need a yes.** A tool that writes returns a preview of what it would send, and does nothing until it is called again with `confirm: true`. Your app shows you the preview first.",
    "- **Small by default.** A call with only its required inputs answers in about 1.5 KB. The heavy parts (a hypnogram, every set of every lift, a heart-rate series) come with `include`.",
    "- **Your time zone.** Times come back in your WHOOP time zone. A time you give without an offset (`2026-11-20T08:00`) is read on your clock too.",
    "",
  ];
  for (const g of GROUPS) {
    out.push(`- [${g.title}](#${g.title.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")})`);
  }
  for (const g of GROUPS) {
    out.push("", `## ${g.title}`, "", g.intro);
    for (const name of g.tools) {
      const t = byName.get(name)!;
      const write = !t.annotations?.readOnlyHint;
      const schema = t.inputSchema as Schema;
      const props = Object.entries(schema.properties ?? {}).filter(([k]) => k !== "confirm");
      const required = new Set(schema.required ?? []);
      out.push("", `### \`${name}\`${write ? " (changes data)" : ""}`, "", t.description ?? "");
      if (props.length === 0) { out.push("", "No inputs."); continue; }
      out.push("", "| Input | Type | Notes |", "|---|---|---|");
      for (const [key, s] of props) {
        out.push(`| \`${key}\`${required.has(key) ? " (required)" : ""} | ${cell(typeOf(s))} | ${cell(s.description ?? "")} |`);
      }
      if (write && name !== "whoop_raw") out.push("", "Add `confirm: true` to make the change.");
    }
  }
  return out.join("\n") + "\n";
}

// Run directly: print the page.
if (process.argv[1] && /tools-md\.ts$/.test(process.argv[1])) {
  process.stdout.write(await toolsMarkdown());
}
