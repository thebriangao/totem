import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerNow } from "../../src/tools/v2/now.js";
import { projectNow } from "../../src/projections/v2/now.js";
import { call, closeAll, connect, err500, fx, paths, pinToday, queryFor, routedGet, unpinToday } from "./reads_core_harness.js";

describe("whoop_now projection", () => {
  it("converts latestMetricsProcessed (epoch ms) and reads widget score strings", () => {
    const out = projectNow(fx("userstate"), fx("stress_calibrating"), fx("widget"));
    expect(out).toMatchObject({
      state: "idle", tracked_sleep: false, duration_min: null,
      latest_metrics_at: new Date(1795314393780).toISOString(),
      started_at: "2026-11-22T02:36:22.061Z",
      stress: { level: 1.4, label: "MEDIUM", state: "CALIBRATING" },
      scores: { recovery_pct: null, sleep_pct: null, strain: 20.9, calories: 237, hrv_ms: null },
    });
  });

  it("reports an activity in progress with minutes so far", () => {
    const state = { state: "workout", startAt: "2026-11-21T19:30:00.000Z", activity: { id: "a1", sport_name: "Running" }, trackedSleep: false };
    const out = projectNow(state, null, null, Date.parse("2026-11-21T20:00:00.000Z"));
    expect(out).toMatchObject({ state: "workout", sport_name: "Running", activity_id: "a1", duration_min: 30, stress: null, scores: null });
    expect(projectNow({ state: "strange" }, null, null).state).toBe("unknown");
  });
});

describe("whoop_now tool", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  it("reads user-state, today's stress and the medium widget, and answers without a heart rate when none can be read", async () => {
    const get = routedGet({
      // The strap last synced two hours before the pinned "now" (2026-11-21T20:00Z).
      "/activities-service/v1/user-state": { ...(fx("userstate") as object), latestMetricsProcessed: Date.parse("2026-11-21T18:00:00.000Z") },
      "/health-service/v2/stress-bff/2026-11-21": fx("stress_calibrating"),
      "/home-service/v1/widget/overview": fx("widget"),
    });
    const out = await call(await connect(registerNow, get), "whoop_now");
    expect(queryFor(get, "/home-service/v1/widget/overview")).toEqual({ widgetSize: "MEDIUM" });
    expect(paths(get)).not.toContain("/health-tab-bff/v1/health-tab");
    // No bootstrap or metrics route here: the optional heart-rate read fails and the snapshot is unaffected.
    expect(out.hr).toBeUndefined();
    // Staleness is two flat fields, not a block that repeats latest_metrics_at and a constant.
    expect(out).toMatchObject({ latest_metrics_at: "2026-11-21T10:00:00-08:00", fetched_at: "2026-11-21T12:00:00-08:00", metrics_age_min: 120 });
    expect(out.freshness).toBeUndefined();
  });

  it("tolerates stress and widget failures but not a user-state failure", async () => {
    const ok = routedGet({
      "/activities-service/v1/user-state": fx("userstate"),
      "/health-service/v2/stress-bff/2026-11-21": err500("stress"),
      "/home-service/v1/widget/overview": err500("widget"),
    });
    const out = await call(await connect(registerNow, ok), "whoop_now");
    expect(out.state).toBe("idle");
    expect(out.stress ?? null).toBeNull();
    const bad = routedGet({
      "/activities-service/v1/user-state": err500("state"),
      "/health-service/v2/stress-bff/2026-11-21": fx("stress_calibrating"),
      "/home-service/v1/widget/overview": fx("widget"),
    });
    await expect(call(await connect(registerNow, bad), "whoop_now")).rejects.toThrow(/500/);
  });
});
