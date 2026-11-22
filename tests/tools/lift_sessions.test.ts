import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { body, connect, fixture, routes } from "./lift_v2_harness.js";
import { registerLiftSessions } from "../../src/tools/v2/lift_sessions.js";
import { WhoopApiError } from "../../src/whoop/errors.js";

const repoFixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const SCORED = "5364dc07-c229-481f-b92f-0d7ee402fbbf";
const PENDING = "1f27998b-95c6-4865-acdd-3d413063ce9b";

function pendingHome(date: string) {
  return {
    pillars: [{ sections: [{ items: [{ content: { list: [{ key: "START_ACTIVITY", content: { completed: { content: { items: [{ content: {
      activity_v2_id: PENDING, internal_name: "weightlifting_msk", title: "STRENGTH TRAINER", type: "CARDIO", status: "INCOMPLETE", score_display: "---",
      during: { lower_endpoint: `${date}T17:00:00.000+0000`, upper_endpoint: `${date}T17:20:00.000+0000` }, sport_id: -1,
    } }] } } } }] } }] }] }],
  };
}

function historyFor(id: string) {
  return id === "BENCHPRESS_BARBELL" ? fixture("history_bench") : { id: "exercise_history", items: [], show_more: null };
}

describe("whoop_lift_sessions", () => {
  it("walks home days with data and returns one compact row per scored session", async () => {
    const get = routes({
      "/home-service/v1/calendar/overview": repoFixture("calendar_overview"),
      "/home-service/v1/home": (q) => (q.date === "2026-05-23" ? repoFixture("home") : {}),
      "/core-details-bff/v1/cardio-details": (q) => (q.activityId === SCORED ? repoFixture("cardio_details") : repoFixture("cardio_details_nonstrength")),
    });
    const client = await connect(registerLiftSessions, { get });
    const out = body(await client.callTool({ name: "whoop_lift_sessions", arguments: { start_date: "2026-05-22", end_date: "2026-05-23" } }));
    expect(out).toMatchObject({ from: "2026-05-22", to: "2026-05-23", unit: "lb", more: false });
    expect(out.sessions).toHaveLength(1);
    const s = out.sessions[0];
    expect(s).toMatchObject({ id: SCORED, sport: "weightlifting_msk", src: "details", strain: 17.7, volume: 36720, msk_pct: 74 });
    expect(s.exercises[0]).toMatchObject({ id: "LEGPRESS_PULLEYMACHINE", sets: "5x10", top: [200, 10], volume: 9600 });
    expect(s.exercises[0].rows).toBeUndefined();
    expect(JSON.stringify(out).length).toBeLessThan(2000);
    // calendar pruning: only the two marked days were fetched (in one paced chunk)
    const homeDates = get.mock.calls.filter((c) => c[0] === "/home-service/v1/home").map((c) => (c[1] as { date: string }).date);
    expect(homeDates.sort()).toEqual(["2026-05-22", "2026-05-23"]);
    expect(get.mock.calls.some((c) => String(c[0]).startsWith("/developer/"))).toBe(false);
  });

  it("include sets adds compact per-set rows", async () => {
    const get = routes({
      "/home-service/v1/calendar/overview": repoFixture("calendar_overview"),
      "/home-service/v1/home": (q) => (q.date === "2026-05-23" ? repoFixture("home") : {}),
      "/core-details-bff/v1/cardio-details": repoFixture("cardio_details"),
    });
    const client = await connect(registerLiftSessions, { get });
    const out = body(await client.callTool({ name: "whoop_lift_sessions", arguments: { start_date: "2026-05-23", end_date: "2026-05-23", include: ["sets"] } }));
    expect(out.sessions[0].exercises[0].rows).toEqual([[180, 10, null, null], [180, 10, null, 139], [200, 10, null, 150], [200, 10, null, 150], [200, 10, null, 152]]);
  });

  it("falls back to exercise_history for unscored sessions", async () => {
    const pages = [fixture("prs_page0"), fixture("prs_page1"), fixture("prs_page2")];
    const get = routes({
      "/home-service/v1/calendar/overview": { days_of_month: [{ date_value_display: "21", has_data: true }] },
      "/home-service/v1/home": (q) => pendingHome(q.date as string),
      "/core-details-bff/v1/cardio-details": fixture("cardio_details_pending_lift"),
      "/weightlifting-service/v3/prs": (q) => pages[((q.offset as number | undefined) ?? 0) / 10],
      ...Object.fromEntries(pages.flatMap((p: any) => p.tiles).map((t: any) => [`/weightlifting-service/v3/exercise/${encodeURIComponent(t.exercise_id)}/exercise_history`, historyFor(t.exercise_id)])),
    });
    const client = await connect(registerLiftSessions, { get });
    const out = body(await client.callTool({ name: "whoop_lift_sessions", arguments: { start_date: "2026-11-21", end_date: "2026-11-21", include: ["sets"] } }));
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({ id: PENDING, src: "history", start: expect.stringContaining("2026-11-21") });
    expect(out.sessions[0].exercises).toEqual([{ id: "BENCHPRESS_BARBELL", sets: "2x5", top: [100, 5], volume: 1000, medal: "GOLD", rows: [[100, 5], [100, 5]] }]);
    // the deleted custom exercise's tile is not probed
    expect(get.mock.calls.some((c) => String(c[0]).includes("520AB719"))).toBe(false);
  });

  it("a pending 400 from cardio-details still finds the sets in history", async () => {
    const pending = new WhoopApiError(400, "/core-details-bff/v1/cardio-details", "Cannot view activity details for a pending activity", "Cannot view activity details for a pending activity");
    const get = routes({
      "/core-details-bff/v1/cardio-details": pending,
      "/weightlifting-service/v3/prs": { tiles: [{ exercise_id: "BENCHPRESS_BARBELL", name: "Bench Press - Barbell" }], show_more: false },
      "/weightlifting-service/v3/exercise/BENCHPRESS_BARBELL/exercise_history": fixture("history_bench"),
    });
    const client = await connect(registerLiftSessions, { get });
    const out = body(await client.callTool({ name: "whoop_lift_sessions", arguments: { activity_id: PENDING } }));
    expect(out.sessions[0]).toMatchObject({ id: PENDING, src: "history", exercises: [{ id: "BENCHPRESS_BARBELL", sets: "2x5" }] });
    expect(out.warnings.join()).toMatch(/pending/);
  });

  it("reads one activity by id", async () => {
    const get = routes({ "/core-details-bff/v1/cardio-details": repoFixture("cardio_details") });
    const client = await connect(registerLiftSessions, { get });
    const out = body(await client.callTool({ name: "whoop_lift_sessions", arguments: { activity_id: SCORED } }));
    expect(out.sessions[0]).toMatchObject({ id: SCORED, src: "details", start: expect.stringContaining("2026-05-23") });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("caps ranges at 60 days", async () => {
    const get = routes({});
    const client = await connect(registerLiftSessions, { get });
    const result = await client.callTool({ name: "whoop_lift_sessions", arguments: { start_date: "2026-01-01", end_date: "2026-05-01" } });
    expect(result.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
