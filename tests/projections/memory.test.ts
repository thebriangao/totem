// Memory (context hub) projections on throwaway-account responses (ai.ndjson #58, #59, #45).
import { describe, expect, it } from "vitest";
import {
  findCardContent,
  memoryEnabled,
  parseCardDate,
  projectMemoryDetail,
  projectMemoryItems,
} from "../../src/projections/memory.js";
import { MemoryOut } from "../../src/schemas/memory.js";
import { load } from "../tools/helpers_coach.js";

describe("memory projections", () => {
  it("projects cards as {id, title, summary, status} (category only on the timeline) and the category keys", () => {
    const out = projectMemoryItems(load("memory/items_goals.json"), "goals");
    expect(out.items).toEqual([
      { id: "7d744bf9-9665-4382-bfe0-b3499491d84b", title: "Training for a 10k race", summary: "You want to run a 10k race in March 2027.", status: "ACTIVE" },
      { id: "0b7f343f-8784-4ec3-b357-e364de4dcda1", title: "Building power", summary: "Main strength-training goal is to build power.", status: "ACTIVE" },
    ]);
    expect(out.total).toBe(2);
    expect(out.categories).toEqual(["timeline", "goals", "health_conditions", "identity", "lifestyle", "training", "work"]);
    expect(() => MemoryOut.parse(out)).not.toThrow();
    const timeline = projectMemoryItems(load("memory/items_goals.json"), "timeline", 1);
    expect(timeline.items).toEqual([{ id: "7d744bf9-9665-4382-bfe0-b3499491d84b", title: "Training for a 10k race", summary: "You want to run a 10k race in March 2027.", status: "ACTIVE", category: "Goals" }]);
    expect(timeline.total).toBe(2);
  });

  it("projects the detail screen and dates from the card", () => {
    const raw = load("memory/items_goals.json");
    const out = projectMemoryDetail(load("memory/detail.json"), "7d744bf9-9665-4382-bfe0-b3499491d84b", findCardContent(raw, "7d744bf9-9665-4382-bfe0-b3499491d84b"));
    expect(out).toMatchObject({
      view: "detail",
      title: "Training for a 10k race",
      summary: "You want to run a 10k race in March 2027.",
      status: "ACTIVE",
      started: "2026-11-22",
      expires: "2027-03-31",
      conversations: ["Nov 21, 2026 Training for a 10k race in March 2027"],
    });
    expect(out.note).toMatch(/marked this memory seen/);
    expect(() => MemoryOut.parse(out)).not.toThrow();
  });

  it("parses card dates and keeps unparseable text", () => {
    expect(parseCardDate("Start date: Nov 2, 2026")).toBe("2026-11-02");
    expect(parseCardDate("Expires: September 30, 2027")).toBe("2027-09-30");
    expect(parseCardDate("Expires: soon")).toBe("soon");
    expect(parseCardDate(null)).toBeNull();
  });

  it("reads WHOOP_COACH_MEMORY from the AI settings list", () => {
    expect(memoryEnabled(load("memory/ai_settings_memory_off.json"))).toBe(false);
    expect(memoryEnabled({ settings: [] })).toBeNull();
  });
});
