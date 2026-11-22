import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isUtcIso,
  toLocalIso,
  localizeTimestamps,
  getTimezone,
  setProfileTimezone,
  getProfileTimezone,
  zonedParts,
  wallClockIso,
  isValidTimezone,
} from "../../src/lib/timezone.js";
import { isoDay } from "../../src/lib/dates.js";

describe("isUtcIso", () => {
  it("matches second-precision UTC ISO", () => {
    expect(isUtcIso("2026-05-25T22:30:00Z")).toBe(true);
  });

  it("matches millisecond-precision UTC ISO", () => {
    expect(isUtcIso("2026-05-25T22:30:00.123Z")).toBe(true);
  });

  it("rejects ISO with explicit offset", () => {
    expect(isUtcIso("2026-05-25T15:30:00-07:00")).toBe(false);
  });

  it("rejects date-only strings", () => {
    expect(isUtcIso("2026-05-25")).toBe(false);
  });

  it("rejects free-form strings", () => {
    expect(isUtcIso("Mon May 25 2026")).toBe(false);
    expect(isUtcIso("hello")).toBe(false);
    expect(isUtcIso("")).toBe(false);
  });

  it("matches Whoop's +0000 form (journal / pg-range endpoints)", () => {
    expect(isUtcIso("2026-05-23T07:35:46.220+0000")).toBe(true);
  });

  it("matches the +00:00 form", () => {
    expect(isUtcIso("2026-05-23T07:35:46+00:00")).toBe(true);
  });

  it("still rejects a real non-zero offset (already localized)", () => {
    expect(isUtcIso("2026-05-25T15:30:00-07:00")).toBe(false);
    expect(isUtcIso("2026-05-26T07:30:00+09:00")).toBe(false);
  });
});

describe("toLocalIso with +0000 / +00:00 UTC forms", () => {
  it("converts +0000 to local offset", () => {
    expect(toLocalIso("2026-05-23T07:35:46.220+0000", "America/Los_Angeles"))
      .toBe("2026-05-23T00:35:46.220-07:00");
  });

  it("converts +00:00 to local offset", () => {
    expect(toLocalIso("2026-05-25T22:30:00+00:00", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00-07:00");
  });

  it("converts +0000 with a fixed-offset target tz", () => {
    expect(toLocalIso("2026-05-23T07:35:46.220+0000", "-0700"))
      .toBe("2026-05-23T00:35:46.220-07:00");
  });

  it("localizeTimestamps catches +0000 fields nested in objects", () => {
    const input = { journal: { lower: "2026-05-23T07:35:46.220+0000", note: "hi" } };
    expect(localizeTimestamps(input, "America/Los_Angeles")).toEqual({
      journal: { lower: "2026-05-23T00:35:46.220-07:00", note: "hi" },
    });
  });
});

describe("zonedParts + isoDay (input-side, user-TZ 'today')", () => {
  it("zonedParts resolves the user's calendar day, not the server's", () => {
    // 2026-05-27 04:00 UTC is still 2026-05-26 21:00 in LA — the day must be the 26th
    const p = zonedParts(new Date("2026-05-27T04:00:00Z"), "America/Los_Angeles");
    expect(p.year).toBe(2026);
    expect(p.month).toBe(5);
    expect(p.day).toBe(26);
    expect(p.hour).toBe(21);
  });

  it("zonedParts works with a fixed offset", () => {
    const p = zonedParts(new Date("2026-05-27T04:00:00Z"), "-0700");
    expect(p.day).toBe(26);
    expect(p.hour).toBe(21);
  });

  it("isoDay returns the user-TZ calendar day for a late-evening instant", () => {
    // Without TZ awareness this would return 2026-05-27 (the UTC day)
    const env = process.env.WHOOP_TIMEZONE;
    process.env.WHOOP_TIMEZONE = "America/Los_Angeles";
    try {
      expect(isoDay(new Date("2026-05-27T04:00:00Z"))).toBe("2026-05-26");
    } finally {
      if (env === undefined) delete process.env.WHOOP_TIMEZONE;
      else process.env.WHOOP_TIMEZONE = env;
    }
  });
});

describe("toLocalIso", () => {
  it("converts UTC to America/Los_Angeles in PDT", () => {
    // May 25 2026 22:30 UTC = May 25 2026 15:30 PDT
    expect(toLocalIso("2026-05-25T22:30:00Z", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00-07:00");
  });

  it("converts UTC to America/Los_Angeles in PST", () => {
    // January 15 2026 22:30 UTC = January 15 2026 14:30 PST
    expect(toLocalIso("2026-01-15T22:30:00Z", "America/Los_Angeles"))
      .toBe("2026-01-15T14:30:00-08:00");
  });

  it("preserves millisecond precision", () => {
    expect(toLocalIso("2026-05-25T22:30:00.123Z", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00.123-07:00");
  });

  it("handles date rollover across midnight", () => {
    // May 26 04:00 UTC = May 25 21:00 PDT (previous day local)
    expect(toLocalIso("2026-05-26T04:00:00Z", "America/Los_Angeles"))
      .toBe("2026-05-25T21:00:00-07:00");
  });

  it("converts to UTC when target tz is UTC", () => {
    expect(toLocalIso("2026-05-25T22:30:00Z", "UTC"))
      .toBe("2026-05-25T22:30:00+00:00");
  });

  it("converts to Asia/Tokyo (positive offset)", () => {
    // May 25 22:30 UTC = May 26 07:30 JST
    expect(toLocalIso("2026-05-25T22:30:00Z", "Asia/Tokyo"))
      .toBe("2026-05-26T07:30:00+09:00");
  });

  it("returns input unchanged for non-UTC strings", () => {
    expect(toLocalIso("2026-05-25", "America/Los_Angeles")).toBe("2026-05-25");
    expect(toLocalIso("hello", "America/Los_Angeles")).toBe("hello");
    expect(toLocalIso("2026-05-25T15:30:00-07:00", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00-07:00");
  });
});

describe("localizeTimestamps", () => {
  // JSON.stringify alone writes a Date as its ISO string; the walk rebuilt it
  // from its (zero) own keys, so jsonOut emitted {} for it.
  it("localizes a Date object instead of turning it into {}", () => {
    const input = { at: new Date("2026-05-25T22:00:00Z"), list: [new Date("2026-05-25T05:00:00.250Z")], bad: new Date(Number.NaN) };
    expect(localizeTimestamps(input, "America/Los_Angeles")).toEqual({
      at: "2026-05-25T15:00:00.000-07:00",
      list: ["2026-05-24T22:00:00.250-07:00"],
      bad: null, // what JSON.stringify writes for an invalid Date
    });
    expect(JSON.stringify(localizeTimestamps({ at: new Date("2026-05-25T22:00:00Z") }, "+0530"))).toBe('{"at":"2026-05-26T03:30:00.000+05:30"}');
  });

  it("walks nested objects and converts UTC strings", () => {
    const input = {
      date: "2026-05-25",
      sleep: {
        started_at: "2026-05-25T05:00:00Z",
        ended_at: "2026-05-25T13:30:00Z",
        score: 87,
      },
      workouts: [
        { id: "abc", start: "2026-05-25T22:00:00Z" },
        { id: "xyz", start: "2026-05-25T23:15:00Z" },
      ],
    };
    const result = localizeTimestamps(input, "America/Los_Angeles");
    expect(result).toEqual({
      date: "2026-05-25",
      sleep: {
        started_at: "2026-05-24T22:00:00-07:00",
        ended_at: "2026-05-25T06:30:00-07:00",
        score: 87,
      },
      workouts: [
        { id: "abc", start: "2026-05-25T15:00:00-07:00" },
        { id: "xyz", start: "2026-05-25T16:15:00-07:00" },
      ],
    });
  });

  it("leaves nulls, numbers, booleans unchanged", () => {
    expect(localizeTimestamps({ a: null, b: 42, c: true }, "America/Los_Angeles"))
      .toEqual({ a: null, b: 42, c: true });
  });

  it("leaves a top-level non-UTC string unchanged", () => {
    expect(localizeTimestamps("hello", "America/Los_Angeles")).toBe("hello");
  });

  it("converts a top-level UTC string", () => {
    expect(localizeTimestamps("2026-05-25T22:30:00Z", "America/Los_Angeles"))
      .toBe("2026-05-25T15:30:00-07:00");
  });

  it("preserves explicitly UTC-labelled wire timestamps", () => {
    expect(localizeTimestamps({
      start: "2026-05-25T22:30:00.000Z",
      sent_start_utc: "2026-05-25T22:30:00.000Z",
    }, "America/Los_Angeles")).toEqual({
      start: "2026-05-25T15:30:00.000-07:00",
      sent_start_utc: "2026-05-25T22:30:00.000Z",
    });
  });
});

describe("toLocalIso with fixed offset (Whoop profile.timezone_offset form)", () => {
  it("accepts Whoop's 4-digit offset format '-0700'", () => {
    expect(toLocalIso("2026-05-25T22:30:00Z", "-0700"))
      .toBe("2026-05-25T15:30:00-07:00");
  });

  it("accepts standard ISO offset format '-07:00'", () => {
    expect(toLocalIso("2026-05-25T22:30:00Z", "-07:00"))
      .toBe("2026-05-25T15:30:00-07:00");
  });

  it("accepts positive offset '+0900' (Asia/Tokyo)", () => {
    expect(toLocalIso("2026-05-25T22:30:00Z", "+0900"))
      .toBe("2026-05-26T07:30:00+09:00");
  });

  it("accepts UTC offset '+0000'", () => {
    expect(toLocalIso("2026-05-25T22:30:00Z", "+0000"))
      .toBe("2026-05-25T22:30:00+00:00");
  });

  it("preserves millisecond precision with fixed offset", () => {
    expect(toLocalIso("2026-05-25T22:30:00.456Z", "-0700"))
      .toBe("2026-05-25T15:30:00.456-07:00");
  });

  it("handles half-hour offsets like Newfoundland (-0330)", () => {
    expect(toLocalIso("2026-05-25T22:30:00Z", "-0330"))
      .toBe("2026-05-25T19:00:00-03:30");
  });
});

describe("getTimezone priority chain", () => {
  let originalEnv: string | undefined;
  let originalCached: string | null;

  beforeEach(() => {
    originalEnv = process.env.WHOOP_TIMEZONE;
    originalCached = getProfileTimezone();
    delete process.env.WHOOP_TIMEZONE;
    setProfileTimezone(null);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WHOOP_TIMEZONE;
    else process.env.WHOOP_TIMEZONE = originalEnv;
    setProfileTimezone(originalCached);
  });

  it("WHOOP_TIMEZONE env var wins over profile cache", () => {
    process.env.WHOOP_TIMEZONE = "America/New_York";
    setProfileTimezone("-0700");
    expect(getTimezone()).toBe("America/New_York");
  });

  it("profile cache wins over system TZ when env var unset", () => {
    setProfileTimezone("-0700");
    expect(getTimezone()).toBe("-0700");
  });

  it("treats empty WHOOP_TIMEZONE as unset (dotenv `WHOOP_TIMEZONE=` line)", () => {
    process.env.WHOOP_TIMEZONE = "";
    setProfileTimezone("-0400");
    expect(getTimezone()).toBe("-0400");
  });

  it("keeps live-state/sleep timestamp serialization working with a blank env override", () => {
    process.env.WHOOP_TIMEZONE = "";
    setProfileTimezone("-0400");
    expect(localizeTimestamps({
      state: "SLEEPING",
      last_updated_at: "2026-08-24T12:00:00Z",
    })).toEqual({
      state: "SLEEPING",
      last_updated_at: "2026-08-24T08:00:00-04:00",
    });
  });

  it("falls back to system TZ when env var unset and profile not cached", () => {
    // Don't assert exact system TZ (varies by CI host) — just confirm it
    // returns SOMETHING valid and not our cached/env values.
    const tz = getTimezone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
    expect(tz).not.toBe("-0700");
  });

  it("ignores invalid env and profile timezone values", () => {
    process.env.WHOOP_TIMEZONE = "Not/A_Timezone";
    setProfileTimezone("+9960");
    expect(isValidTimezone(process.env.WHOOP_TIMEZONE)).toBe(false);
    expect(isValidTimezone("+9960")).toBe(false);
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: getTimezone() })).not.toThrow();
  });
});

describe("wallClockIso DST resolution", () => {
  it("uses the post-transition offset after the spring-forward gap", () => {
    expect(wallClockIso("2026-03-08", 3, 30, "America/Los_Angeles"))
      .toBe("2026-03-08T03:30:00-07:00");
  });

  it("uses the pre-transition offset before spring-forward", () => {
    expect(wallClockIso("2026-03-08", 1, 30, "America/Los_Angeles"))
      .toBe("2026-03-08T01:30:00-08:00");
  });
});
