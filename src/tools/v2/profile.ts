// whoop_profile (R): profile, body data, visibility settings, and on request HR
// zones, entitlements, integrations and community privacy. Absorbs
// whoop_hr_zones (SPEC.md §3.1, D15).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { defineTool, respond } from "../define.js";
import { READ_ONLY } from "../annotations.js";
import { ProfileV2Out } from "../../schemas/profile_v2.js";
import { projectEntitlements, projectIntegrations, projectPrivacy, projectProfileV2 } from "../../projections/profile_v2.js";
import { hrZonesOut, parseHrZones } from "../../projections/settings_v2.js";
import { HIDDEN_METRICS } from "../../lib/profile_settings.js";

const NAME = "whoop_profile";
const INCLUDES = ["hr_zones", "entitlements", "integrations", "privacy"] as const;

export function registerProfile(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "Your profile: name, email, birthday, gender and physiological baseline (as whoop_profile_update takes them), height (m), weight (kg), unit system, location, max/resting HR, membership, hidden metrics and stealth mode. include: hr_zones (zones in bpm, is_custom), entitlements (features that are off, and why), integrations (connected apps), privacy (community sharing, decoded).",
    input: {
      include: z.array(z.enum(INCLUDES)).optional(),
    },
    annotations: READ_ONLY,
  }, async ({ include }) => {
    const wants = new Set(include ?? []);
    const warnings: string[] = [];
    const soft = <T>(label: string, p: Promise<T>): Promise<T | null> =>
      p.catch((e: unknown) => {
        warnings.push(`${label} unavailable: ${(e as Error).message}`);
        return null;
      });

    const [bootstrap, edit, stealth, hidden, zones, settings, entitlements, integrations, privacy] = await Promise.all([
      client.get("/users-service/v2/bootstrap"),
      soft("Profile details", client.get("/profile-service/v1/profile/bff/edit")),
      soft("Stealth mode", client.get("/users-service/v1/stealth-mode")),
      Promise.all(HIDDEN_METRICS.map((m) => client.get(`/users-service/v1/hidden-metrics/${m}`).catch(() => null))),
      wants.has("hr_zones") ? soft("HR zones", client.get("/hr-zones-service/v1/bff/zones")) : null,
      wants.has("hr_zones") ? soft("HR zone settings", client.get("/hr-zones-service/v1/bff/settings")) : null,
      wants.has("entitlements") ? soft("Entitlements", client.get("/entitlement-service/v1/entitlements")) : null,
      wants.has("integrations") ? soft("Integrations", client.get("/integrations-bff/v1/integrations/discovery")) : null,
      wants.has("privacy") ? soft("Privacy settings", client.get("/privacy-service/v1/community/privacy/settings")) : null,
    ]);

    const out: Record<string, unknown> = projectProfileV2({
      bootstrap,
      edit,
      stealth,
      hidden: Object.fromEntries(HIDDEN_METRICS.map((m, i) => [m, hidden[i]])),
    });
    if (wants.has("hr_zones")) out.hr_zones = zones === null && settings === null ? null : hrZonesOut(parseHrZones({ zones, settings }));
    if (wants.has("entitlements")) out.entitlements = entitlements === null ? null : projectEntitlements(entitlements);
    if (wants.has("integrations")) out.integrations = integrations === null ? null : projectIntegrations(integrations);
    if (wants.has("privacy")) out.privacy = privacy === null ? null : projectPrivacy(privacy);
    out.warnings = warnings;
    return respond(NAME, ProfileV2Out, out);
  });
}
