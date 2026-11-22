// whoop_profile include=health. No test account has these features, so the
// locked and empty shapes below are synthetic copies of what WHOOP answered on
// 2026-11-22, and the unlocked ones are invented to exercise the guarded paths.
import { describe, expect, it } from "vitest";
import { registerProfile } from "../../src/tools/v2/profile.js";
import { projectAfib, projectLabs, projectLockable } from "../../src/projections/health_features.js";
import { screenContent } from "../../src/lib/screen_content.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { connect, mockWhoop, parse } from "./journal_profile_helpers.js";

const LOCK = (header: string, description: string) => ({
  locked_icon: "https://app-cdn.prod.whoop.com/tortoise/locked.png",
  header_text_display: header, description_display: description,
  button_style: "DEFAULT", button_text_display: "GOT IT", button_destination: null,
});
const HEALTHSPAN_LOCKED = {
  metadata: null, navigation_title: "HEALTHSPAN", navigation_subtitle: null,
  navigation_destination: { screen: "HEALTHSPAN", parameters: {} },
  unlocked_content: null,
  locked_content: LOCK("21 SLEEPS TO UNLOCK", "Log 21 sleeps in the last month. Keep wearing your WHOOP 24/7 to get insights."),
};
const SAGE_LOCKED = {
  navigation_title: "BLOOD PRESSURE INSIGHTS", navigation_tag: null, navigation_tag_dialog_content: null,
  unlocked_content: null,
  locked_content: LOCK("UPGRADE FOR ACCESS", "Unlock Blood Pressure Insights by upgrading to WHOOP Life."),
};
const biomarker = (id: string, title: string, value: string, unit: string | null, status: string) => ({
  id, title, icon: "CARET_RIGHT", value, unit, trend: null, status_type: status, disclaimer: null,
  destination: { screen: "BIOMARKER_DETAILS", parameters: { source: "biomarker_summary", biomarker_id: id } }, range_meter: null,
});
const labs = (rows: unknown[]) => ({
  metadata: { ai_context_metadata: {} },
  items: [
    { type: "BIOMARKER_PIE_CHART_SECTION", content: { id: "pie", trend_counts: [] } },
    { type: "SEARCHABLE_BIOMARKERS_LIST", content: { biomarkers: rows, statuses: [] } },
  ],
});
const LABS_EMPTY = labs([biomarker("ldl", "LDL Cholesterol", "--", null, "UNAVAILABLE"), biomarker("hba1c", "HbA1c", "--", null, "UNAVAILABLE")]);

const PROFILE = {
  "/users-service/v2/bootstrap": { account: { user_id: 7 }, user: { id: 7 }, profile: { timezone_offset: "-0800" }, membership: {}, bio_data: {} },
  "/profile-service/v1/profile/bff/edit": {},
  "/users-service/v1/stealth-mode": false,
  "/users-service/v1/hidden-metrics/BODY_COMP": { is_hidden: false },
  "/users-service/v1/hidden-metrics/HEALTHSPAN": { is_hidden: false },
};

describe("whoop_profile include=health", () => {
  it("reports locked, empty and not-set-up features without guessing", async () => {
    const whoop = mockWhoop({
      ...PROFILE,
      "/healthspan-service/v1/healthspan/bff": HEALTHSPAN_LOCKED,
      "/sage-service/v1/sage/bff": SAGE_LOCKED,
      "/advanced-labs-service/v1/advanced-labs/biomarkers/summary": LABS_EMPTY,
      "/arrhythmia-service/v2/afibhistory/screen": new WhoopApiError(404, "/arrhythmia-service/v2/afibhistory/screen", "No anf user found for userId 7"),
    });
    const out = parse(await (await connect(registerProfile, whoop)).callTool({ name: "whoop_profile", arguments: { include: ["health"] } }));
    expect(out.health).toEqual({
      healthspan: { status: "locked", message: "21 SLEEPS TO UNLOCK: Log 21 sleeps in the last month. Keep wearing your WHOOP 24/7 to get insights." },
      blood_pressure: { status: "locked", message: "UPGRADE FOR ACCESS: Unlock Blood Pressure Insights by upgrading to WHOOP Life." },
      advanced_labs: { status: "no_data", message: expect.stringContaining("No lab results") },
      afib: { status: "not_set_up", message: "Not set up on this account." },
    });
  });

  it("isn't read unless asked", async () => {
    const whoop = mockWhoop(PROFILE);
    const out = parse(await (await connect(registerProfile, whoop)).callTool({ name: "whoop_profile", arguments: {} }));
    expect(out).not.toHaveProperty("health");
    expect(whoop.get.mock.calls.map((c) => c[0])).not.toContain("/healthspan-service/v1/healthspan/bff");
  });

  it("keeps the other features when one read fails", async () => {
    const whoop = mockWhoop({
      ...PROFILE,
      "/healthspan-service/v1/healthspan/bff": new Error("boom"),
      "/sage-service/v1/sage/bff": SAGE_LOCKED,
      "/advanced-labs-service/v1/advanced-labs/biomarkers/summary": LABS_EMPTY,
      "/arrhythmia-service/v2/afibhistory/screen": { title: "AFib history" },
    });
    const out = parse(await (await connect(registerProfile, whoop)).callTool({ name: "whoop_profile", arguments: { include: ["health"] } }));
    const health = out.health as Record<string, { status: string }>;
    expect(health.healthspan).toEqual({ status: "unavailable", message: "boom" });
    expect(health.blood_pressure!.status).toBe("locked");
    expect(health.afib).toMatchObject({ status: "available", unverified: true, content: { title: "AFib history" } });
  });
});

describe("health feature projections", () => {
  it("passes an unlocked screen through as unverified content without UI plumbing", () => {
    const out = projectLockable({
      unlocked_content: {
        header: { title_display: "WHOOP AGE", value_display: "31.2", icon_url: "https://x/i.png", text_color: "#fff" },
        pace: { label: "Pace of aging", value: 0.8, destination: { screen: "X" } },
      },
      locked_content: null,
    });
    expect(out).toEqual({
      status: "available", unverified: true,
      content: { header: { title_display: "WHOOP AGE", value_display: "31.2" }, pace: { label: "Pace of aging", value: 0.8 } },
    });
  });

  it("lists only the lab biomarkers that have a result", () => {
    const out = projectLabs(labs([
      biomarker("ldl", "LDL Cholesterol", "92", "mg/dL", "OPTIMAL"),
      biomarker("hba1c", "HbA1c", "--", null, "UNAVAILABLE"),
      biomarker("vitd", "Vitamin D", "24", "ng/mL", "OUT_OF_RANGE"),
    ]));
    expect(out).toEqual({
      status: "available", unverified: true,
      biomarkers: [
        { id: "ldl", name: "LDL Cholesterol", value: "92", unit: "mg/dL", status: "OPTIMAL" },
        { id: "vitd", name: "Vitamin D", value: "24", unit: "ng/mL", status: "OUT_OF_RANGE" },
      ],
    });
    expect(projectLabs({ items: [] }).status).toBe("unavailable");
  });

  it("says when WHOOP sends neither content nor a lock", () => {
    expect(projectLockable({ unlocked_content: null, locked_content: null }).status).toBe("unavailable");
    expect(projectAfib({}).status).toBe("available");
  });
});

describe("screenContent", () => {
  it("caps big screens by cutting lists, and says so", () => {
    const big = { rows: Array.from({ length: 200 }, (_, i) => ({ label: `Row ${i}`, value: i, image_url: "https://x" })) };
    const { content, truncated } = screenContent(big, 500);
    expect(truncated).toBe(true);
    expect(JSON.stringify(content).length).toBeLessThanOrEqual(500);
    expect((content as { rows: unknown[] }).rows[0]).toEqual({ label: "Row 0", value: 0 });
  });

  it("shortens long strings and drops empty branches", () => {
    const { content, truncated } = screenContent({ a: "x".repeat(400), b: { icon: "i", style: "s" }, c: [null, ""], d: 0 });
    expect(truncated).toBe(false);
    expect(content).toEqual({ a: `${"x".repeat(300)}…`, d: 0 });
  });
});
