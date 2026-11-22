import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerCycleLog } from "../../src/tools/v2/cycle_log.js";
import { WhoopApiError, WhoopServerError } from "../../src/whoop/errors.js";
import { findAll } from "../../src/whoop/bff.js";
import { call, connect, fx, mockClient, routedGet, seq } from "./health_plans_helpers.js";

const WH = "/womens-health-service/v1";
const OVERVIEW = `${WH}/hormonal-insights/overview`;
const SCREEN = `${WH}/symptom-insights/log/symptoms/screen`;
const LOG = `${WH}/menstrual-cycle-insights/log`;
const POST = `${WH}/symptom-insights/log/symptoms`;

beforeAll(() => { process.env.WHOOP_TIMEZONE = "America/Los_Angeles"; });

type AnyNode = Record<string, any>;

/** The Oct overview with `date` set to a calendar state and the ovulation toggle for that date. */
function overview(date: string, state: "PERIOD" | "NONE", ovulationLogged: boolean) {
  const o = structuredClone(fx("hi_overview_period_day.json")) as AnyNode;
  for (const d of findAll(o, (n) => n.type === "HORMONAL_INSIGHTS_CALENDAR_DAY")) {
    if ((d.content as AnyNode).date === date) (d.content as AnyNode).day_state = state;
  }
  const [y, m, dd] = date.split("-").map(Number);
  for (const n of findAll(o, (x) => Array.isArray(x.period_logs))) {
    const entry = (n.period_logs as AnyNode[])[0]!;
    entry.date = [y, m, dd];
    entry.ovulation.answered_yes = !ovulationLogged;
  }
  return o;
}

/** The symptom screen with chosen flow / mucus and tracker answers. */
function screen(opts: { flow?: string | null; mucus?: string | null; inputs?: Record<number, { yes: boolean; mag?: number }> }) {
  const s = structuredClone(fx("symptom_screen.json")) as AnyNode;
  for (const list of findAll(s, (n) => n.type === "SELECTABLE_CELL_LIST")) {
    const c = list.content as AnyNode;
    const want = c.id === "menstruation" ? opts.flow : opts.mucus;
    if (want !== undefined) for (const cell of c.cells) cell.selected = cell.id === want;
  }
  if (opts.flow !== undefined || opts.mucus !== undefined) delete s.lifecycle_interactions;
  for (const t of findAll(s, (n) => n.type === "TRACKED_BEHAVIOR")) {
    const c = t.content as AnyNode;
    const want = opts.inputs?.[c.behavior_tracker.id];
    if (want) c.tracker_input = { behavior_tracker_id: c.behavior_tracker.id, answered_yes: want.yes, magnitude_input_value: want.mag ?? null };
  }
  return s;
}

const DATE = "2026-10-20";

describe("whoop_cycle_log validation", () => {
  it.each([
    ["nothing to log", {}, /Nothing to log/],
    ["future date", { date: "2099-01-01", period: { yes: true } }, /future/],
    ["period and ovulation together", { period: { yes: true }, ovulation: { yes: true } }, /same date/],
    ["flow without a period", { period: { yes: false, flow: 1 } }, /flow only applies/],
    ["a flow while removing the period", { period: { yes: false }, menstruation: "light_flow" }, /logs a period day/],
  ])("%s", async (_n, args, re) => {
    const get = routedGet({});
    const put = vi.fn();
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put })));
    const { isError, out } = await call(client, "whoop_cycle_log", { date: DATE, ...args, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(re);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects cervical mucus outside the schema enum", async () => {
    const client = await connect((s) => registerCycleLog(s, mockClient({ get: routedGet({}) })));
    const res = await client.callTool({ name: "whoop_cycle_log", arguments: { date: DATE, cervical_mucus: "none" } });
    expect(res.isError).toBe(true);
  });

  it.each([
    [[{ name: "Headake" }], /Unknown symptom "Headake". Closest: Headache/],
    [[{ id: 999999 }], /isn't on WHOOP's symptom screen/],
    [[{ name: "Headache", magnitude: 3 }], /Headache magnitude must be one of 0, 1, 2/],
    [[{ name: "Sleep Disruption", magnitude: 5000 }], /between 1 and 1000/],
    [[{ name: "Acne", magnitude: 1 }], /Acne takes no magnitude/],
    [[{ name: "Acne" }, { id: 210 }], /listed twice/],
  ])("validates symptoms against the live screen: %j", async (symptoms, re) => {
    const post = vi.fn();
    const client = await connect((s) => registerCycleLog(s, mockClient({ get: routedGet({ [SCREEN]: screen({}) }), post })));
    const { isError, out } = await call(client, "whoop_cycle_log", { date: DATE, symptoms, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(re);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("whoop_cycle_log period / ovulation", () => {
  it("logs a period: preview warns about sticky cycles; the PUT sends both fields (ovulation false)", async () => {
    const put = vi.fn().mockResolvedValue({ generic_interaction: null });
    const get = routedGet({ [OVERVIEW]: seq(overview(DATE, "NONE", false), overview(DATE, "NONE", false), overview(DATE, "PERIOD", false)), [SCREEN]: screen({ flow: null, mucus: null }) });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put })));
    const args = { date: DATE, period: { yes: true, flow: 2 } };
    const preview = await call(client, "whoop_cycle_log", args);
    expect(put).not.toHaveBeenCalled();
    expect(preview.out.warnings.join(" ")).toMatch(/creates a cycle entry that undoing the period won't remove/);
    expect(preview.out.current).toMatchObject({ period_day: false, ovulation_logged: false });

    const { out } = await call(client, "whoop_cycle_log", { ...args, confirm: true });
    expect(put).toHaveBeenCalledWith(LOG, { period_logs: [{ date: DATE, period: { answered_yes: true, magnitude_input_value: 2 }, ovulation: { answered_yes: false, magnitude_input_value: null } }] });
    expect(out).toMatchObject({ date: DATE, verified: true, day: { period_day: true, ovulation: false } });
    expect(out.mismatches).toBeUndefined();
    expect(get.mock.calls.filter(([p]) => p === OVERVIEW).every(([, , o]) => (o as { fresh: boolean }).fresh)).toBe(true);
  });

  it("undoes a period with answered_yes:false for both", async () => {
    const put = vi.fn().mockResolvedValue({});
    const get = routedGet({ [OVERVIEW]: seq(overview(DATE, "PERIOD", false), overview(DATE, "NONE", false)), [SCREEN]: screen({ flow: null, mucus: null }) });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put })));
    const { out } = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: false }, confirm: true });
    expect(put.mock.calls[0]![1]).toEqual({ period_logs: [{ date: DATE, period: { answered_yes: false, magnitude_input_value: null }, ovulation: { answered_yes: false, magnitude_input_value: null } }] });
    expect(out.verified).toBe(true);
  });

  it("refuses an ovulation undo that would wipe a logged period", async () => {
    const put = vi.fn();
    const client = await connect((s) => registerCycleLog(s, mockClient({ get: routedGet({ [OVERVIEW]: overview(DATE, "PERIOD", false) }), put })));
    const { isError, out } = await call(client, "whoop_cycle_log", { date: DATE, ovulation: { yes: false }, confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/No ovulation is logged.*but a period is/);
    expect(put).not.toHaveBeenCalled();
  });

  it("warns that logging ovulation replaces a period", async () => {
    const client = await connect((s) => registerCycleLog(s, mockClient({ get: routedGet({ [OVERVIEW]: overview(DATE, "PERIOD", false) }) })));
    const { out } = await call(client, "whoop_cycle_log", { date: DATE, ovulation: { yes: true } });
    expect(out.will_execute.body_summary.period_logs[0]).toMatchObject({ period: { answered_yes: false }, ovulation: { answered_yes: true } });
    expect(out.warnings.join(" ")).toMatch(/logging ovulation removes the period/);
  });

  it("maps WHOOP's 400 to a structured error", async () => {
    const put = vi.fn().mockRejectedValue(new WhoopApiError(400, LOG, "Cannot have both period and ovulation on the same day"));
    const client = await connect((s) => registerCycleLog(s, mockClient({ get: routedGet({ [OVERVIEW]: overview(DATE, "NONE", false) }), put })));
    const { isError, out } = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: true }, confirm: true });
    expect(isError).toBe(true);
    expect(out).toMatchObject({ status: 400, reason: "Cannot have both period and ovulation on the same day" });
  });
});

describe("whoop_cycle_log symptoms", () => {
  it("re-sends the current flow and mucus (they replace) when only symptoms change", async () => {
    const post = vi.fn().mockResolvedValue({});
    const before = screen({ flow: "light_flow", mucus: "vaginal-discharge---creamy" });
    const after = screen({ flow: "light_flow", mucus: "vaginal-discharge---creamy", inputs: { 95: { yes: true, mag: 2 }, 211: { yes: false } } });
    const get = routedGet({ [SCREEN]: seq(before, after), [OVERVIEW]: overview(DATE, "PERIOD", false) });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, post })));
    const args = { date: DATE, symptoms: [{ name: "irritability", magnitude: 2 }, { id: 211, yes: false }] };
    const preview = await call(client, "whoop_cycle_log", args);
    expect(preview.out.warnings.join(" ")).toMatch(/Flow "light_flow" also logs a period day/);
    expect(post).not.toHaveBeenCalled();

    const { out } = await call(client, "whoop_cycle_log", { ...args, confirm: true });
    expect(post).toHaveBeenCalledWith(POST, {
      tracker_inputs: [
        { behavior_tracker_id: 95, answered_yes: true, magnitude_input_value: 2, is_suggested: false },
        { behavior_tracker_id: 211, answered_yes: false, is_suggested: false },
      ],
      menstruation: "light_flow",
      cervical_mucus: "vaginal-discharge---creamy",
    }, { requestDate: DATE });
    expect(out).toMatchObject({ verified: true, day: { flow: "light_flow", mucus: "vaginal-discharge---creamy" } });
    expect(out.day.symptoms).toContainEqual({ id: 95, name: "Irritability", yes: true, mag: 2 });
  });

  it("null clears a field by leaving it out; new values are sent as given", async () => {
    const post = vi.fn().mockResolvedValue({});
    const before = screen({ flow: "light_flow", mucus: "vaginal-discharge---creamy" });
    const after = screen({ flow: null, mucus: "vaginal-dryness" });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get: routedGet({ [SCREEN]: seq(before, after), [OVERVIEW]: overview(DATE, "NONE", false) }), post })));
    const { out } = await call(client, "whoop_cycle_log", { date: DATE, menstruation: null, cervical_mucus: "vaginal-dryness", confirm: true });
    expect(post.mock.calls[0]![1]).toEqual({ tracker_inputs: [], cervical_mucus: "vaginal-dryness" });
    expect(out.verified).toBe(true);
  });

  it("reports mismatches when the read-back differs", async () => {
    const post = vi.fn().mockResolvedValue({});
    const client = await connect((s) => registerCycleLog(s, mockClient({ get: routedGet({ [SCREEN]: screen({ flow: null, mucus: null }), [OVERVIEW]: overview(DATE, "NONE", false) }), post })));
    const { out } = await call(client, "whoop_cycle_log", { date: DATE, symptoms: [{ name: "Headache", magnitude: 2 }], confirm: true });
    expect(out.verified).toBe(false);
    expect(out.mismatches.join(" ")).toMatch(/Headache/);
  });

  it("does the period PUT before the symptom POST", async () => {
    const order: string[] = [];
    const put = vi.fn(async () => { order.push("PUT"); });
    const post = vi.fn(async () => { order.push("POST"); });
    const get = routedGet({ [OVERVIEW]: overview(DATE, "NONE", false), [SCREEN]: screen({ flow: null, mucus: null }) });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put, post })));
    await call(client, "whoop_cycle_log", { date: DATE, period: { yes: true }, cervical_mucus: "vaginal-discharge---sticky", confirm: true });
    expect(order).toEqual(["PUT", "POST"]);
  });
});

// The period log and the flow chip are two views of one thing (a flow chip logs a period
// day; a period logged with a flow shows as that chip), and WHOOP's two requests each
// replace what they carry. These cases are where one request undoes the other.
describe("whoop_cycle_log: one request must not undo the other", () => {
  it("both logged (flow chip + ovulation, as on the test account's 11-21): removing one alone is refused", async () => {
    const put = vi.fn();
    const get = routedGet({ [OVERVIEW]: overview(DATE, "PERIOD", true) });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put })));
    const ov = await call(client, "whoop_cycle_log", { date: DATE, ovulation: { yes: false }, confirm: true });
    expect(ov.isError).toBe(true);
    expect(ov.out.error).toMatch(/both a period and ovulation.*period:\{yes:true\} to keep the period/);
    const pd = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: false }, confirm: true });
    expect(pd.isError).toBe(true);
    expect(pd.out.error).toMatch(/both a period and ovulation.*ovulation:\{yes:true\} to keep the ovulation/);
    expect(put).not.toHaveBeenCalled();
    // Saying what happens to the other one is enough.
    const explicit = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: true }, ovulation: { yes: false } });
    expect(explicit.out.will_execute.body_summary.period_logs[0]).toMatchObject({ period: { answered_yes: true }, ovulation: { answered_yes: false } });
  });

  it("removing the period while re-sending the day's flow chip is refused (the chip would log it right back)", async () => {
    const put = vi.fn().mockResolvedValue({});
    const post = vi.fn().mockResolvedValue({});
    const get = routedGet({ [OVERVIEW]: overview(DATE, "PERIOD", false), [SCREEN]: screen({ flow: "light_flow", mucus: null }) });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put, post })));
    const { isError, out } = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: false }, symptoms: [{ name: "Headache" }], confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/flow chip "light_flow".*menstruation:null/);
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("a full undo clears the chip first, then removes the period (the order verified live)", async () => {
    const order: string[] = [];
    const put = vi.fn(async () => { order.push("PUT"); });
    const post = vi.fn(async () => { order.push("POST"); });
    const get = routedGet({
      [OVERVIEW]: seq(overview(DATE, "PERIOD", false), overview(DATE, "NONE", false)),
      [SCREEN]: seq(screen({ flow: "light_flow", mucus: "vaginal-discharge---creamy" }), screen({ flow: null, mucus: "vaginal-discharge---creamy" })),
    });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put, post })));
    const { out } = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: false }, menstruation: null, confirm: true });
    expect(order).toEqual(["POST", "PUT"]);
    expect(post).toHaveBeenCalledWith(POST, { tracker_inputs: [], cervical_mucus: "vaginal-discharge---creamy" }, { requestDate: DATE });
    expect(out).toMatchObject({ verified: true, day: { period_day: false, mucus: "vaginal-discharge---creamy" } });
  });

  it("a period day that is still there after removing it is verified:false, with the flow chip named as the reason", async () => {
    const put = vi.fn().mockResolvedValue({});
    const get = routedGet({ [OVERVIEW]: overview(DATE, "PERIOD", false), [SCREEN]: screen({ flow: "light_flow", mucus: null }) });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put })));
    const { out } = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: false }, confirm: true });
    expect(put).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ verified: false, day: { period_day: true, flow: "light_flow" } });
    expect(out.mismatches.join(" ")).toMatch(/period day reads back true/);
    expect(out.warnings.join(" ")).toMatch(/flow chip "light_flow" is still set.*menstruation:null/);
  });

  it("period with a flow + symptoms: the chip the period request set is re-read and carried, not cleared", async () => {
    const put = vi.fn().mockResolvedValue({});
    const post = vi.fn().mockResolvedValue({});
    const get = routedGet({
      [OVERVIEW]: seq(overview(DATE, "NONE", false), overview(DATE, "PERIOD", false)),
      // before anything; after the PUT (WHOOP shows the period's flow as the chip); after the POST
      [SCREEN]: seq(screen({ flow: null, mucus: null }), screen({ flow: "heavy_flow", mucus: null }), screen({ flow: "heavy_flow", mucus: null, inputs: { 177: { yes: true } } })),
    });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put, post })));
    const { out } = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: true, flow: 2 }, symptoms: [{ name: "Headache" }], confirm: true });
    expect(post).toHaveBeenCalledWith(POST, { tracker_inputs: [{ behavior_tracker_id: 177, answered_yes: true, is_suggested: false }], menstruation: "heavy_flow" }, { requestDate: DATE });
    expect(out).toMatchObject({ verified: true, day: { period_day: true, flow: "heavy_flow" } });
  });

  it("a 500 on the second request says the first one already went through", async () => {
    const put = vi.fn().mockResolvedValue({});
    const post = vi.fn().mockRejectedValue(new WhoopServerError(500, POST, "Error 500"));
    const get = routedGet({ [OVERVIEW]: overview(DATE, "NONE", false), [SCREEN]: screen({ flow: null, mucus: null }) });
    const client = await connect((s) => registerCycleLog(s, mockClient({ get, put, post })));
    const { isError, out } = await call(client, "whoop_cycle_log", { date: DATE, period: { yes: true }, symptoms: [{ name: "Headache" }], confirm: true });
    expect(isError).toBe(true);
    expect(out).toMatchObject({ status: 500, hint: `Already applied before this failed: PUT ${LOG}.` });
  });

  it("won't send a symptom log when the current flow / mucus can't be read (omitting them clears them)", async () => {
    const post = vi.fn().mockResolvedValue({});
    // A screen with the trackers but without the chip lists totem knows.
    const odd = screen({});
    for (const list of findAll(odd, (n) => n.type === "SELECTABLE_CELL_LIST")) list.type = "CHIP_GROUP_V2";
    delete odd.lifecycle_interactions;
    const client = await connect((s) => registerCycleLog(s, mockClient({ get: routedGet({ [SCREEN]: odd }), post })));
    const { isError, out } = await call(client, "whoop_cycle_log", { date: DATE, symptoms: [{ name: "Headache" }], confirm: true });
    expect(isError).toBe(true);
    expect(out.error).toMatch(/Couldn't read the current menstruation/);
    expect(post).not.toHaveBeenCalled();
    // Naming both fields makes the log explicit, so it can go out.
    const explicit = await call(client, "whoop_cycle_log", { date: DATE, symptoms: [{ name: "Headache" }], menstruation: null, cervical_mucus: null });
    expect(explicit.out.will_execute.body_summary).toEqual({ tracker_inputs: [{ behavior_tracker_id: 177, answered_yes: true, is_suggested: false }] });
  });
});
