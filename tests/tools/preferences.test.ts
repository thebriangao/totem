import { describe, expect, it } from "vitest";
import { registerPreferences } from "../../src/tools/v2/preferences.js";
import { projectAiSettings, projectDashboard, projectJournalPrefs, projectNotifications } from "../../src/projections/settings_v2.js";
import { connect, fixture, mockWhoop, parse, toolBudget } from "./journal_profile_helpers.js";

const ROUTES = {
  "/journal-service/v1/journals/preferences": fixture("journal_preferences.json"),
  "/notification-service/v1/notifications/user-settings/bff": fixture("notification_settings.json"),
  "/ai-conversation-service/v1/settings": fixture("ai_settings.json"),
  "/home-service/v2/home/dashboard/customize": fixture("dashboard_customize.json"),
  // The customize screen (live shape): every behaviour with `selected`; the custom one is tracked.
  "/journal-service/v3/journals/behaviors": {
    grouped_toggles: [{
      title: "NOT SELECTED",
      toggles: [
        { id: "1", title: "Alcohol", internal_name: "alcohol", selected: true, custom: false },
        { id: "2", title: "Caffeine", internal_name: "caffeine", selected: true, custom: false },
        { id: "3", title: "Marijuana", internal_name: "marijuana", selected: false, custom: false },
        { id: "163752", title: "Probe Hip Mobility", internal_name: "Probe Hip Mobility", selected: true, custom: true },
      ],
    }],
  },
  // WHOOP's stock list never includes custom behaviours (live 2026-11-21); it must not be the count's source.
  "/activities-service/v1/journals/behaviors/user": { total_count: 2, offset: 2, records: [{ id: 1 }, { id: 2 }] },
};

describe("whoop_preferences projections", () => {
  it("journal flags", () => {
    expect(projectJournalPrefs(fixture("journal_preferences.json"))).toEqual({ journal_enabled: true, journal_autopop_enabled: true, ai_autopop_enabled: true });
  });
  it("notifications and AI settings as key → active maps", () => {
    expect(projectNotifications(fixture("notification_settings.json"))).toEqual({ StressSummary: true, GPS: true, ConversationalCheckIn: true, CheckIn: true });
    expect(projectAiSettings(fixture("ai_settings.json"))).toEqual({ WHOOP_COACH: true, WHOOP_COACH_DATA: true, WHOOP_COACH_CONCISE: false, WHOOP_COACH_MEMORY: true });
  });
  it("dashboard: the two user gauges (slots 1 and 3) and the pinned list", () => {
    const d = projectDashboard(fixture("dashboard_customize.json"));
    expect(d.gauges).toEqual(["HRV", "SLEEP_PERFORMANCE"]);
    expect(d.pinned.slice(0, 3)).toEqual(["HRV", "RHR", "STEPS"]);
  });
});

describe("whoop_preferences tool", () => {
  it("reads every section by default, compactly", async () => {
    const whoop = mockWhoop(ROUTES);
    const client = await connect(registerPreferences, whoop);
    const result = await client.callTool({ name: "whoop_preferences", arguments: {} });
    const out = parse(result);
    expect(out).toMatchObject({
      journal: { journal_enabled: true },
      notifications: { GPS: true },
      ai: { WHOOP_COACH_MEMORY: true },
      dashboard: { gauges: ["HRV", "SLEEP_PERFORMANCE"] },
      tracked_behaviors: { count: 3, custom: 1 },
    });
    expect(out).not.toHaveProperty("errors");
    expect((result.content as Array<{ text: string }>)[0]!.text.length).toBeLessThan(1500);
  });

  it("reads only the requested section", async () => {
    const whoop = mockWhoop(ROUTES);
    const client = await connect(registerPreferences, whoop);
    const out = parse(await client.callTool({ name: "whoop_preferences", arguments: { include: ["notifications"] } }));
    expect(whoop.get).toHaveBeenCalledTimes(1);
    expect(whoop.get).toHaveBeenCalledWith("/notification-service/v1/notifications/user-settings/bff");
    expect(Object.keys(out).sort()).toEqual(["notifications"]);
  });

  it("degrades a failed section to null with an error, keeping the rest", async () => {
    const whoop = mockWhoop({ ...ROUTES, "/ai-conversation-service/v1/settings": new Error("500") });
    const client = await connect(registerPreferences, whoop);
    const out = parse(await client.callTool({ name: "whoop_preferences", arguments: { include: ["ai", "journal"] } }));
    expect(out).not.toHaveProperty("ai");
    expect(out.journal).toMatchObject({ journal_enabled: true });
    expect(out.errors).toEqual([{ section: "ai", error: "500" }]);
  });

  it("counts tracked behaviours from the customize screen, custom ones included", async () => {
    const whoop = mockWhoop(ROUTES);
    const client = await connect(registerPreferences, whoop);
    const out = parse(await client.callTool({ name: "whoop_preferences", arguments: { include: ["tracked_behaviors"] } }));
    expect(out.tracked_behaviors).toEqual({ count: 3, custom: 1 });
    expect(whoop.get).toHaveBeenCalledWith("/journal-service/v3/journals/behaviors");
  });

  it("reports an error instead of a count when the tracked flags are missing", async () => {
    const whoop = mockWhoop({ ...ROUTES, "/journal-service/v3/journals/behaviors": { grouped_toggles: [{ toggles: [{ id: "1", title: "Alcohol" }] }] } });
    const client = await connect(registerPreferences, whoop);
    const out = parse(await client.callTool({ name: "whoop_preferences", arguments: { include: ["tracked_behaviors"] } }));
    expect(out).not.toHaveProperty("tracked_behaviors");
    expect(out.errors[0]).toMatchObject({ section: "tracked_behaviors" });
  });

  it("stays inside the description budgets", async () => {
    const client = await connect(registerPreferences, mockWhoop({}));
    for (const t of await toolBudget(client)) {
      expect(t.description).toBeLessThanOrEqual(450);
      expect(t.longestDescribe).toBeLessThanOrEqual(60);
    }
  });
});
