// Regressions found by running the v2 activity tools live (2026-11-21, throwaway account).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerActivityEdit } from "../../src/tools/v2/activity_edit.js";
import { projectActivityDetail } from "../../src/projections/activities.js";
import { activityRecord, badRequest, connect, fakeWhoop, textOf, unrouted } from "./activity_test_utils.js";

const RECORD = "/activities-service/v2/activities/a1";
const CARDIO_V1 = "/core-details-bff/v1/cardio-details";
const CARDIO_V2 = "/core-details-bff/v2/cardio-details";

describe("read-back right after an edit", () => {
  it("verifies from the activity record when WHOOP refuses the detail screen for a pending activity", async () => {
    let during = "['2026-11-21T14:10:00.000Z','2026-11-21T14:30:00.000Z')";
    let version = 0;
    const fake = fakeWhoop((c) => {
      if (c.method === "GET" && c.path === RECORD) return activityRecord({ id: "a1", type: "walking", during, version }, false);
      if (c.method === "PUT" && c.path === CARDIO_V2) {
        const b = c.body as { start_time: string; end_time: string };
        during = `['${b.start_time}','${b.end_time}')`;
        version += 1;
        return activityRecord({ id: "a1", type: "walking", during, version });
      }
      // What WHOOP really answers for a few seconds after an edit:
      if (c.method === "GET" && c.path === CARDIO_V1) throw badRequest(c.path, "Cannot view activity details for a pending activity");
      return unrouted(c);
    });
    const client = await connect((s) => registerActivityEdit(s, fake.whoop));
    const r = textOf(await client.callTool({
      name: "whoop_activity_edit",
      arguments: { activity_id: "a1", start: "2026-11-21T06:15:00-08:00", end: "2026-11-21T06:35:00-08:00", confirm: true },
    }));
    expect(r).toMatchObject({ edited: true, verified: true, after: { type: "walking", version: 1 } });
    expect(JSON.stringify(r)).not.toContain("Read-back failed");
  });
});

describe("detail of an activity with no strap data", () => {
  it("leaves out 0 bpm, 0 kcal and all-zero zones instead of reporting them as measurements", () => {
    const load = (n: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/activities/${n}`, import.meta.url), "utf8"));
    const out = projectActivityDetail(load("cardio_details_pending_boxing.json"), null, "29792beb") as Record<string, unknown>;
    for (const key of ["avg_hr_bpm", "max_hr_bpm", "min_hr_bpm", "calories", "zones_min"]) {
      expect(out[key] ?? null, key).toBeNull();
    }
  });
});
