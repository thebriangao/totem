import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectSleep } from "../../src/projections/sleep.js";
import { projectActivitySleepSummary } from "../../src/projections/today.js";
import { localDay, projectRecovery } from "../../src/projections/recovery.js";

const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("projectSleep disturbances", () => {
  it("reads the WAKE EVENTS tile count", () => {
    expect(projectSleep(load("deep_dive_sleep.json"), "2026-05-23").disturbances).toBe(23);
  });
});

describe("no wrong-day fallback for past dates", () => {
  const sleep = load("activity_sleep.json");
  it("matches the sleep ending on the requested date", () => {
    expect(projectActivitySleepSummary(sleep, "2026-05-29")?.performance_pct).toBe(84);
  });
  it("returns null for a past date with no matching sleep", () => {
    expect(projectActivitySleepSummary(sleep, "2026-05-20")).toBeNull();
  });
  it("falls back to the latest sleep when the date is newer than every record", () => {
    expect(projectActivitySleepSummary(sleep, "2026-05-31")?.performance_pct).toBe(81);
  });
  it("recovery SpO2/skin temp stay null for a past date with no matching v2 record", () => {
    const out = projectRecovery(load("deep_dive_recovery.json"), "2026-05-20", load("recovery_v2.json"));
    expect(out.spo2_pct).toBeNull();
    expect(out.skin_temp_c).toBeNull();
  });
  it("recovery falls back to the latest v2 record for a date newer than every record", () => {
    const out = projectRecovery(load("deep_dive_recovery.json"), "2026-05-31", load("recovery_v2.json"));
    expect(out.skin_temp_c).toBe(33.7);
  });
});

describe("localDay", () => {
  it("keeps a local-offset timestamp's own date and shifts a UTC one into the member's timezone", () => {
    const previous = process.env.WHOOP_TIMEZONE;
    process.env.WHOOP_TIMEZONE = "Asia/Tokyo";
    try {
      expect(localDay("2026-05-30T09:06:26.080-07:00")).toBe("2026-05-30");
      expect(localDay("2026-05-29T21:30:00.000Z")).toBe("2026-05-30");
      expect(localDay(undefined)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.WHOOP_TIMEZONE;
      else process.env.WHOOP_TIMEZONE = previous;
    }
  });

  it("matches a UTC-stamped sleep to the Tokyo morning it ended on", () => {
    const previous = process.env.WHOOP_TIMEZONE;
    process.env.WHOOP_TIMEZONE = "Asia/Tokyo";
    try {
      const resp = { records: [
        { end: "2026-05-30T21:00:00.000Z", nap: false, score: { stage_summary: {} } },
        { end: "2026-05-29T21:00:00.000Z", nap: false, score: { stage_summary: {} } },
      ] };
      const summary = projectActivitySleepSummary(resp, "2026-05-30");
      expect(summary).not.toBeNull();
      expect(JSON.stringify(summary)).toContain("2026-05-29T21:00:00.000Z");
    } finally {
      if (previous === undefined) delete process.env.WHOOP_TIMEZONE;
      else process.env.WHOOP_TIMEZONE = previous;
    }
  });
});
