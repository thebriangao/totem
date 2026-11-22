// whoop_profile (R): profile, body data, visibility settings, and on request HR
// zones, entitlements, integrations, community privacy and the paid health
// features (Healthspan, blood pressure, Advanced Labs, AFib). Absorbs
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
import { projectAfib, projectLabs, projectLockable, type HealthFeature } from "../../projections/health_features.js";
import { WhoopApiError, WhoopAuthExpiredError } from "../../whoop/errors.js";
import { todayIso } from "../../lib/dates.js";

const NAME = "whoop_profile";
const INCLUDES = ["hr_zones", "entitlements", "integrations", "privacy", "health"] as const;

/** One health feature: its projection, or why it couldn't be read. */
async function feature(read: Promise<unknown>, project: (raw: unknown) => HealthFeature): Promise<HealthFeature> {
  try {
    return project(await read);
  } catch (e) {
    if (e instanceof WhoopAuthExpiredError) throw e;
    // AFib answers 404 "No anf user found" until the member sets it up.
    if (e instanceof WhoopApiError && e.status === 404) return { status: "not_set_up", message: "Not set up on this account." };
    return { status: "unavailable", message: (e as Error).message };
  }
}

async function readHealth(client: WhoopClient) {
  const date = todayIso();
  const [healthspan, blood_pressure, advanced_labs, afib] = await Promise.all([
    feature(client.get("/healthspan-service/v1/healthspan/bff", { date }), projectLockable),
    feature(client.get("/sage-service/v1/sage/bff", { date }), projectLockable),
    feature(client.get("/advanced-labs-service/v1/advanced-labs/biomarkers/summary"), projectLabs),
    feature(client.get("/arrhythmia-service/v2/afibhistory/screen"), projectAfib),
  ]);
  return { healthspan, blood_pressure, advanced_labs, afib };
}

export function registerProfile(server: McpServer, client: WhoopClient): void {
  defineTool(server, {
    name: NAME,
    description:
      "Your profile: name, email, birthday, gender, physiological baseline, height (m), weight (kg), unit system, location, max and " +
      "resting HR, membership, hidden metrics and stealth mode. include adds hr_zones (bpm), entitlements (off features and why), " +
      "integrations, community privacy and health (Healthspan, blood pressure, labs, AFib).",
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

    const [bootstrap, edit, stealth, hidden, zones, settings, entitlements, integrations, privacy, health] = await Promise.all([
      client.get("/users-service/v2/bootstrap"),
      soft("Profile details", client.get("/profile-service/v1/profile/bff/edit")),
      soft("Stealth mode", client.get("/users-service/v1/stealth-mode")),
      // A failed read must not look like "not hidden": say so.
      Promise.all(HIDDEN_METRICS.map((m) => soft(`Hidden-metric state for ${m}`, client.get(`/users-service/v1/hidden-metrics/${m}`)))),
      wants.has("hr_zones") ? soft("HR zones", client.get("/hr-zones-service/v1/bff/zones")) : null,
      wants.has("hr_zones") ? soft("HR zone settings", client.get("/hr-zones-service/v1/bff/settings")) : null,
      wants.has("entitlements") ? soft("Entitlements", client.get("/entitlement-service/v1/entitlements")) : null,
      wants.has("integrations") ? soft("Integrations", client.get("/integrations-bff/v1/integrations/discovery")) : null,
      wants.has("privacy") ? soft("Privacy settings", client.get("/privacy-service/v1/community/privacy/settings")) : null,
      wants.has("health") ? readHealth(client) : null,
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
    if (health) out.health = health;
    out.warnings = warnings;
    return respond(NAME, ProfileV2Out, out);
  });
}
