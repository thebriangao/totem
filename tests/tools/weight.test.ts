import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerWeight, encodeCursor } from "../../src/tools/v2/weight.js";
import { registerWeightLog } from "../../src/tools/v2/weight_log.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { call, connect, fx, mockClient, routedGet, seq } from "./health_plans_helpers.js";

const PATH = "/progression-service/v3/trends/WEIGHT/readings";
const BOOT = "/users-service/v2/bootstrap";

beforeAll(() => { process.env.WHOOP_TIMEZONE = "America/Los_Angeles"; });

interface R { id: string; ts: string; kg: number; fat?: number | null; lean?: number | null; save?: string | null; source?: string }
function page(readings: R[], next_token: string | null = null) {
  return { sections: { next_token, records: [{ title: "Nov 2026", measurements: readings.map((r) => ({ type: "MEASUREMENT_BOX", content: {
    id: r.id, weight: r.kg / 0.45359237, metric_unit: "lbs", source: r.source ?? "manual",
    weight_details_screen: { timestamp: r.ts, weight_kg: r.kg, body_fat_percent: r.fat ?? null, lean_body_mass_kg: r.lean ?? null,
      save_title: r.save === undefined ? "SAVE MEASUREMENT" : r.save, source: r.source ?? "manual" },
  } })) }] } };
}
const EXISTING: R = { id: "r-1", ts: "2026-11-21T22:05:00.000Z", kg: 80 };

describe("whoop_weight", () => {
  it("returns columnar rows with the display unit once, paging by limit", async () => {
    const get = routedGet({ [PATH]: fx("weight_readings.json") });
    const client = await connect((s) => registerWeight(s, mockClient({ get })));
    const { out, isError } = await call(client, "whoop_weight", { limit: 2 });
    expect(isError).toBe(false);
    expect(out.display_unit).toBe("lb");
    expect(out.columns).toEqual(["id", "at", "kg", "fat_pct", "lean_kg", "source"]);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0][0]).toBe("7233ce75-8a25-42bb-9fa6-15ab7f3b6265");
    expect(get).toHaveBeenCalledWith(PATH, {}, { fresh: false });

    const next = await call(client, "whoop_weight", { limit: 2, cursor: out.next_cursor });
    expect(next.out.rows.map((r: unknown[]) => r[0])).toEqual(["798977e5-fc5b-4dab-b44e-8824a159b4e7", "3896c91e-f61d-45d0-8f6e-74cf9417a832"]);
  });

  it("follows WHOOP's next_token verbatim on the paginated path", async () => {
    const get = routedGet({
      [PATH]: page([EXISTING], "eyIkIjoibzEiLCJvIjoxMDB9"),
      [`${PATH}/paginated`]: (q: Record<string, unknown>) => (q.next_token === "eyIkIjoibzEiLCJvIjoxMDB9" ? page([{ id: "old", ts: "2025-01-01T08:00:00.000Z", kg: 90 }]) : new Error("bad token")),
    });
    const client = await connect((s) => registerWeight(s, mockClient({ get })));
    const first = await call(client, "whoop_weight", {});
    expect(first.out.next_cursor).toBe(encodeCursor({ t: "eyIkIjoibzEiLCJvIjoxMDB9", o: 0 }));
    const second = await call(client, "whoop_weight", { cursor: first.out.next_cursor });
    expect(second.out.rows[0][0]).toBe("old");
    expect(get).toHaveBeenLastCalledWith(`${PATH}/paginated`, { next_token: "eyIkIjoibzEiLCJvIjoxMDB9" }, { fresh: false });
  });

  it("rejects a garbled cursor", async () => {
    const client = await connect((s) => registerWeight(s, mockClient({ get: routedGet({}) })));
    expect((await call(client, "whoop_weight", { cursor: "not-a-cursor" })).isError).toBe(true);
  });
});

describe("whoop_weight_log validation", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["add without weight", { action: "add" }, /needs weight/],
    ["weight without unit", { action: "add", weight: 80 }, /unit/],
    ["edit without id", { action: "edit", weight: 80, unit: "kg" }, /reading_id/],
    ["delete with values", { action: "delete", reading_id: "r-1", weight: 80, unit: "kg" }, /only reading_id/],
    ["add with an id", { action: "add", reading_id: "r-1", weight: 80, unit: "kg" }, /action:edit/],
  ];
  it.each(cases)("%s", async (_name, args, re) => {
    const get = routedGet({});
    const post = vi.fn();
    const client = await connect((s) => registerWeightLog(s, mockClient({ get, post })));
    const { isError, out } = await call(client, "whoop_weight_log", { ...args, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(re);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["future time", { at: "2099-01-01T08:00:00-08:00", weight: 80, unit: "kg" }, /future/],
    ["over WHOOP's 275 kg bound (lb input)", { weight: 700, unit: "lb", at: "2026-11-21T14:10:00-08:00" }, /275/],
    ["lean mass not below weight", { weight: 70, lean_mass: 75, unit: "kg", at: "2026-11-21T14:10:00-08:00" }, /lean/i],
  ])("refuses %s without posting", async (_n, args, re) => {
    const post = vi.fn();
    const client = await connect((s) => registerWeightLog(s, mockClient({ get: routedGet({ [PATH]: page([]) }), post })));
    const { isError, out } = await call(client, "whoop_weight_log", { action: "add", ...args, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(re);
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses body fat outside 0–100 at the schema", async () => {
    const client = await connect((s) => registerWeightLog(s, mockClient({ get: routedGet({}) })));
    const res = await client.callTool({ name: "whoop_weight_log", arguments: { action: "add", weight: 80, unit: "kg", body_fat_pct: 120 } });
    expect(res.isError).toBe(true);
  });
});

describe("whoop_weight_log add", () => {
  const args = { action: "add", weight: 165, unit: "lb", body_fat_pct: 20, at: "2026-11-21T14:20:00-08:00" };
  const kg = Math.round(165 * 0.45359237 * 1e5) / 1e5;

  it("previews the kg body with same-day and profile-weight warnings, without posting", async () => {
    const post = vi.fn();
    const client = await connect((s) => registerWeightLog(s, mockClient({ get: routedGet({ [PATH]: page([EXISTING]) }), post })));
    const { out } = await call(client, "whoop_weight_log", args);
    expect(post).not.toHaveBeenCalled();
    expect(out.preview).toBe(true);
    expect(out.will_execute).toEqual({ method: "POST", path: PATH, body_summary: {
      timestamp: "2026-11-21T14:20:00.000-0800", weight_kg: kg, body_fat_percent: 0.2, lean_body_mass_kg: Math.round(kg * 0.8 * 100) / 100,
    } });
    expect(out.warnings.join(" ")).toMatch(/already has 1 reading.*r-1.*add creates another/);
    expect(out.warnings.join(" ")).toMatch(/latest reading.*profile weight/);
  });

  it("POSTs, finds the new reading by time + values (204 has no id), and reports the profile weight", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const added: R = { id: "r-new", ts: "2026-11-21T22:20:00.000Z", kg, fat: 0.2, lean: Math.round(kg * 0.8 * 100) / 100 };
    const get = routedGet({ [PATH]: seq(page([EXISTING]), page([added, EXISTING])), [BOOT]: { profile: { weight: kg } } });
    const client = await connect((s) => registerWeightLog(s, mockClient({ get, post })));
    const { out, isError } = await call(client, "whoop_weight_log", { ...args, confirm: true });
    expect(isError).toBe(false);
    expect(post).toHaveBeenCalledWith(PATH, { timestamp: "2026-11-21T14:20:00.000-0800", weight_kg: kg, body_fat_percent: 0.2, lean_body_mass_kg: added.lean });
    expect(out).toMatchObject({ action: "add", id: "r-new", verified: true, profile_kg: Math.round(kg * 100) / 100, reading: { kg: Math.round(kg * 1e3) / 1e3, fat_pct: 20 } });
    // Pre-read and read-back are fresh.
    expect(get.mock.calls.filter(([p]) => p === PATH).every(([, , o]) => (o as { fresh: boolean }).fresh)).toBe(true);
  });

  it("reports verified:false when the reading doesn't show up", async () => {
    const get = routedGet({ [PATH]: page([EXISTING]), [BOOT]: { profile: { weight: 80 } } });
    const client = await connect((s) => registerWeightLog(s, mockClient({ get, post: vi.fn().mockResolvedValue(undefined) })));
    const { out } = await call(client, "whoop_weight_log", { ...args, confirm: true });
    expect(out.verified).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/didn't show up/);
  });

  it("turns a WHOOP rejection into a structured error", async () => {
    const post = vi.fn().mockRejectedValue(new WhoopApiError(422, PATH, ""));
    const client = await connect((s) => registerWeightLog(s, mockClient({ get: routedGet({ [PATH]: page([]) }), post })));
    const { out, isError } = await call(client, "whoop_weight_log", { ...args, confirm: true });
    expect(isError).toBe(true);
    expect(out).toMatchObject({ status: 422, endpoint: PATH });
  });
});

describe("whoop_weight_log edit / delete", () => {
  const withFat: R = { id: "r-1", ts: "2026-11-21T22:05:00.000Z", kg: 80, fat: 0.2, lean: 64 };

  it("PUTs the full body: new weight, kept time, body fat carried over (lean follows)", async () => {
    const put = vi.fn().mockResolvedValue({});
    const edited: R = { ...withFat, kg: 82, lean: 65.6 };
    const get = routedGet({ [PATH]: seq(page([withFat]), page([edited])), [BOOT]: { profile: { weight: 82 } } });
    const client = await connect((s) => registerWeightLog(s, mockClient({ get, put })));
    const { out } = await call(client, "whoop_weight_log", { action: "edit", reading_id: "r-1", weight: 82, unit: "kg", confirm: true });
    expect(put).toHaveBeenCalledWith(`${PATH}/r-1`, { timestamp: "2026-11-21T14:05:00.000-0800", weight_kg: 82, body_fat_percent: 0.2, lean_body_mass_kg: 65.6 });
    expect(out).toMatchObject({ action: "edit", id: "r-1", verified: true, profile_kg: 82 });
  });

  it("body_fat_pct:null clears body composition", async () => {
    const put = vi.fn().mockResolvedValue({});
    const get = routedGet({ [PATH]: seq(page([withFat]), page([{ ...withFat, fat: null, lean: null }])), [BOOT]: { profile: { weight: 80 } } });
    const client = await connect((s) => registerWeightLog(s, mockClient({ get, put })));
    await call(client, "whoop_weight_log", { action: "edit", reading_id: "r-1", body_fat_pct: null, confirm: true });
    expect(put.mock.calls[0]![1]).toMatchObject({ weight_kg: 80, body_fat_percent: null, lean_body_mass_kg: null });
  });

  it("refuses to edit an integration reading", async () => {
    const put = vi.fn();
    const get = routedGet({ [PATH]: page([{ ...EXISTING, save: null, source: "apple_health_kit" }]) });
    const client = await connect((s) => registerWeightLog(s, mockClient({ get, put })));
    const { isError, out } = await call(client, "whoop_weight_log", { action: "edit", reading_id: "r-1", weight: 81, unit: "kg", confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/apple_health_kit.*only be deleted/);
    expect(put).not.toHaveBeenCalled();
  });

  it("won't DELETE an id it can't find (WHOOP answers 204 to anything)", async () => {
    const del = vi.fn();
    const client = await connect((s) => registerWeightLog(s, mockClient({ get: routedGet({ [PATH]: page([EXISTING]) }), delete: del })));
    const { isError } = await call(client, "whoop_weight_log", { action: "delete", reading_id: "nope", confirm: true });
    expect(isError).toBe(true);
    expect(del).not.toHaveBeenCalled();
  });

  it("previews a delete with the profile-weight warning, then verifies the id is gone", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const get = routedGet({ [PATH]: seq(page([EXISTING]), page([EXISTING]), page([])), [BOOT]: { profile: { weight: 80 } } });
    const client = await connect((s) => registerWeightLog(s, mockClient({ get, delete: del })));
    const preview = await call(client, "whoop_weight_log", { action: "delete", reading_id: "r-1" });
    expect(preview.out.will_execute).toMatchObject({ method: "DELETE", path: `${PATH}/r-1` });
    expect(preview.out.warnings.join(" ")).toMatch(/never reverts the profile weight/);
    expect(del).not.toHaveBeenCalled();
    const { out } = await call(client, "whoop_weight_log", { action: "delete", reading_id: "r-1", confirm: true });
    expect(del).toHaveBeenCalledWith(`${PATH}/r-1`);
    expect(out).toMatchObject({ action: "delete", id: "r-1", verified: true, profile_kg: 80 });
  });
});
