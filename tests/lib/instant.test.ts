// Times as the tools take them (src/lib/instant.ts).
import { describe, expect, it } from "vitest";
import { instantInput, toInstant } from "../../src/lib/instant.js";

describe("toInstant", () => {
  it("takes an exact moment with or without seconds, any offset form", () => {
    expect(toInstant("2026-11-20T08:00:00Z")).toBe("2026-11-20T08:00:00.000Z");
    expect(toInstant("2026-11-20T08:00-08:00")).toBe("2026-11-20T16:00:00.000Z");
    expect(toInstant("2026-11-20T08:00:30.5+0530")).toBe("2026-11-20T02:30:30.500Z");
    expect(toInstant("2026-11-20 08:00z")).toBe("2026-11-20T08:00:00.000Z");
  });

  it("reads a time without an offset on the person's clock, DST included", () => {
    expect(toInstant("2026-11-20T08:00", "America/Los_Angeles")).toBe("2026-11-20T16:00:00.000Z"); // PST
    expect(toInstant("2026-07-20T08:00:15", "America/Los_Angeles")).toBe("2026-07-20T15:00:15.000Z"); // PDT
    expect(toInstant("2026-11-20T08:00", "-07:00")).toBe("2026-11-20T15:00:00.000Z"); // WHOOP's fixed-offset form
  });

  it("refuses what isn't a real time, naming the field", () => {
    for (const bad of ["2026-02-30T08:00Z", "2026-11-20T24:00", "2026-11-20", "yesterday 8am", "2026-13-01T08:00"]) {
      expect(() => toInstant(bad, "UTC", "start")).toThrow(/^start: expected a time like/);
      expect(instantInput().safeParse(bad).success).toBe(false);
    }
    expect(instantInput().safeParse("2026-11-20T08:00").success).toBe(true);
  });
});
