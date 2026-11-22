// whoop_journal_log v2: partial PUT by default, full PUT only for notes /
// replace_day (carrying current notes and answers), 43+79 split, read-back.
import { describe, expect, it } from "vitest";
import { registerJournalLog } from "../../src/tools/v2/journal_log.js";
import { WhoopApiError } from "../../src/whoop/errors.js";
import { connect, mockWhoop, parse, toolBudget } from "./journal_profile_helpers.js";

const D = "2026-11-20";
const D2 = "2026-11-19";
const DRAFT = (d: string) => `/journal-service/v3/journals/drafts/mobile/${d}`;
const PARTIAL = "/journal-service/v2/journal/entry/partial";
const FULL = (d: string) => `/journal-service/v2/journals/entries/user/date/${d}`;

const T = {
  1: { id: 1, title: "Alcohol", internal_name: "alcohol", time_label: "When was your last drink?",
    magnitude: { type: "range", units: "Drinks", minimum_inclusive: 1, maximum_inclusive: 20, choices: [] } },
  2: { id: 2, title: "Caffeine", internal_name: "caffeine", time_label: "When was your last serving?",
    magnitude: { type: "range", units: "Servings", minimum_inclusive: 1, maximum_inclusive: 10, choices: [] } },
  43: { id: 43, title: "Menstruation", internal_name: "menstruation", time_label: null,
    magnitude: { type: "step", units: null, choices: [{ value: 0, label: "Light" }, { value: 1, label: "Moderate" }, { value: 2, label: "Heavy" }] } },
  79: { id: 79, title: "Ovulation", internal_name: "ovulation", time_label: null, magnitude: null },
  177: { id: 177, title: "Headache", internal_name: "headache", time_label: null,
    magnitude: { type: "step", units: null, choices: [{ value: 0, label: "Slight" }, { value: 1, label: "Moderate" }, { value: 2, label: "Intense" }] } },
  171: { id: 171, title: "Momentous Sleep Pack", internal_name: "momentous-sleep-pack", time_label: null, magnitude: null },
  163752: { id: 163752, title: "Probe Hip Mobility", internal_name: "custom-163752", time_label: null, magnitude: null },
} as const;
type Id = keyof typeof T;
const LIVE = Object.values(T);

type Input = { answered_yes?: boolean | null; magnitude_input_value?: number | null; magnitude_input_label?: string | null; time_input_value?: number | null; source?: string };
/** A v3 draft: every live tracker, answered per `answers`. */
function draft(answers: Partial<Record<Id, Input>>, notes: string | null = null) {
  return {
    journal: {
      notes,
      user_reviewed: true,
      tracked_behaviors: LIVE.map((t) => ({
        behavior_tracker: t,
        tracker_input: {
          behavior_tracker_id: t.id, answered_yes: null, magnitude_input_value: null, magnitude_input_label: null,
          time_input_value: null, source: "USER", ever_ai_sourced: false, ...answers[t.id as Id],
        },
      })),
    },
  };
}

/** Routes: the live catalog, and each date's draft as [before, after]. */
const CUSTOMIZE = "/journal-service/v3/journals/behaviors";
/** The customize screen with every custom behaviour tracked (nothing hidden). */
const ALL_TRACKED = { grouped_toggles: [{ toggles: LIVE.map((t) => ({ id: String(t.id), title: t.title, selected: true, custom: t.id === 163752 })) }] };
function whoopFor(days: Record<string, [unknown, unknown?]>, extra: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = { "/journal-service/v2/journals/behaviors/user/*": LIVE, [CUSTOMIZE]: ALL_TRACKED, ...extra };
  for (const [d, [before, after]] of Object.entries(days)) routes[DRAFT(d)] = (n: number) => (n === 1 ? before : after ?? before);
  return mockWhoop(routes);
}

async function call(whoop: ReturnType<typeof mockWhoop>, args: Record<string, unknown>) {
  const client = await connect(registerJournalLog, whoop);
  const result = await client.callTool({ name: "whoop_journal_log", arguments: { confirm: true, ...args } });
  return { result, out: parse(result) };
}

describe("whoop_journal_log: partial (default)", () => {
  it("merges one behaviour with the partial PUT and verifies the read-back", async () => {
    const whoop = whoopFor({ [D]: [draft({ 2: { answered_yes: true, magnitude_input_value: 2, source: "AI" } }, "keep me"), draft({ 2: { answered_yes: true, magnitude_input_value: 3 } }, "keep me")] });
    const { result, out } = await call(whoop, { date: D, behaviors: [{ name: "caffeine", magnitude: 3 }] });
    expect(result.isError).toBeFalsy();
    expect(whoop.put).toHaveBeenCalledTimes(1);
    expect(whoop.put).toHaveBeenCalledWith(PARTIAL, {
      tracker_inputs: { [D]: { tracker_input_eggs: [{ behavior_tracker_id: 2, answered_yes: true, magnitude_input_value: 3, magnitude_input_label: "3" }] } },
    });
    expect(out).toMatchObject({ written: true, method: "partial", verified: true, dates: [D] });
    expect(out.rows[0]).toMatchObject({ id: 2, name: "Caffeine", yes: true, value: 3 });
    // Pre-read and read-back are both fresh.
    expect(whoop.get).toHaveBeenCalledWith(DRAFT(D), {}, { fresh: true });
  });

  it("carries the stored magnitude and time of a yes row (WHOOP replaces rows whole)", async () => {
    const stored = { answered_yes: true, magnitude_input_value: 2, magnitude_input_label: "2", time_input_value: 1795237200 };
    const whoop = whoopFor({ [D]: [draft({ 1: stored }), draft({ 1: stored })] });
    const { out } = await call(whoop, { date: D, behaviors: [{ id: 1 }] });
    expect(whoop.put.mock.calls[0]![1]).toEqual({
      tracker_inputs: { [D]: { tracker_input_eggs: [{ behavior_tracker_id: 1, answered_yes: true, magnitude_input_value: 2, magnitude_input_label: "2", time_input_value: 1795237200 }] } },
    });
    expect(out.rows[0].carried).toEqual(["magnitude", "time"]);
  });

  it("drops a stored time when time:null is passed", async () => {
    const stored = { answered_yes: true, magnitude_input_value: 3, magnitude_input_label: "3", time_input_value: 1795237200 };
    const whoop = whoopFor({ [D]: [draft({ 2: stored }), draft({ 2: { answered_yes: true, magnitude_input_value: 4 } })] });
    const { out } = await call(whoop, { date: D, behaviors: [{ id: 2, magnitude: 4, time: null }] });
    expect(whoop.put.mock.calls[0]![1]).toEqual({
      tracker_inputs: { [D]: { tracker_input_eggs: [{ behavior_tracker_id: 2, answered_yes: true, magnitude_input_value: 4, magnitude_input_label: "4" }] } },
    });
    expect(out.rows[0]).not.toHaveProperty("carried");
  });

  it("clears with a bare row for unset", async () => {
    const whoop = whoopFor({ [D]: [draft({ 79: { answered_yes: true } }), draft({})] });
    const { out } = await call(whoop, { date: D, unset: ["Ovulation"] });
    expect(whoop.put.mock.calls[0]![1]).toEqual({ tracker_inputs: { [D]: { tracker_input_eggs: [{ behavior_tracker_id: 79 }] } } });
    expect(out).toMatchObject({ verified: true });
    expect(out.rows[0]).toMatchObject({ id: 79, unset: true });
  });

  it("sends menstruation and ovulation 'yes' as two requests", async () => {
    const after = draft({ 43: { answered_yes: true, magnitude_input_value: 0 }, 79: { answered_yes: true } });
    const whoop = whoopFor({ [D]: [draft({}), after] });
    const { out } = await call(whoop, { date: D, behaviors: [{ name: "Menstruation", magnitude_label: "light" }, { name: "Ovulation" }] });
    expect(whoop.put).toHaveBeenCalledTimes(2);
    expect(whoop.put.mock.calls[0]![1]).toEqual({
      tracker_inputs: { [D]: { tracker_input_eggs: [{ behavior_tracker_id: 43, answered_yes: true, magnitude_input_value: 0, magnitude_input_label: "Light" }] } },
    });
    expect(whoop.put.mock.calls[1]![1]).toEqual({ tracker_inputs: { [D]: { tracker_input_eggs: [{ behavior_tracker_id: 79, answered_yes: true }] } } });
    expect(out).toMatchObject({ requests: 2, verified: true });
    expect(out.warnings.join(" ")).toMatch(/separate requests/);
  });

  it("writes several dates in one partial call, accepting 171 and custom ids from the live catalog", async () => {
    const yes = draft({ 171: { answered_yes: true }, 163752: { answered_yes: true } });
    const whoop = whoopFor({ [D]: [draft({}), yes], [D2]: [draft({}), yes] });
    const { out } = await call(whoop, { dates: [D, D2], behaviors: [{ id: 171 }, { name: "Probe Hip Mobility" }] });
    expect(whoop.put).toHaveBeenCalledTimes(1);
    const body = whoop.put.mock.calls[0]![1] as { tracker_inputs: Record<string, unknown> };
    expect(Object.keys(body.tracker_inputs).sort()).toEqual([D2, D]);
    expect(body.tracker_inputs[D]).toEqual({ tracker_input_eggs: [{ behavior_tracker_id: 171, answered_yes: true }, { behavior_tracker_id: 163752, answered_yes: true }] });
    expect(out).toMatchObject({ verified: true, dates: [D2, D] });
    expect(out.rows[0].date).toBe(D2);
  });

  it("still merges when the draft pre-read fails, if the row has nothing stored to lose", async () => {
    // A yes/no behaviour, and a row whose magnitude and time are both spelled out.
    const whoop = whoopFor({ [D]: [new Error("down"), draft({ 79: { answered_yes: true }, 2: { answered_yes: true, magnitude_input_value: 3 } })] });
    const { result, out } = await call(whoop, { date: D, behaviors: [{ id: 79 }, { id: 2, magnitude: 3, time: null }] });
    expect(result.isError).toBeFalsy();
    expect(whoop.put).toHaveBeenCalledWith(PARTIAL, expect.anything());
    expect(out.verified).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/Couldn't read the current journal/);
  });

  it("refuses a merge that could erase a stored magnitude or time when the draft can't be read", async () => {
    // WHOOP replaces a row whole: without the draft, re-logging Caffeine would null its stored servings and time.
    for (const failure of [new Error("down"), new WhoopApiError(404, DRAFT(D), "", "none")]) {
      const whoop = whoopFor({ [D]: [failure] });
      const { result, out } = await call(whoop, { date: D, behaviors: [{ id: 2 }, { id: 79 }] });
      expect(result.isError).toBe(true);
      expect(out.error).toMatch(/Nothing was written/);
      expect(out.error).toMatch(/Caffeine/);
      expect(whoop.put).not.toHaveBeenCalled();
    }
  });

  it("reports verified:false when the read-back doesn't show the write", async () => {
    const whoop = whoopFor({ [D]: [draft({}), draft({})] });
    const { result, out } = await call(whoop, { date: D, behaviors: [{ id: 2, magnitude: 4 }] });
    expect(result.isError).toBeFalsy();
    expect(out.verified).toBe(false);
    // jsonOut drops null keys: the stored value (null = unanswered) is simply absent.
    const miss = out.mismatches.find((m: { id: number; field: string }) => m.id === 2 && m.field === "answered_yes");
    expect(miss).toMatchObject({ expected: true });
    expect(miss).not.toHaveProperty("actual");
  });

  it("reports verified:false when a cleared magnitude or time is still stored", async () => {
    const stored = { answered_yes: true, magnitude_input_value: 3, magnitude_input_label: "3", time_input_value: 1795237200 };
    const whoop = whoopFor({ [D]: [draft({ 2: stored }), draft({ 2: stored })] });
    const { out } = await call(whoop, { date: D, behaviors: [{ id: 2, magnitude: null, time: null }] });
    expect(whoop.put.mock.calls[0]![1]).toEqual({ tracker_inputs: { [D]: { tracker_input_eggs: [{ behavior_tracker_id: 2, answered_yes: true }] } } });
    expect(out.verified).toBe(false);
    expect(out.mismatches.map((m: { field: string }) => m.field).sort()).toEqual(["magnitude", "time"]);
  });

  it("reports a partial write when the second request fails", async () => {
    const whoop = whoopFor({ [D]: [draft({})] });
    whoop.put.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new WhoopApiError(400, PARTIAL, "x", "nope"));
    const { result, out } = await call(whoop, { date: D, behaviors: [{ id: 43, magnitude: 1 }, { id: 79 }] });
    expect(result.isError).toBe(true);
    expect(out.error).toMatch(/Request 2 of 2 failed/);
  });

  it("previews without writing", async () => {
    const whoop = whoopFor({ [D]: [draft({ 2: { answered_yes: true, magnitude_input_value: 2 } })] });
    const { out } = await call(whoop, { date: D, behaviors: [{ id: 2, magnitude: 5 }], confirm: false });
    expect(whoop.put).not.toHaveBeenCalled();
    expect(out).toMatchObject({ preview: true, will_execute: { method: "PUT", path: PARTIAL } });
    expect(out.will_execute.body_summary.changes[0]).toMatchObject({ id: 2, value: 5, before: [true, 2] });
  });
});

describe("whoop_journal_log: full PUT (notes, replace_day)", () => {
  it("writes notes with the full PUT, re-sending every other answer", async () => {
    const before = draft({ 2: { answered_yes: true, magnitude_input_value: 2, magnitude_input_label: null }, 79: { answered_yes: false } }, "old");
    const after = draft({ 2: { answered_yes: true, magnitude_input_value: 2 }, 79: { answered_yes: false }, 177: { answered_yes: true, magnitude_input_value: 1 } }, "new");
    const whoop = whoopFor({ [D]: [before, after] });
    const { out } = await call(whoop, { date: D, notes: "new", behaviors: [{ name: "Headache", magnitude: 1 }] });
    expect(whoop.put).toHaveBeenCalledWith(FULL(D), {
      tracker_inputs: [
        { behavior_tracker_id: 2, answered_yes: true, magnitude_input_value: 2, magnitude_input_label: "2" },
        { behavior_tracker_id: 79, answered_yes: false },
        { behavior_tracker_id: 177, answered_yes: true, magnitude_input_value: 1, magnitude_input_label: "Moderate" },
      ],
      notes: "new",
    });
    expect(out).toMatchObject({ method: "full", verified: true, notes: { before: "old", after: "new" } });
  });

  it("replace_day keeps the current notes and drops unlisted answers", async () => {
    const before = draft({ 2: { answered_yes: true }, 79: { answered_yes: true } }, "keep me");
    const after = draft({ 171: { answered_yes: true } }, "keep me");
    const whoop = whoopFor({ [D]: [before, after] });
    const { out } = await call(whoop, { date: D, replace_day: true, behaviors: [{ id: 171 }] });
    expect(whoop.put).toHaveBeenCalledWith(FULL(D), { tracker_inputs: [{ behavior_tracker_id: 171, answered_yes: true }], notes: "keep me" });
    expect(out.removed.sort()).toEqual(["Caffeine", "Ovulation"]);
    expect(out.verified).toBe(true);
  });

  it("refuses a full-day write when the draft can't be read (PR #44's guard)", async () => {
    const whoop = whoopFor({ [D]: [new WhoopApiError(500, DRAFT(D), "", "down")] });
    const { result, out } = await call(whoop, { date: D, notes: "x" });
    expect(result.isError).toBe(true);
    expect(out.error).toMatch(/Nothing was written/);
    expect(whoop.put).not.toHaveBeenCalled();
  });

  it("refuses a full-day write on a 404 or an unrecognisable draft: WHOOP answers 200 for every date, empty ones included", async () => {
    // Live 2026-11-21: 2019-01-01, an empty October day and a future date all answer 200 with
    // journal.tracked_behaviors:[]; so a 404 or a body without `journal` is an anomaly, not an empty day.
    for (const first of [new WhoopApiError(404, DRAFT(D), "", "none"), {}, { journal: { notes: null } }, "<html>"]) {
      const whoop = whoopFor({ [D]: [first, draft({}, "hi")] });
      const { result, out } = await call(whoop, { date: D, notes: "hi" });
      expect(result.isError).toBe(true);
      expect(out.error).toMatch(/Nothing was written/);
      expect(whoop.put).not.toHaveBeenCalled();
    }
  });

  it("writes notes on a genuinely empty day (200 with no rows)", async () => {
    const empty = { journal: { tracked_behaviors: [], notes: null, user_reviewed: false, cycle_id: null } };
    const whoop = whoopFor({ [D]: [empty, { journal: { ...empty.journal, notes: "hi" } }] });
    const { out } = await call(whoop, { date: D, notes: "hi" });
    expect(whoop.put).toHaveBeenCalledWith(FULL(D), { tracker_inputs: [], notes: "hi" });
    expect(out.verified).toBe(true);
  });

  it("warns that answers of untracked custom behaviours can't be carried by a full-day write", async () => {
    // Live 2026-11-21: WHOOP leaves an untracked custom behaviour's answer out of the draft, and the
    // full PUT then deletes it for good (re-tracking showed it gone; without the PUT it came back).
    const stockOnly = LIVE.filter((t) => t.id !== 163752);
    const screen = { grouped_toggles: [{ toggles: [
      { id: "2", title: "Caffeine", internal_name: "caffeine", selected: true, custom: false },
      { id: "163752", title: "Probe Hip Mobility", internal_name: "Probe Hip Mobility", selected: false, custom: true },
    ] }] };
    const day = (notes: string | null) => ({ journal: { notes, user_reviewed: true, tracked_behaviors: stockOnly.map((t) => ({ behavior_tracker: t, tracker_input: null })) } });
    const routes = { "/journal-service/v2/journals/behaviors/user/*": stockOnly, [CUSTOMIZE]: screen };
    const preview = await call(whoopFor({ [D]: [day("old")] }, routes), { date: D, notes: "new", confirm: false });
    expect(preview.out.will_execute.body_summary.warnings.join(" ")).toMatch(/Probe Hip Mobility.*deleted/);
    const written = await call(whoopFor({ [D]: [day("old"), day("new")] }, routes), { date: D, notes: "new" });
    expect(written.out.verified).toBe(true);
    expect(written.out.warnings.join(" ")).toMatch(/Probe Hip Mobility/);
  });

  it("doesn't read the customize screen for a merge, and stays quiet when every custom behaviour is tracked", async () => {
    const merge = whoopFor({ [D]: [draft({}), draft({ 79: { answered_yes: true } })] });
    await call(merge, { date: D, behaviors: [{ id: 79 }] });
    expect(merge.get).not.toHaveBeenCalledWith(CUSTOMIZE, expect.anything(), expect.anything());
    const full = whoopFor({ [D]: [draft({}, "old"), draft({}, "new")] });
    const { out } = await call(full, { date: D, notes: "new" });
    expect(full.get).toHaveBeenCalledWith(CUSTOMIZE, {}, { fresh: true });
    expect(out).not.toHaveProperty("warnings");
  });

  it("refuses replace_day + notes too when the draft can't be read (it couldn't show what it removes)", async () => {
    const whoop = whoopFor({ [D]: [new WhoopApiError(500, DRAFT(D), "", "down")] });
    const { result, out } = await call(whoop, { date: D, replace_day: true, notes: "x", behaviors: [{ id: 2 }] });
    expect(result.isError).toBe(true);
    expect(out.error).toMatch(/Nothing was written/);
    expect(whoop.put).not.toHaveBeenCalled();
  });
});

describe("whoop_journal_log: validation (nothing is sent)", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["future date", { date: "2099-01-01", behaviors: [{ id: 2 }] }, /future/],
    ["date and dates", { date: D, dates: [D], behaviors: [{ id: 2 }] }, /not both/],
    ["notes across dates", { dates: [D, D2], notes: "x" }, /one day at a time/],
    ["nothing to write", { date: D }, /Nothing to write/],
    ["range out of bounds", { date: D, behaviors: [{ name: "Caffeine", magnitude: 50 }] }, /1–10 Servings; got 50/],
    ["magnitude on a yes/no behaviour", { date: D, behaviors: [{ id: 79, magnitude: 1 }] }, /takes no magnitude/],
    ["step value not a choice", { date: D, behaviors: [{ id: 177, magnitude: 7 }] }, /0=Slight, 1=Moderate, 2=Intense/],
    ["time on a behaviour without a time question", { date: D, behaviors: [{ id: 177, time: "2026-11-20T10:00:00.000Z" }] }, /doesn't ask for a time/],
    ["future time", { date: D, behaviors: [{ id: 1, time: "2099-01-01T10:00:00.000Z" }] }, /future/],
    ["magnitude with answered_yes false", { date: D, behaviors: [{ id: 2, answered_yes: false, magnitude: 2 }] }, /only goes with answered_yes:true/],
    ["set and unset together", { date: D, behaviors: [{ id: 2 }], unset: [2] }, /both set and unset/],
    ["listed twice", { date: D, behaviors: [{ id: 2 }, { name: "Caffeine" }] }, /listed twice/],
  ];
  for (const [label, args, message] of cases) {
    it(`refuses: ${label}`, async () => {
      const whoop = whoopFor({ [D]: [draft({})], [D2]: [draft({})] });
      const { result } = await call(whoop, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(message);
      expect(whoop.put).not.toHaveBeenCalled();
    });
  }

  it("suggests close names for an unknown behaviour", async () => {
    const whoop = whoopFor({ [D]: [draft({})] });
    const { result, out } = await call(whoop, { date: D, behaviors: [{ name: "cafeine" }] });
    expect(result.isError).toBe(true);
    expect(out.problems[0].suggestions[0]).toEqual({ id: 2, title: "Caffeine" });
  });

  it("stays inside the description budgets", async () => {
    const client = await connect(registerJournalLog, mockWhoop({}));
    for (const t of await toolBudget(client)) {
      expect(t.description).toBeLessThanOrEqual(600);
      expect(t.longestDescribe).toBeLessThanOrEqual(80);
    }
  });
});
