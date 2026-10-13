import { describe, expect, it } from "vitest";
import { writeRejected } from "../../src/whoop/write_safety.js";
import { WhoopApiError } from "../../src/whoop/errors.js";

const parse = (r: ReturnType<typeof writeRejected>): Record<string, unknown> =>
  JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe("writeRejected", () => {
  const error = new WhoopApiError(422, "/x", '{"message":"bad window","secret":"raw body"}');

  it("reports status and parsed reason, never the raw body", () => {
    const result = writeRejected("activity", "/x", error);
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ error: "WHOOP rejected the activity.", status: 422, endpoint: "/x", reason: "bad window" });
  });

  it("adds a hint when given", () => {
    expect(parse(writeRejected("activity", "/x", error, "Check the window."))).toMatchObject({ hint: "Check the window." });
  });
});
