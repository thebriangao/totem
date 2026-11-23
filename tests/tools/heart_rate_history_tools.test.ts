// whoop_day's heart-rate series and day table, and whoop_now's latest heart rate.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerDay, dayHrSpan } from "../../src/tools/v2/day.js";
import { registerNow } from "../../src/tools/v2/now.js";
import { WhoopClient } from "../../src/whoop/client.js";
import { call, closeAll, connect, err500, fx, paths, pinToday, queryFor, routedGet, unpinToday } from "./reads_core_harness.js";

const USER = 10000001;
const HR = `/metrics-service/v1/metrics/user/${USER}`;
const CYCLES = "/core-details-bff/v0/cycles/details";
const BOOT = "/users-service/v2/bootstrap";
const boot = { user: { id: USER } };

// "Now" is pinned to 2026-11-21T20:00:00Z (noon in US Pacific).
describe("whoop_day heart rate", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  const routes = (over: Record<string, unknown> = {}) => ({
    "/home-service/v1/home": fx("home_populated"),
    "/activities-service/v1/user-state": fx("userstate"),
    [BOOT]: boot,
    [HR]: fx("hr_60s"),
    ...over,
  });

  it("include hr reads the cycle's own window at 10-minute steps, keyed by this account's user id", async () => {
    const get = routedGet(routes());
    const out = await call(await connect(registerDay, get), "whoop_day", { date: "2026-11-18", include: ["hr"] });
    // The fixture's cycle runs 2026-11-18T07:10Z → 2026-11-19T06:50Z (23 h 40 min).
    expect(queryFor(get, HR)).toEqual({
      name: "heart_rate", start: "2026-11-18T07:10:00.000Z", end: "2026-11-19T06:50:00.000Z", step: 600, order: "t",
    });
    expect(out.hr).toMatchObject({ start: "2026-11-17T23:10:00-08:00", end: "2026-11-18T22:50:00-08:00", step_s: 600, n: 53 });
    // (The mock serves the 60 s fixture whatever the step; at 600 s its 350 s hole is not a hole.)
    expect(out.hr.runs).toHaveLength(1);
    expect(out.hr.runs[0].start).toBe("2026-11-21T15:32:38-08:00");
    expect(out.hr.runs[0].bpm).toHaveLength(53);
    // Only what was asked for: no scores, sleep or strain reads.
    expect(paths(get).sort()).toEqual([HR, "/home-service/v1/home", BOOT].sort());
    expect(out.scores).toBeUndefined();
  });

  it("an open cycle is read up to now, and a day with no cycle falls back to the calendar day", () => {
    const now = Date.parse("2026-11-21T20:00:00.000Z");
    const cycle = { id: 1, start: "2026-11-21T11:30:00.000Z", end: null, sleep_state: null, day_state: null, calibrating: false };
    expect(dayHrSpan(cycle, "2026-11-21", now)).toEqual([Date.parse("2026-11-21T11:30:00.000Z"), now]);
    // A predicted end in the future is not read past now either.
    expect(dayHrSpan({ ...cycle, end: "2026-11-22T11:30:00.000Z" }, "2026-11-21", now)[1]).toBe(now);
    // No cycle: local midnight to local midnight (US Pacific is UTC−8 in November).
    expect(dayHrSpan({ ...cycle, start: null }, "2026-11-19", now)).toEqual([
      Date.parse("2026-11-19T08:00:00.000Z"), Date.parse("2026-11-20T08:00:00.000Z"),
    ]);
    // A cycle longer than the cap keeps its newest 48 hours.
    const long = dayHrSpan({ ...cycle, start: "2026-11-18T00:00:00.000Z" }, "2026-11-18", now);
    expect(long[1] - long[0]).toBe(48 * 3_600_000);
  });

  it("hr_from/hr_to read any window and pick the step from its length", async () => {
    const get = routedGet(routes());
    const client = await connect(registerDay, get);
    const out = await call(client, "whoop_day", { hr_from: "2026-11-20T15:00:00-08:00", hr_to: "2026-11-20T15:20:00-08:00" });
    expect(queryFor(get, HR)).toMatchObject({ start: "2026-11-20T23:00:00.000Z", end: "2026-11-20T23:20:00.000Z", step: 6 });
    expect(out.hr.step_s).toBe(6);
    // The day shown is the window's own local day, and hr is included without being named.
    expect(out.date).toBe("2026-11-20");
    expect(queryFor(get, "/home-service/v1/home")).toEqual({ date: "2026-11-20" });
    // A window on its own is a heart-rate question: none of the day's default sections is read or returned.
    expect(paths(get).sort()).toEqual([HR, "/home-service/v1/home", BOOT].sort());
    expect(out.scores).toBeUndefined();
    expect(out.activities).toBeUndefined();

    get.mockClear();
    await call(client, "whoop_day", { hr_from: "2026-11-20T10:00:00-08:00", hr_to: "2026-11-20T14:00:00-08:00", include: ["key_stats"] });
    expect(queryFor(get, HR).step).toBe(60);
    get.mockClear();
    await call(client, "whoop_day", { hr_from: "2026-11-20T00:00:00-08:00", hr_to: "2026-11-21T00:00:00-08:00" });
    expect(queryFor(get, HR).step).toBe(600);
  });

  it("clamps a window that runs past now, and refuses ones that make no sense", async () => {
    const get = routedGet(routes());
    const client = await connect(registerDay, get);
    await call(client, "whoop_day", { hr_from: "2026-11-21T11:50:00-08:00", hr_to: "2026-11-21T13:00:00-08:00" });
    expect(queryFor(get, HR)).toMatchObject({ start: "2026-11-21T19:50:00.000Z", end: "2026-11-21T20:00:00.000Z", step: 6 });

    get.mockClear();
    const bad = (args: Record<string, unknown>) => call(client, "whoop_day", args);
    await expect(bad({ hr_from: "2026-11-20T15:00:00-08:00" })).rejects.toThrow(/go together/);
    await expect(bad({ hr_to: "2026-11-20T15:00:00-08:00" })).rejects.toThrow(/go together/);
    await expect(bad({ hr_from: "2026-11-20T15:00:00-08:00", hr_to: "2026-11-20T14:00:00-08:00" })).rejects.toThrow(/before hr_to/);
    await expect(bad({ hr_from: "2026-11-21T13:00:00-08:00", hr_to: "2026-11-21T14:00:00-08:00" })).rejects.toThrow(/future/);
    await expect(bad({ hr_from: "2026-11-18T00:00:00-08:00", hr_to: "2026-11-20T00:00:01-08:00" })).rejects.toThrow(/48 hours/);
    await expect(bad({ hr_from: "yesterday 3pm", hr_to: "2026-11-20 16:00" })).rejects.toThrow();
    // None of the refusals reached WHOOP.
    expect(get).not.toHaveBeenCalled();

    // A time without an offset is on the person's clock (the WHOOP timezone, Los Angeles here).
    await call(client, "whoop_day", { hr_from: "2026-11-20 15:00", hr_to: "2026-11-20T16:00" });
    expect(queryFor(get, HR)).toMatchObject({ start: "2026-11-20T23:00:00.000Z", end: "2026-11-21T00:00:00.000Z" });
  });

  it("fails loudly when a series that was asked for can't be read, and says so for an empty window", async () => {
    const broken = routedGet(routes({ [HR]: err500(HR) }));
    await expect(call(await connect(registerDay, broken), "whoop_day", { date: "2026-11-18", include: ["hr"] })).rejects.toThrow(/500/);
    const noId = routedGet(routes({ [BOOT]: { user: {} } }));
    await expect(call(await connect(registerDay, noId), "whoop_day", { date: "2026-11-18", include: ["hr"] })).rejects.toThrow(/user id/);
    expect(paths(noId)).not.toContain(HR);

    const empty = routedGet(routes({ [HR]: { name: "heart_rate", start: 0, values: [] } }));
    const out = await call(await connect(registerDay, empty), "whoop_day", { date: "2026-11-18", include: ["hr"] });
    expect(out.hr).toEqual({ start: "2026-11-17T23:10:00-08:00", end: "2026-11-18T22:50:00-08:00", step_s: 600, n: 0 });
  });

  it("the default call reads no heart rate at all", async () => {
    const get = routedGet({ ...routes(), "/home-service/v1/deep-dive/recovery": {}, "/home-service/v1/deep-dive/strain": {} });
    const out = await call(await connect(registerDay, get), "whoop_day");
    expect(paths(get)).not.toContain(HR);
    expect(paths(get)).not.toContain(BOOT);
    expect(out.hr).toBeUndefined();
  });
});

describe("whoop_day day table", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  const routes = (over: Record<string, unknown> = {}) => ({ [BOOT]: boot, [CYCLES]: fx("cycles_details"), ...over });

  it("end_date reads the bulk history once, local midnight to local midnight, and returns one row per day", async () => {
    const get = routedGet(routes());
    const out = await call(await connect(registerDay, get), "whoop_day", { date: "2026-11-20", end_date: "2026-11-21" });
    expect(paths(get).sort()).toEqual([CYCLES, BOOT].sort());
    expect(queryFor(get, CYCLES)).toEqual({ id: USER, startTime: "2026-11-20T08:00:00.000Z", endTime: "2026-11-22T08:00:00.000Z", limit: 22 });
    expect(out).toEqual({
      start_date: "2026-11-20", end_date: "2026-11-21", count: 2,
      columns: ["date", "strain", "kcal", "avg_hr", "max_hr", "workouts"],
      // WHOOP also returned the 2026-11-22 cycle (it overlaps the window); it is not in the asked range.
      rows: [["2026-11-20", null, null, null, null, null], ["2026-11-21", 20.9, 237, 89, 170, 2]],
    });
  });

  it("defaults to the 30 days up to end_date, and never asks past today", async () => {
    const get = routedGet(routes());
    const client = await connect(registerDay, get);
    const out = await call(client, "whoop_day", { end_date: "2026-11-21" });
    expect(out).toMatchObject({ start_date: "2026-10-23", end_date: "2026-11-21", count: 2 });
    // 2026-10-23 is still daylight time in US Pacific (UTC−7); the window is 30 local days.
    expect(queryFor(get, CYCLES)).toMatchObject({ startTime: "2026-10-23T07:00:00.000Z", endTime: "2026-11-22T08:00:00.000Z", limit: 50 });

    get.mockClear();
    const future = await call(client, "whoop_day", { date: "2026-11-21", end_date: "2026-12-31" });
    expect(future).toMatchObject({ start_date: "2026-11-21", end_date: "2026-11-21", count: 1 });
    expect(queryFor(get, CYCLES).endTime).toBe("2026-11-22T08:00:00.000Z");
  });

  it("refuses ranges WHOOP would reject and argument mixes that mean nothing", async () => {
    const get = routedGet(routes());
    const client = await connect(registerDay, get);
    const bad = (args: Record<string, unknown>) => call(client, "whoop_day", args);
    await expect(bad({ date: "2026-05-24", end_date: "2026-11-20" })).rejects.toThrow(/181 days.*at most 180/);
    await expect(bad({ date: "2026-11-21", end_date: "2026-11-01" })).rejects.toThrow(/after end_date/);
    await expect(bad({ date: "2026-12-05", end_date: "2026-12-31" })).rejects.toThrow(/today is the last day/);
    await expect(bad({ end_date: "2026-11-21", include: ["scores"] })).rejects.toThrow(/day table only/);
    await expect(bad({ end_date: "2026-11-21", hr_from: "2026-11-20T15:00:00-08:00", hr_to: "2026-11-20T16:00:00-08:00" })).rejects.toThrow(/day table only/);
    expect(get).not.toHaveBeenCalled();
    // 180 days is the most one call reads.
    await expect(bad({ date: "2026-05-25", end_date: "2026-11-20" })).resolves.toMatchObject({ start_date: "2026-05-25" });
    expect(queryFor(get, CYCLES).limit).toBe(200);
  });

  it("warns when WHOOP filled the record limit, since the oldest days may then be missing", async () => {
    const one = (fx("cycles_details") as { records: unknown[] }).records[1];
    const get = routedGet(routes({ [CYCLES]: { records: Array.from({ length: 22 }, () => one) } }));
    const out = await call(await connect(registerDay, get), "whoop_day", { date: "2026-11-20", end_date: "2026-11-21" });
    expect(out.warnings).toEqual([expect.stringMatching(/oldest days may be missing/)]);
  });

  it("passes WHOOP's own failure through", async () => {
    const get = routedGet(routes({ [CYCLES]: err500(CYCLES) }));
    await expect(call(await connect(registerDay, get), "whoop_day", { end_date: "2026-11-21" })).rejects.toThrow(/500/);
  });
});

describe("whoop_now latest heart rate", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  const SYNCED = Date.parse("2026-11-21T19:45:00.000Z");
  const routes = (over: Record<string, unknown> = {}) => ({
    "/activities-service/v1/user-state": { ...(fx("userstate") as object), latestMetricsProcessed: SYNCED },
    "/health-service/v2/stress-bff/2026-11-21": fx("stress_calibrating"),
    "/home-service/v1/widget/overview": fx("widget"),
    [BOOT]: boot,
    [HR]: { name: "heart_rate", start: 0, values: [{ time: SYNCED - 9_000, data: 71 }, { time: SYNCED - 3_000, data: 74 }] },
    ...over,
  });

  it("reads a few minutes around the strap's last sync at 6-second steps and reports the newest sample", async () => {
    const get = routedGet(routes());
    const out = await call(await connect(registerNow, get), "whoop_now");
    expect(queryFor(get, HR)).toEqual({
      name: "heart_rate", start: "2026-11-21T19:42:00.000Z", end: "2026-11-21T19:45:30.000Z", step: 6, order: "t",
    });
    expect(out.hr).toEqual({ bpm: 74, at: "2026-11-21T11:44:57-08:00" });
    expect(out.metrics_age_min).toBe(15);
  });

  it("looks at the last 15 minutes when WHOOP has never processed strap data", async () => {
    const get = routedGet(routes({ "/activities-service/v1/user-state": { state: "idle", trackedSleep: false } }));
    await call(await connect(registerNow, get), "whoop_now");
    expect(queryFor(get, HR)).toMatchObject({ start: "2026-11-21T19:45:00.000Z", end: "2026-11-21T20:00:00.000Z", step: 6 });
  });

  it("still answers when the heart rate can't be read or there is none", async () => {
    for (const over of [{ [HR]: err500(HR) }, { [BOOT]: err500(BOOT) }, { [HR]: { values: [] } }, { [HR]: { values: [{ time: SYNCED, data: 0 }] } }]) {
      const out = await call(await connect(registerNow, routedGet(routes(over))), "whoop_now");
      expect(out.state).toBe("idle");
      expect(out.hr).toBeUndefined();
    }
  });
});

describe("client cache for the two endpoints", () => {
  const fetchMock = vi.fn();
  const ok = () => Promise.resolve(new Response(JSON.stringify({ values: [] }), { status: 200 }));

  it("never caches recent heart rate, keeps settled windows briefly, and drops the day table after a write", async () => {
    let now = Date.parse("2026-11-21T20:00:00.000Z");
    fetchMock.mockReset().mockImplementation(ok);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new WhoopClient({ getToken: async () => "t", now: () => now });
      const recent = { name: "heart_rate", start: "2026-11-21T10:00:00.000Z", end: "2026-11-21T19:00:00.000Z", step: 600, order: "t" };
      await client.get(HR, recent);
      await client.get(HR, recent);
      expect(fetchMock).toHaveBeenCalledTimes(2); // the strap may still sync readings into this window
      const settled = { ...recent, start: "2026-11-19T10:00:00.000Z", end: "2026-11-20T19:00:00.000Z" };
      await client.get(HR, settled);
      await client.get(HR, settled);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      now += 16 * 60_000;
      await client.get(HR, settled);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const q = { id: USER, startTime: "2026-11-20T08:00:00.000Z", endTime: "2026-11-22T08:00:00.000Z", limit: 22 };
      await client.get(CYCLES, q);
      await client.get(CYCLES, q);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      await client.post("/core-details-bff/v2/create-activity", {});
      await client.get(CYCLES, q);
      expect(fetchMock).toHaveBeenCalledTimes(7); // the write, then a fresh read
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
