import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectSleep } from "../../src/projections/sleep.js";
const load = (name: string): unknown => JSON.parse(readFileSync(resolve("tests/fixtures", name), "utf8"));

describe("projectSleep disturbances", () => {
  it("reads the WAKE EVENTS tile count", () => {
    expect(projectSleep(load("deep_dive_sleep.json"), "2026-05-23").disturbances).toBe(23);
  });
});
