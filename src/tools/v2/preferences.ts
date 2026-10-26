import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { jsonOut } from "../../whoop/json_out.js";
import { asArray, asBool, asString, isObject } from "../../lib/walk.js";
import { PreferencesOut } from "../../schemas/compact.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { READ_ONLY } from "../annotations.js";

/** Compact, read-only account preferences that otherwise require raw API calls. */
export function registerPreferences(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_preferences",
    "Read compact account preferences: journal enabled state and/or notification switches. Read-only; omit sections you do not need.",
    {
      include: z.array(z.enum(["journal", "notifications"])).min(1).max(2).default(["journal", "notifications"]),
    },
    READ_ONLY,
    async ({ include }) => {
      const wantsJournal = include.includes("journal");
      const wantsNotifications = include.includes("notifications");
      const [journal, notifications] = await Promise.all([
        wantsJournal ? client.get("/journal-service/v1/journals/preferences") : Promise.resolve(null),
        wantsNotifications ? client.get("/notification-service/v1/notifications/user-settings/bff") : Promise.resolve(null),
      ]);
      const journalRoot = isObject(journal) ? journal : {};
      const notificationRoot = isObject(notifications) ? notifications : {};
      const settings = asArray(notificationRoot.settings).flatMap((setting) => {
        if (!isObject(setting)) return [];
        return [{
          namespace: asString(setting.push_namespace),
          title: asString(setting.title),
          enabled: asBool(setting.active),
        }];
      });
      const out = {
        ...(wantsJournal ? { journal_enabled: asBool(journalRoot.journal_enabled) } : {}),
        ...(wantsNotifications ? { notifications: settings } : {}),
      };
      try {
        return { content: [{ type: "text", text: jsonOut(PreferencesOut.parse(out)) }] };
      } catch (error) {
        if (error instanceof z.ZodError) throw new WhoopProjectionError("whoop_preferences", error);
        throw error;
      }
    },
  );
}
