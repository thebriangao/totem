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
  projectJournalPrefs,
  projectNotifications,
  projectBehaviorToggles,
} from "../../projections/settings_v2.js";

const NAME = "whoop_preferences";
const SECTIONS = {
  journal: { path: "/journal-service/v1/journals/preferences", project: projectJournalPrefs },
  notifications: { path: "/notification-service/v1/notifications/user-settings/bff", project: projectNotifications },
  ai: { path: "/ai-conversation-service/v1/settings", project: projectAiSettings },
  dashboard: { path: "/home-service/v2/home/dashboard/customize", project: projectDashboard },
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
      "Account preferences in one read: journal flags, notification namespaces (false = blocked), AI coach settings, the home dashboard (your 2 focus gauges and pinned metrics) and how many journal behaviours you track. include narrows the sections. Change them with whoop_preferences_set.",
    input: {
      include: z.array(z.enum(ALL)).min(1).optional().describe("Sections to read; default all."),
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
