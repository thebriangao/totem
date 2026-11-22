import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPreferencesSet } from "../../src/tools/v2/preferences_set.js";
import { zoneOffset } from "../../src/lib/profile_settings.js";
import { connect, fixture, mockWhoop, parse, toolBudget } from "./journal_profile_helpers.js";

const DASH_READ = "/home-service/v2/home/dashboard/customize";
const DASH_WRITE = "/user-preferences-service/v1/home/dashboard/customize";
const NOTIF = "/notification-service/v1/notifications/user-settings/bff";
const BLOCK = "/notification-service/v1/notifications/user-settings/block/namespace";
const TRACKED = "/activities-service/v1/journals/behaviors/user";
const CUSTOMIZE = "/journal-service/v3/journals/behaviors";

async function call(whoop: ReturnType<typeof mockWhoop>, args: Record<string, unknown>) {
  const client = await connect(registerPreferencesSet, whoop);
  const result = await client.callTool({ name: "whoop_preferences_set", arguments: { confirm: true, ...args } });
  return { result, out: parse(result) };
}
const seq = (...values: unknown[]) => (n: number) => values[Math.min(n, values.length) - 1];

afterEach(() => vi.unstubAllEnvs());

describe("whoop_preferences_set: hidden_metric, stealth", () => {
  it("hides a metric with POST and reads it back", async () => {
    const whoop = mockWhoop({ "/users-service/v1/hidden-metrics/BODY_COMP": seq({ is_hidden: false }, { is_hidden: true }) });
    const { out } = await call(whoop, { setting: "hidden_metric", metric: "BODY_COMP", hidden: true });
    expect(whoop.post).toHaveBeenCalledWith("/users-service/v1/hidden-metrics/BODY_COMP", undefined);
    expect(out).toMatchObject({ updated: true, verified: true, before: { hidden: false }, after: { hidden: true } });
  });

  it("does nothing when the metric is already in that state", async () => {
    const whoop = mockWhoop({ "/users-service/v1/hidden-metrics/HEALTHSPAN": { is_hidden: false } });
    const { out } = await call(whoop, { setting: "hidden_metric", metric: "HEALTHSPAN", hidden: false });
    expect(whoop.delete).not.toHaveBeenCalled();
    expect(out).toMatchObject({ updated: false, no_change: true });
  });

  it("refuses metrics outside the closed enum (WHOOP stores any string)", async () => {
    const whoop = mockWhoop({});
    const { result } = await call(whoop, { setting: "hidden_metric", metric: "NOT_A_METRIC", hidden: true });
    expect(result.isError).toBe(true);
    expect(whoop.post).not.toHaveBeenCalled();
  });

  it("turns stealth off with a bare false and on with {enabled:true}", async () => {
    const off = mockWhoop({ "/users-service/v1/stealth-mode": seq(true, false) });
    expect((await call(off, { setting: "stealth", enabled: false })).out).toMatchObject({ verified: true });
    expect(off.put).toHaveBeenCalledWith("/users-service/v1/stealth-mode", false);
    const on = mockWhoop({ "/users-service/v1/stealth-mode": seq(false, true) });
    await call(on, { setting: "stealth", enabled: true });
    expect(on.put).toHaveBeenCalledWith("/users-service/v1/stealth-mode", { enabled: true });
  });

  it("refuses inputs that belong to another setting", async () => {
    const whoop = mockWhoop({});
    const { result } = await call(whoop, { setting: "stealth", enabled: true, metric: "BODY_COMP" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/doesn't take metric/);
  });
});

describe("whoop_preferences_set: dashboard", () => {
  const dash = fixture("dashboard_customize.json");
  const after = (gauges: string[], pinned: string[]) => ({
    gauge_metrics: [{ index: 0, metric: "RECOVERY" }, { index: 1, metric: gauges[0] }, { index: 2, metric: "DAY_STRAIN" }, { index: 3, metric: gauges[1] }],
    pinned_metrics_section: { metrics: pinned.map((metric, index) => ({ index, metric })) },
  });

  it("always sends both lists: changing gauges keeps the current pinned order", async () => {
    const pinned = dash.pinned_metrics_section.metrics.map((m: { metric: string }) => m.metric);
    const whoop = mockWhoop({ [DASH_READ]: seq(dash, after(["RHR", "STEPS"], pinned)) });
    const { out } = await call(whoop, { setting: "dashboard", gauges: ["RHR", "STEPS"] });
    expect(whoop.put).toHaveBeenCalledWith(DASH_WRITE, { gauge_metrics: ["RHR", "STEPS"], pinned_metrics: pinned });
    expect(out).toMatchObject({ verified: true, after: { gauges: ["RHR", "STEPS"] } });
  });

  it("refuses to send one list when the other can't be read (WHOOP would reset it)", async () => {
    const whoop = mockWhoop({ [DASH_READ]: new Error("down") });
    const { result } = await call(whoop, { setting: "dashboard", pinned: ["HRV"] });
    expect(result.isError).toBe(true);
    expect(whoop.put).not.toHaveBeenCalled();
  });

  it("only writes metrics the live dashboard screen offers, not everything in WHOOP's KeyMetric enum", async () => {
    // KEY_METRICS came from a 400's enum list; the app only ever sends what its own screen offers
    // (gauges: bottom_sheet_metrics; pinned: the pinned + unpinned sections). CGM, PREGNANCY_WEEK and
    // STRESS_MONITOR are enum values this account's gauge picker doesn't have.
    for (const args of [
      { gauges: ["CGM", "HRV"] },
      { gauges: ["STRESS_MONITOR", "HRV"] },
      { pinned: ["HRV", "PREGNANCY_WEEK"] },
    ]) {
      const whoop = mockWhoop({ [DASH_READ]: dash });
      const { result, out } = await call(whoop, { setting: "dashboard", ...args });
      expect(result.isError).toBe(true);
      expect(out.error).toMatch(/doesn't offer/);
      expect(whoop.put).not.toHaveBeenCalled();
    }
    // Offered ones still go through: WEIGHT as a gauge, RECOVERY pinned.
    const pinned = ["RECOVERY", "HRV"];
    const whoop = mockWhoop({ [DASH_READ]: seq(dash, after(["WEIGHT", "STEPS"], pinned)) });
    const { out } = await call(whoop, { setting: "dashboard", gauges: ["WEIGHT", "STEPS"], pinned });
    expect(whoop.put).toHaveBeenCalledWith(DASH_WRITE, { gauge_metrics: ["WEIGHT", "STEPS"], pinned_metrics: pinned });
    expect(out.verified).toBe(true);
  });

  it("refuses when the dashboard can't be read, even with both lists passed (nothing to check them against)", async () => {
    const whoop = mockWhoop({ [DASH_READ]: new Error("down") });
    const { result } = await call(whoop, { setting: "dashboard", gauges: ["RHR", "STEPS"], pinned: ["HRV"] });
    expect(result.isError).toBe(true);
    expect(whoop.put).not.toHaveBeenCalled();
  });

  it("requires exactly two gauges, never the fixed ones, no duplicates", async () => {
    for (const gauges of [["RHR"], ["RHR", "STEPS", "HRV"], ["RECOVERY", "HRV"], ["HRV", "HRV"]]) {
      const whoop = mockWhoop({ [DASH_READ]: dash });
      const { result } = await call(whoop, { setting: "dashboard", gauges });
      expect(result.isError).toBe(true);
      expect(whoop.put).not.toHaveBeenCalled();
    }
  });
});

describe("whoop_preferences_set: notification, journal_prefs", () => {
  const notif = (gps: boolean) => ({ settings: [{ push_namespace: "GPS", active: gps }, { push_namespace: "CheckIn", active: true }] });

  it("blocks a namespace with PUT and unblocks with DELETE", async () => {
    const block = mockWhoop({ [NOTIF]: seq(notif(true), notif(false)) });
    expect((await call(block, { setting: "notification", namespace: "GPS", enabled: false })).out).toMatchObject({ verified: true });
    expect(block.put).toHaveBeenCalledWith(BLOCK, { namespace: "GPS" });
    const unblock = mockWhoop({ [NOTIF]: seq(notif(false), notif(true)) });
    await call(unblock, { setting: "notification", namespace: "GPS", enabled: true });
    expect(unblock.delete).toHaveBeenCalledWith(`${BLOCK}/GPS`);
  });

  it("refuses a namespace in the wrong case", async () => {
    const whoop = mockWhoop({});
    const { result } = await call(whoop, { setting: "notification", namespace: "gps", enabled: false });
    expect(result.isError).toBe(true);
  });

  it("always includes journal_enabled in the journal prefs PUT", async () => {
    const prefs = fixture("journal_preferences.json");
    const whoop = mockWhoop({ "/journal-service/v1/journals/preferences": seq(prefs, { ...prefs, journal_autopop_enabled: false }) });
    const { out } = await call(whoop, { setting: "journal_prefs", journal_autopop_enabled: false });
    expect(whoop.put).toHaveBeenCalledWith("/journal-service/v1/journals/preferences", { journal_enabled: true, journal_autopop_enabled: false });
    expect(out.verified).toBe(true);
  });

  it("refuses journal prefs when journal_enabled can't be read and wasn't passed", async () => {
    const whoop = mockWhoop({ "/journal-service/v1/journals/preferences": new Error("down") });
    const { result } = await call(whoop, { setting: "journal_prefs", ai_autopop_enabled: false });
    expect(result.isError).toBe(true);
    expect(whoop.put).not.toHaveBeenCalled();
  });
});

describe("whoop_preferences_set: tracked_behaviors", () => {
  // Shaped like the live account (2026-11-21): the customize screen lists every
  // behaviour with `selected`; the activities-service list has stock behaviours
  // only and never shows a custom one, tracked or not.
  const NAMES: Record<number, [string, string]> = {
    1: ["Alcohol", "alcohol"], 2: ["Caffeine", "caffeine"], 3: ["Marijuana", "marijuana"],
    171: ["Momentous Sleep Pack", "momentous-sleep-pack"], 163752: ["Probe Hip Mobility", "Probe Hip Mobility"],
  };
  const screen = (state: Record<number, boolean>) => ({
    grouped_toggles: [{
      title: "NOT SELECTED",
      toggles: Object.entries(state).map(([id, selected]) => ({
        id, title: NAMES[Number(id)]![0], internal_name: NAMES[Number(id)]![1], subtitle: "?", selected, custom: Number(id) === 163752,
      })),
    }],
  });
  const stockList = (ids: number[]) => ({ total_count: ids.length, offset: ids.length, records: ids.map((id) => ({ id })) });
  const routes = (before: Record<number, boolean>, after: Record<number, boolean>) => ({
    [CUSTOMIZE]: seq(screen(before), screen(after)),
    [TRACKED]: stockList(Object.entries(before).filter(([id, sel]) => sel && Number(id) !== 163752).map(([id]) => Number(id))),
  });

  it("read-modify-writes the full id list as strings", async () => {
    const whoop = mockWhoop(routes({ 1: true, 2: true, 171: true, 3: false }, { 1: true, 2: false, 171: true, 3: true }));
    const { out } = await call(whoop, { setting: "tracked_behaviors", untrack: ["Caffeine"], track: [3] });
    expect(whoop.put).toHaveBeenCalledWith(TRACKED, ["1", "171", "3"]);
    expect(out).toMatchObject({ verified: true, after: { count: 3, added: ["Marijuana"], removed: ["Caffeine"] } });
    expect(out.warnings.join(" ")).toMatch(/only hides/);
  });

  it("keeps a tracked custom behaviour in the list when another behaviour changes", async () => {
    const whoop = mockWhoop(routes({ 1: true, 2: true, 163752: true }, { 1: true, 2: false, 163752: true }));
    const { out } = await call(whoop, { setting: "tracked_behaviors", untrack: ["Caffeine"] });
    expect(whoop.put).toHaveBeenCalledWith(TRACKED, ["1", "163752"]);
    expect(out).toMatchObject({ verified: true, before: { count: 3 }, after: { count: 2, removed: ["Caffeine"] } });
  });

  it("tracks an untracked custom behaviour and verifies it from the customize screen", async () => {
    const whoop = mockWhoop(routes({ 1: true, 163752: false }, { 1: true, 163752: true }));
    const { out } = await call(whoop, { setting: "tracked_behaviors", track: ["Probe Hip Mobility"] });
    expect(whoop.put).toHaveBeenCalledWith(TRACKED, ["1", "163752"]);
    expect(out).toMatchObject({ updated: true, verified: true, after: { count: 2, added: ["Probe Hip Mobility"] } });
  });

  it("untracks a tracked custom behaviour", async () => {
    const whoop = mockWhoop(routes({ 1: true, 163752: true }, { 1: true, 163752: false }));
    const { out } = await call(whoop, { setting: "tracked_behaviors", untrack: [163752] });
    expect(whoop.put).toHaveBeenCalledWith(TRACKED, ["1"]);
    expect(out).toMatchObject({ updated: true, verified: true, after: { count: 1, removed: ["Probe Hip Mobility"] } });
    expect(out.warnings.join(" ")).toMatch(/can't be deleted/);
  });

  it("reports verified:false when the tracked set reads back unchanged", async () => {
    const same = { 1: true, 2: true, 3: false };
    const whoop = mockWhoop(routes(same, same));
    const { out } = await call(whoop, { setting: "tracked_behaviors", track: [3] });
    expect(out).toMatchObject({ updated: true, verified: false });
  });

  it("refuses when the customize screen can't give the tracked flags", async () => {
    const noFlags = { grouped_toggles: [{ toggles: [{ id: "1", title: "Alcohol" }, { id: "2", title: "Caffeine" }] }] };
    for (const broken of [noFlags, { grouped_toggles: [] }, new Error("down")]) {
      const whoop = mockWhoop({ [CUSTOMIZE]: broken, [TRACKED]: stockList([1, 2]) });
      const { result } = await call(whoop, { setting: "tracked_behaviors", track: [3] });
      expect(result.isError).toBe(true);
      expect(whoop.put).not.toHaveBeenCalled();
    }
  });
});

describe("whoop_preferences_set: clock_format", () => {
  const boot = (offset: string | null) => ({ profile: { timezone_offset: offset } });

  it("sends the configured timezone unchanged and verifies from the response row", async () => {
    vi.stubEnv("WHOOP_TIMEZONE", "America/Los_Angeles");
    const whoop = mockWhoop({ "/users-service/v2/bootstrap": boot(zoneOffset("America/Los_Angeles")) });
    whoop.post.mockResolvedValueOnce({ clock_format: "TWENTY_FOUR_HOUR_FORMAT", timezone: "America/Los_Angeles" });
    const { out } = await call(whoop, { setting: "clock_format", clock_format: "TWENTY_FOUR_HOUR_FORMAT" });
    const [path, body] = whoop.post.mock.calls[0]! as unknown as [string, Record<string, string>];
    expect(path).toBe("/users-service/v1/users/preferences/time");
    expect(body).toMatchObject({ clock_format: "TWENTY_FOUR_HOUR_FORMAT", timezone: "America/Los_Angeles" });
    expect(body.current_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+0000$/);
    expect(out).toMatchObject({ verified: true, after: { clock_format: "TWENTY_FOUR_HOUR_FORMAT" } });
  });

  it("shows the timezone it will send in the preview and the receipt", async () => {
    vi.stubEnv("WHOOP_TIMEZONE", "America/Los_Angeles");
    const routes = { "/users-service/v2/bootstrap": boot(zoneOffset("America/Los_Angeles")) };
    const preview = await call(mockWhoop(routes), { setting: "clock_format", clock_format: "TWENTY_FOUR_HOUR_FORMAT", confirm: false });
    expect(preview.out.will_execute.body_summary.after).toEqual({ clock_format: "TWENTY_FOUR_HOUR_FORMAT", timezone: "America/Los_Angeles" });
    const whoop = mockWhoop(routes);
    whoop.post.mockResolvedValueOnce({ clock_format: "TWENTY_FOUR_HOUR_FORMAT", timezone: "America/Los_Angeles" });
    const { out } = await call(whoop, { setting: "clock_format", clock_format: "TWENTY_FOUR_HOUR_FORMAT" });
    expect(out.after).toEqual({ clock_format: "TWENTY_FOUR_HOUR_FORMAT", timezone: "America/Los_Angeles" });
  });

  it("reports verified:false when WHOOP's response row shows another format or zone", async () => {
    vi.stubEnv("WHOOP_TIMEZONE", "America/Los_Angeles");
    const whoop = mockWhoop({ "/users-service/v2/bootstrap": boot(zoneOffset("America/Los_Angeles")) });
    whoop.post.mockResolvedValueOnce({ clock_format: "TWELVE_HOUR_FORMAT", timezone: "America/Los_Angeles" });
    const { out } = await call(whoop, { setting: "clock_format", clock_format: "TWENTY_FOUR_HOUR_FORMAT" });
    expect(out.verified).toBe(false);
  });

  it("refuses a clock format that was never written live (only seen in a 400's enum list)", async () => {
    vi.stubEnv("WHOOP_TIMEZONE", "America/Los_Angeles");
    const whoop = mockWhoop({ "/users-service/v2/bootstrap": boot(zoneOffset("America/Los_Angeles")) });
    const { result } = await call(whoop, { setting: "clock_format", clock_format: "TWELVE_HOUR_FORMAT_NO_PERIOD" });
    expect(result.isError).toBe(true);
    expect(whoop.post).not.toHaveBeenCalled();
  });

  it("refuses when the timezone it would send doesn't match the profile offset", async () => {
    vi.stubEnv("WHOOP_TIMEZONE", "Asia/Tokyo");
    const whoop = mockWhoop({ "/users-service/v2/bootstrap": boot("-0800") });
    const { result } = await call(whoop, { setting: "clock_format", clock_format: "TWELVE_HOUR_FORMAT" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/re-cut your days/);
    expect(whoop.post).not.toHaveBeenCalled();
  });
});

describe("whoop_preferences_set: preview and budgets", () => {
  it("previews without writing", async () => {
    const whoop = mockWhoop({ "/users-service/v1/stealth-mode": false });
    const { out } = await call(whoop, { setting: "stealth", enabled: true, confirm: false });
    expect(whoop.put).not.toHaveBeenCalled();
    expect(out).toMatchObject({ preview: true, will_execute: { method: "PUT", path: "/users-service/v1/stealth-mode", body_summary: { before: { enabled: false }, after: { enabled: true } } } });
  });

  it("stays inside the description budgets", async () => {
    const client = await connect(registerPreferencesSet, mockWhoop({}));
    for (const t of await toolBudget(client)) {
      expect(t.description).toBeLessThanOrEqual(450);
      expect(t.longestDescribe).toBeLessThanOrEqual(60);
    }
  });
});
