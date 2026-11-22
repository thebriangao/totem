// Verifies the Round 1 rewritten projections against captured raw fixtures.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectSleep } from "../../src/projections/sleep.js";
import { SleepOut } from "../../src/schemas/sleep.js";
const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("projectSleep (captured)", () => {
  const raw = load("deep_dive_sleep.json");
  const out = projectSleep(raw, "2026-05-23");

  it("parses schema", () => {
    expect(() => SleepOut.parse(out)).not.toThrow();
  });
  it("extracts started_at + ended_at from header destination", () => {
    expect(out.started_at).toBe("2026-05-23T07:35:46.220Z");
    expect(out.ended_at).toBe("2026-05-23T15:35:33.560Z");
  });
  it("extracts total sleep (7h24m = 26640000 ms)", () => {
    expect(out.total_sleep_ms).toBe(26640000);
  });
  it("extracts time in bed (7h59m = 28740000 ms)", () => {
    expect(out.time_in_bed_ms).toBe(28740000);
  });
  it("extracts efficiency (93%)", () => {
    expect(out.efficiency_pct).toBe(93);
  });
  it("extracts performance (85%)", () => {
    expect(out.performance_pct).toBe(85);
  });
  it("extracts consistency (73%)", () => {
    expect(out.consistency_pct).toBe(73);
  });
  it("extracts AWAKE stage (0h35m = 2100000 ms, 7%)", () => {
    expect(out.stages.wake_ms).toBe(2100000);
    expect(out.stages.wake_pct).toBe(7);
  });
  it("has non-null REM / LIGHT / SWS times", () => {
    expect(out.stages.rem_ms).not.toBeNull();
    expect(out.stages.light_ms).not.toBeNull();
    expect(out.stages.sws_ms).not.toBeNull();
  });
  it("reconstructs the hypnogram (stage timeline within the sleep window)", () => {
    expect(out.hypnogram.length).toBeGreaterThan(10);
    expect(out.hypnogram.some((s) => s.stage === "REM")).toBe(true);
    expect(out.hypnogram.some((s) => s.stage === "SWS")).toBe(true);
    expect(out.hypnogram.some((s) => s.stage === "AWAKE")).toBe(true);
    const first = Date.parse(out.hypnogram[0]!.started_at);
    const last = Date.parse(out.hypnogram.at(-1)!.ended_at);
    expect(last).toBeGreaterThan(first);
    // anchored to the real sleep window (within a minute of [start, end])
    expect(first).toBeGreaterThanOrEqual(Date.parse(out.started_at!) - 60000);
    expect(last).toBeLessThanOrEqual(Date.parse(out.ended_at!) + 60000);
  });
  it("extracts in-sleep HR (avg + min)", () => {
    expect(out.sleep_hr.avg_bpm!).toBeGreaterThan(40);
    expect(out.sleep_hr.avg_bpm!).toBeLessThan(120);
    expect(out.sleep_hr.min_bpm!).toBeLessThanOrEqual(out.sleep_hr.avg_bpm!);
  });
});
