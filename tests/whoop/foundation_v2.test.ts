// v2 foundation: 412 retry, structured 409, HTML/text error decoding, units, BFF walker, future guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhoopClient } from "../../src/whoop/client.js";
import { WhoopApiError, WhoopConflictError, WhoopServerError } from "../../src/whoop/errors.js";
import { convertWeight, toKg } from "../../src/whoop/units.js";
import { byType, byId, parseDurationMs, parseNumber, parseWeight } from "../../src/whoop/bff.js";
import { assertNotFuture } from "../../src/lib/dates.js";

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
const client = () => new WhoopClient({ getToken: async () => "t", sleep: async () => {} });

describe("v2 client behaviour", () => {
  it("retries a write twice on 412 'cycle concurrently being updated', then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("User's cycle is concurrently being updated", { status: 412 }))
      .mockResolvedValueOnce(new Response("", { status: 412 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(client().put("/core-details-bff/v2/cardio-details", {})).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("gives up after the 412 retries with a clear message", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("busy", { status: 412 })));
    await expect(client().put("/core-details-bff/v2/cardio-details", {})).rejects.toThrow(/updating this day/);
  });
  it("does not retry a GET on 412", async () => {
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 412 }));
    await expect(client().get("/x")).rejects.toBeInstanceOf(WhoopApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("parses a structured 409 overlap body", async () => {
    const body = { overlapping_activities: [{ activity_id: "a1", activity_internal_name: "walking", during: "['2026-11-21T14:00:00.000Z','2026-11-21T14:30:00.000Z')" }] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 409 }));
    const err = await client().post("/core-details-bff/v2/create-activity", {}).catch((e) => e);
    expect(err).toBeInstanceOf(WhoopConflictError);
    expect(err.overlaps).toEqual([{ id: "a1", type: "walking", start: "2026-11-21T14:00:00.000Z", end: "2026-11-21T14:30:00.000Z", label: "walking a1 2026-11-21T14:00:00.000Z – 2026-11-21T14:30:00.000Z" }]);
  });
  it("parses WHOOP's real 409 overlap list (display strings, no ids)", async () => {
    const body = { overlapping_activities: ["**Rowing** - 7:45 AM - 7:55 AM"], error_title: "OVERLAPPING ACTIVITIES", message: "You added an activity from **7:50 AM to 8:00 AM**." };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 409 }));
    const err = await client().post("/core-details-bff/v2/create-activity", {}).catch((e) => e);
    expect(err).toBeInstanceOf(WhoopConflictError);
    expect(err.overlaps).toEqual([{ type: "Rowing", start: "7:45 AM", end: "7:55 AM", label: "Rowing 7:45 AM – 7:55 AM" }]);
  });
  it("surfaces the <title> of an HTML 500 page, not the page", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html><head><title>Error 500 Internal Server Error</title></head><body>…</body></html>", { status: 500 }));
    const err = await client().get("/x").catch((e) => e);
    expect(err).toBeInstanceOf(WhoopServerError);
    expect(err.message).toContain("Error 500 Internal Server Error");
    expect(err.message).not.toContain("<body>");
  });
  it("exposes short text/plain 4xx messages and names an empty 422", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Requested impact not found.", { status: 400 }));
    await expect(client().get("/x")).rejects.toThrow(/Requested impact not found/);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 422 }));
    await expect(client().put("/x", {})).rejects.toThrow(/request shape \(422, no details\)/);
  });
  it("returns undefined for an empty 200 and the literal for a bare JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(client().put("/x", {})).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response("false", { status: 200 }));
    await expect(client().put("/profile-service/v1/profile", {})).resolves.toBe(false);
  });
});

describe("units", () => {
  it("converts lb↔kg", () => {
    expect(convertWeight(100, "lb", "kg")).toBe(45.36);
    expect(convertWeight(45.36, "kg", "lb")).toBe(100);
    expect(toKg(10, "kg")).toBe(10);
  });
});

describe("bff walker", () => {
  const tree = { sections: [{ items: [{ type: "ITEMS_CARD", id: "one_rep_max_card_populated", content: { value: "126" } }, { type: "TAG" }] }] };
  it("finds nodes by type and id anywhere in the tree", () => {
    expect(byType(tree, "ITEMS_CARD")).toHaveLength(1);
    expect(byId(tree, "one_rep_max_card_populated")?.type).toBe("ITEMS_CARD");
  });
  it("parses display values", () => {
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("---")).toBeNull();
    expect(parseDurationMs("0:38")).toBe(38 * 60_000);
    expect(parseDurationMs("1:02:03")).toBe((3600 + 120 + 3) * 1000);
    expect(parseWeight("174.2 lb")).toEqual({ value: 174.2, unit: "lb" });
  });
});

describe("assertNotFuture", () => {
  it("allows the past and small clock skew, refuses the future", () => {
    const now = Date.parse("2026-11-21T20:00:00Z");
    expect(() => assertNotFuture("2026-11-21T19:00:00Z", "end", now)).not.toThrow();
    expect(() => assertNotFuture("2026-11-21T20:01:00Z", "end", now)).not.toThrow();
    expect(() => assertNotFuture("2026-11-25T10:00:00Z", "end", now)).toThrow(/undeletable/);
  });
});
