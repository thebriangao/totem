import { describe, expect, it } from "vitest";
import { registerProfile } from "../../src/tools/v2/profile.js";
import { hrZonesOut, parseHrZones } from "../../src/projections/settings_v2.js";
import { projectEntitlements, projectIntegrations, projectPrivacy } from "../../src/projections/profile_v2.js";
import { decodePrivacyPillar } from "../../src/lib/profile_settings.js";
import { connect, fixture, mockWhoop, parse, toolBudget } from "./journal_profile_helpers.js";

// Synthetic, shaped like the 2026-11 responses.
const BOOTSTRAP = {
  account: { id: 9, username: "tester", email: "tester@example.com", user_id: 7 },
  user: { id: 7, first_name: "Test", last_name: "User", country: "US", city: "Springfield", admin_division: "IL" },
  profile: { height: 1.8, weight: 80.5, gender: "i prefer not to choose", unit_system: "metric", birthday: "1990-05-05T07:00:00.000Z", timezone_offset: "-0800", physiological_baseline: null, fitness_level: "recreational_enthusiast" },
  membership: { status: "active", in_effect: true },
  bio_data: { max_heart_rate: 185, min_heart_rate: 50, resting_heart_rate: 52 },
};
const EDIT = {
  first_name: "Test", last_name: "User", email: "tester@example.com", city: "Springfield", country: "US", state: "IL",
  height: 1.8, weight: 80.5, birthday: "1990-05-05", unit_system: "metric", gender: "PREFER_NOT", physiological_baseline: "FEMALE",
  locked_fields: [], countries: [{ name: "Afghanistan", country_code: "AF" }],
};
const BASE = {
  "/users-service/v2/bootstrap": BOOTSTRAP,
  "/profile-service/v1/profile/bff/edit": EDIT,
  "/users-service/v1/stealth-mode": true,
  "/users-service/v1/hidden-metrics/BODY_COMP": { is_hidden: true },
  "/users-service/v1/hidden-metrics/HEALTHSPAN": { is_hidden: false },
};

describe("whoop_profile tool", () => {
  it("returns PUT-format fields from the edit screen, stealth as a bare boolean, hidden metrics as a list", async () => {
    const whoop = mockWhoop(BASE);
    const client = await connect(registerProfile, whoop);
    const result = await client.callTool({ name: "whoop_profile", arguments: {} });
    const out = parse(result);
    expect(out).toMatchObject({
      user_id: 7, gender: "PREFER_NOT", physiological_baseline: "FEMALE", birthday: "1990-05-05",
      height_m: 1.8, weight_kg: 80.5, state: "IL", tz_offset: "-0800", max_hr: 185, resting_hr: 52,
      membership: "active", hidden_metrics: ["BODY_COMP"], stealth: true,
    });
    expect(out).not.toHaveProperty("hr_zones");
    expect(whoop.get).toHaveBeenCalledTimes(5);
    expect((result.content as Array<{ text: string }>)[0]!.text.length).toBeLessThan(1500);
  });

  it("falls back to bootstrap when the edit screen fails, but never to its display-string gender", async () => {
    const whoop = mockWhoop({ ...BASE, "/profile-service/v1/profile/bff/edit": new Error("down") });
    const client = await connect(registerProfile, whoop);
    const out = parse(await client.callTool({ name: "whoop_profile", arguments: {} }));
    expect(out).toMatchObject({ first_name: "Test", state: "IL", birthday: "1990-05-05" });
    expect(out).not.toHaveProperty("gender");
    expect(out).not.toHaveProperty("physiological_baseline");
    expect(out.warnings.join(" ")).toMatch(/Profile details unavailable/);
  });

  it("says so when a hidden-metric read fails, instead of looking like nothing is hidden", async () => {
    // jsonOut drops an empty hidden_metrics list, so without a warning "unknown" reads as "none hidden".
    const whoop = mockWhoop({ ...BASE, "/users-service/v1/hidden-metrics/BODY_COMP": new Error("down") });
    const client = await connect(registerProfile, whoop);
    const out = parse(await client.callTool({ name: "whoop_profile", arguments: {} }));
    expect(out).not.toHaveProperty("hidden_metrics");
    expect(out.warnings.join(" ")).toMatch(/BODY_COMP unavailable/);
  });

  it("adds the requested includes", async () => {
    const whoop = mockWhoop({
      ...BASE,
      "/hr-zones-service/v1/bff/zones": fixture("hr_zones.json"),
      "/hr-zones-service/v1/bff/settings": fixture("hr_settings_custom.json"),
      "/entitlement-service/v1/entitlements": fixture("entitlements.json"),
      "/integrations-bff/v1/integrations/discovery": fixture("integrations_discovery.json"),
      "/privacy-service/v1/community/privacy/settings": fixture("privacy_settings.json"),
    });
    const client = await connect(registerProfile, whoop);
    const out = parse(await client.callTool({ name: "whoop_profile", arguments: { include: ["hr_zones", "entitlements", "integrations", "privacy"] } }));
    expect(out.hr_zones).toMatchObject({ is_custom: true, max_hr: 165 });
    expect(out.entitlements.off).toHaveProperty("bp_trends");
    expect(out.integrations.available).toContain("APPLE HEALTH");
    expect(out.privacy.sleep).toEqual({ to: "no_one", trends: true, daily: false });
  });

  it("stays inside the description budgets", async () => {
    const client = await connect(registerProfile, mockWhoop({}));
    for (const t of await toolBudget(client)) {
      expect(t.description).toBeLessThanOrEqual(600);
      expect(t.longestDescribe).toBeLessThanOrEqual(80);
    }
  });
});

describe("profile projections", () => {
  it("HR zones: is_custom comes from the settings toggle, zones from the form rows", () => {
    const custom = hrZonesOut(parseHrZones({ zones: fixture("hr_zones.json"), settings: fixture("hr_settings_custom.json") }));
    expect(custom).toMatchObject({ is_custom: true, max_hr: 165, resting_hr: 57 });
    expect(custom.zones).toEqual({ Z0: [0, 102], Z1: [100, 120], Z2: [121, 135], Z3: [136, 150], Z4: [151, 160], Z5: [161, 165] });
    expect(custom.defaults).toMatchObject({ Z1: [100, 122], Z5: [155, 165] });
    const auto = hrZonesOut(parseHrZones({ zones: fixture("hr_zones.json"), settings: fixture("hr_settings_default.json") }));
    expect(auto).toMatchObject({ is_custom: false, max_hr: 172, defaults: null });
    expect(auto.zones.Z5).toEqual([161, 172]);
  });

  it("entitlements: count on, reasons for off", () => {
    const e = projectEntitlements(fixture("entitlements.json"));
    expect(e.on).toBeGreaterThan(20);
    expect(e.off.bp_trends).toBe("MEMBERSHIP_TYPE: needs MEDICARE (has SUBSCRIBER)");
    expect(e.off.shepherd).toMatch(/^MEMBERSHIP_TIER: needs WHOOP Life \(has WHOOP Peak\); STRAP_TYPE/);
  });

  it("integrations never carry OAuth URLs", () => {
    const out = projectIntegrations({
      integrations: [{ tabs: [
        { id: "strava", title_display: "STRAVA", connected: true, connection_url: "https://x/oauth?state=abc&user=7" },
        { id: "zwift", reporting_key: "Zwift", connected: false, cta_connection_url: "https://y?state=1" },
      ] }],
    });
    expect(out).toEqual({ connected: ["STRAVA"], available: ["Zwift"] });
    expect(JSON.stringify(out)).not.toMatch(/state=|https/);
  });

  it("privacy pillars decode their composite strings", () => {
    expect(decodePrivacyPillar("no_one")).toEqual({ audience: "no_one", trends: true, daily_stats: true });
    expect(decodePrivacyPillar("friends_no_daily_stats")).toEqual({ audience: "friends", trends: true, daily_stats: false });
    expect(decodePrivacyPillar("friends_no_trends")).toEqual({ audience: "friends", trends: false, daily_stats: true });
    expect(decodePrivacyPillar("friends_score_only")).toEqual({ audience: "friends", trends: false, daily_stats: false });
    expect(decodePrivacyPillar("bogus")).toBeNull();
    const p = projectPrivacy(fixture("privacy_settings.json"));
    expect(p).toMatchObject({ searchable: false, visibility: { age: "no_one", community_list: "friends" }, recovery: { to: "no_one" }, activity_overrides: null });
  });
});
