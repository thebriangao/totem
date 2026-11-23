import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerCalendar } from "../../src/tools/v2/calendar.js";
import { projectCalendarV2, stateChar } from "../../src/projections/v2/calendar.js";
import { CalendarV2Out } from "../../src/schemas/v2/calendar.js";
import { call, closeAll, connect, fx, oldFx, paths, pinToday, queryFor, routedGet, unpinToday } from "./reads_core_harness.js";

describe("whoop_calendar projection", () => {
  it("encodes one character per day of the month, built from the requested month", () => {
    const out = CalendarV2Out.parse(projectCalendarV2(oldFx("calendar_recovery"), "recovery", "2026-05-23"));
    expect(out.month).toBe("2026-05");
    expect(out.days).toHaveLength(31);
    expect(out.days.slice(0, 3)).toBe("LMM"); // May 1 LOW, May 2–3 MEDIUM
    expect(out.key).toEqual({ L: "<34%", M: "34% - 66%", H: ">66%" });
  });

  it("separates 'data but no score' from 'no data' and keeps future days", () => {
    const strain = projectCalendarV2(fx("cal_strain"), "strain", "2026-11-03");
    expect(strain.days).toHaveLength(30);
    expect(strain.days.slice(19, 25)).toBe("LHL..-"); // 20 low, 21 high, 22 low, 25 data/no score (a future day)
    expect(strain.key).toEqual({ H: "Day Strain 10.0+" });
    expect(projectCalendarV2(fx("cal_sleep"), "sleep", "2026-11-21").days.slice(19, 22)).toBe("---");
    expect(stateChar("LOW_SLEEP", true)).toBe("L");
    expect(stateChar(null, false)).toBe(".");
  });
});

// Synthetic, shaped like GET /journal-service/v2/journals/{date}/calendar (2026-11-22).
const JOURNAL_CAL = {
  calendar_title_display: "NOVEMBER",
  days_of_month: Array.from({ length: 30 }, (_, i) => ({
    date_value_display: String(i + 1), cycle_id: 1000 + i,
    day_state: [0, 1, 4].includes(i) ? "HAS_JOURNAL_ENTRY" : "NO_DATA", has_data: [0, 1, 4].includes(i),
  })),
};

describe("whoop_calendar journal", () => {
  it("marks journal days with J and keys them", () => {
    const out = CalendarV2Out.parse(projectCalendarV2(JOURNAL_CAL, "journal", "2026-11-21"));
    expect(out.days.slice(0, 6)).toBe("JJ..J.");
    expect(out.days).toHaveLength(30);
    expect(out.key).toEqual({ J: "Journal entry" });
  });
});

describe("whoop_calendar tool", () => {
  beforeAll(pinToday);
  afterAll(unpinToday);
  afterEach(closeAll);

  it("reads the pillar's calendar for the month containing the date", async () => {
    const get = routedGet({ "/home-service/v1/calendar/strain": fx("cal_strain"), "/home-service/v1/calendar/recovery": fx("cal_recovery") });
    const out = await call(await connect(registerCalendar, get), "whoop_calendar", { pillar: "strain", date: "2026-11-02" });
    expect(paths(get)).toEqual(["/home-service/v1/calendar/strain"]);
    expect(queryFor(get, "/home-service/v1/calendar/strain")).toEqual({ date: "2026-11-02" });
    expect(out).toMatchObject({ pillar: "strain", month: "2026-11" });
    const def = await call(await connect(registerCalendar, get), "whoop_calendar");
    expect(def).toMatchObject({ pillar: "recovery", month: "2026-11" });
  });

  it("reads the journal calendar with the date in the path", async () => {
    const get = routedGet({ "/journal-service/v2/journals/2026-11-21/calendar": JOURNAL_CAL });
    const out = await call(await connect(registerCalendar, get), "whoop_calendar", { pillar: "journal", date: "2026-11-21" });
    expect(paths(get)).toEqual(["/journal-service/v2/journals/2026-11-21/calendar"]);
    expect(out).toMatchObject({ pillar: "journal", month: "2026-11", days: expect.stringMatching(/^JJ\.\.J/) });
  });
});
