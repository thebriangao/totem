import { describe, expect, it } from "vitest";
import { registerHrZonesSet, validateCustomZones } from "../../src/tools/v2/hr_zones_set.js";
import { connect, fixture, mockWhoop, parse, toolBudget } from "./journal_profile_helpers.js";

const ZONES = "/hr-zones-service/v1/bff/zones";
const SETTINGS = "/hr-zones-service/v1/bff/settings";
const seq = (...values: unknown[]) => (n: number) => values[Math.min(n, values.length) - 1];
const auto = () => fixture("hr_settings_default.json"); // max HR 172, not custom
const custom = () => fixture("hr_settings_custom.json"); // max HR 165, custom Z1 100-120 … Z5 161-165

/** Settings with a different max HR (maxhr read-back). */
function withMax(settings: any, max: number) {
  settings.heart_rate_entry_row.find((r: { id: string }) => r.id === "MAX_HR").value = max;
  return settings;
}

async function call(whoop: ReturnType<typeof mockWhoop>, args: Record<string, unknown>) {
  const client = await connect(registerHrZonesSet, whoop);
  const result = await client.callTool({ name: "whoop_hr_zones_set", arguments: { confirm: true, ...args } });
  return { result, out: parse(result) };
}

describe("whoop_hr_zones_set", () => {
  it("max_hr posts the new max and verifies it from settings", async () => {
    const whoop = mockWhoop({ [ZONES]: fixture("hr_zones.json"), [SETTINGS]: seq(auto(), withMax(auto(), 180)) });
    const { out } = await call(whoop, { action: "max_hr", max_heart_rate: 180 });
    expect(whoop.post).toHaveBeenCalledWith("/hr-zones-service/v1/maxhr", { max_heart_rate: 180 });
    expect(out).toMatchObject({ updated: true, verified: true, before: { max_hr: 172 }, after: { max_hr: 180 } });
  });

  it("max_hr warns that custom zones stay in force", async () => {
    const whoop = mockWhoop({ [ZONES]: fixture("hr_zones.json"), [SETTINGS]: seq(custom(), withMax(custom(), 170)) });
    const { out } = await call(whoop, { action: "max_hr", max_heart_rate: 170 });
    expect(out.warnings.join(" ")).toMatch(/custom, so they stay in force/);
  });

  it("custom posts contiguous zones and reads is_custom back", async () => {
    const zones = [[100, 120], [121, 135], [136, 150], [151, 160], [161, 165]];
    const whoop = mockWhoop({ [ZONES]: fixture("hr_zones.json"), [SETTINGS]: seq(auto(), custom()) });
    const { out } = await call(whoop, { action: "custom", zones });
    expect(whoop.post).toHaveBeenCalledWith("/hr-zones-service/v1/bff/custom", {
      zones: [
        { id: "ZONE_1", min: 100, max: 120 }, { id: "ZONE_2", min: 121, max: 135 }, { id: "ZONE_3", min: 136, max: 150 },
        { id: "ZONE_4", min: 151, max: 160 }, { id: "ZONE_5", min: 161, max: 165 },
      ],
      is_custom: true,
    });
    expect(out).toMatchObject({ verified: true, after: { is_custom: true } });
  });

  it("reset sends WHOOP's default zones with is_custom:false", async () => {
    const restored = auto();
    const whoop = mockWhoop({ [ZONES]: fixture("hr_zones.json"), [SETTINGS]: seq(custom(), { ...restored, default_hr_zones: custom().default_hr_zones, manual_heart_rate_zones_form: { ...restored.manual_heart_rate_zones_form, zone_rows: custom().default_hr_zones } }) });
    const { out } = await call(whoop, { action: "reset" });
    expect(whoop.post).toHaveBeenCalledWith("/hr-zones-service/v1/bff/custom", {
      zones: [
        { id: "ZONE_1", min: 100, max: 122 }, { id: "ZONE_2", min: 123, max: 132 }, { id: "ZONE_3", min: 133, max: 143 },
        { id: "ZONE_4", min: 144, max: 154 }, { id: "ZONE_5", min: 155, max: 165 },
      ],
      is_custom: false,
    });
    expect(out).toMatchObject({ verified: true, after: { is_custom: false } });
  });

  it("does nothing when already at the requested state", async () => {
    const whoop = mockWhoop({ [ZONES]: fixture("hr_zones.json"), [SETTINGS]: auto() });
    expect((await call(whoop, { action: "reset" })).out).toMatchObject({ no_change: true });
    expect((await call(whoop, { action: "max_hr", max_heart_rate: 172 })).out).toMatchObject({ no_change: true });
    expect(whoop.post).not.toHaveBeenCalled();
  });

  it("refuses reset when the defaults can't be read", async () => {
    const whoop = mockWhoop({ [ZONES]: new Error("x"), [SETTINGS]: new Error("x") });
    const { result } = await call(whoop, { action: "reset" });
    expect(result.isError).toBe(true);
    expect(whoop.post).not.toHaveBeenCalled();
  });

  it("refuses Z5 above max HR", async () => {
    const whoop = mockWhoop({ [ZONES]: fixture("hr_zones.json"), [SETTINGS]: auto() });
    const { result } = await call(whoop, { action: "custom", zones: [[100, 120], [121, 135], [136, 150], [151, 160], [161, 190]] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/above your max HR 172/);
  });

  it("validates contiguity, order and count (S7)", () => {
    expect(validateCustomZones([[100, 120], [121, 135], [136, 150], [151, 160], [161, 170]], 172)).toBeNull();
    expect(validateCustomZones([[100, 115], [121, 135], [136, 150], [151, 160], [161, 170]], null)).toMatch(/contiguous.*Z2 has to start at 116/);
    expect(validateCustomZones([[100, 125], [121, 135], [136, 150], [151, 160], [161, 170]], null)).toMatch(/contiguous/);
    expect(validateCustomZones([[100, 120], [121, 135], [136, 150], [151, 160]], null)).toMatch(/exactly 5/);
    expect(validateCustomZones([[120, 100], [101, 135], [136, 150], [151, 160], [161, 170]], null)).toMatch(/min below max/);
  });

  it("refuses bad input before any request", async () => {
    for (const args of [
      { action: "max_hr" },
      { action: "max_hr", max_heart_rate: 100 },
      { action: "max_hr", max_heart_rate: 221 },
      { action: "custom" },
      { action: "custom", zones: [[100, 115], [121, 135], [136, 150], [151, 160], [161, 170]] },
      { action: "reset", zones: [[1, 2]] },
    ]) {
      const whoop = mockWhoop({});
      const { result } = await call(whoop, args);
      expect(result.isError).toBe(true);
      expect(whoop.get).not.toHaveBeenCalled();
    }
  });

  it("previews without writing", async () => {
    const whoop = mockWhoop({ [ZONES]: fixture("hr_zones.json"), [SETTINGS]: auto() });
    const { out } = await call(whoop, { action: "max_hr", max_heart_rate: 180, confirm: false });
    expect(whoop.post).not.toHaveBeenCalled();
    expect(out).toMatchObject({ preview: true, will_execute: { method: "POST", path: "/hr-zones-service/v1/maxhr" } });
  });

  it("stays inside the description budgets", async () => {
    const client = await connect(registerHrZonesSet, mockWhoop({}));
    for (const t of await toolBudget(client)) {
      expect(t.description).toBeLessThanOrEqual(600);
      expect(t.longestDescribe).toBeLessThanOrEqual(80);
    }
  });
});
