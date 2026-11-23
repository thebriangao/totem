// whoop_preferences (R): journal flags, notification namespaces, AI settings,
// home dashboard and the tracked-behaviour count (SPEC.md §3.1).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { PreferencesV2Out } from "../../schemas/settings_v2.js";
import {
  projectAiSettings,
  projectDashboard,
  dashboardOptions,
  projectJournalPrefs,
  projectNotifications,
  projectBehaviorToggles,
} from "../../projections/settings_v2.js";

const NAME = "whoop_preferences";
const SECTIONS = {
  journal: { path: "/journal-service/v1/journals/preferences", project: projectJournalPrefs },
  notifications: { path: "/notification-service/v1/notifications/user-settings/bff", project: projectNotifications },
  ai: { path: "/ai-conversation-service/v1/settings", project: projectAiSettings },
  dashboard: { path: "/home-service/v2/home/dashboard/customize", project: (raw: unknown) => ({ ...projectDashboard(raw), options: dashboardOptions(raw) }) },
  tracked_behaviors: {
    // The customize screen: /activities-service/v1/journals/behaviors/user leaves out custom behaviours.
    path: "/journal-service/v3/journals/behaviors",
    project: (raw: unknown) => {
      const t = projectBehaviorToggles(raw);
      if (!t.complete) throw new Error("WHOOP's behaviour list came back without tracked flags.");
      return { count: t.count, custom: t.custom_count };
    },
  },
} as const;
type Section = keyof typeof SECTIONS;
const ALL = Object.keys(SECTIONS) as [Section, ...Section[]];

export function registerPreferences(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "Account preferences: journal flags, notification namespaces (false = blocked), AI coach settings, the home dashboard (2 focus " +
      "gauges, pinned metrics and the keys to choose from) and how many journal behaviours you track.",
    input: {
      include: z.array(z.enum(ALL)).min(1).optional().describe("Default all"),
    },
    annotations: READ_ONLY,
  }, async ({ include }) => {
    const wanted = [...new Set(include ?? ALL)];
    const errors: Array<{ section: string; error: string }> = [];
    const results = await Promise.all(wanted.map(async (section) => {
      const { path, project } = SECTIONS[section];
      try {
        return [section, project(await client.get(path))] as const;
      } catch (e) {
        errors.push({ section, error: (e as Error).message });
        return [section, null] as const;
      }
    }));
    return respond(NAME, PreferencesV2Out, { ...Object.fromEntries(results), errors });
  });
}
