import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WhoopClient } from "../../src/whoop/client.js";
import {
  WhoopApiError,
  WhoopAuthExpiredError,
  WhoopServerError,
} from "../../src/whoop/errors.js";

const fetchMock = vi.fn();

function makeClient() {
  return new WhoopClient({ getToken: async () => "test-bearer" });
}

describe("WhoopClient", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes bearer header and apiVersion query param on GET", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = makeClient();
    await client.get("/home-service/v1/home", { date: "2026-05-23" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("apiVersion=7");
    expect(url).toContain("date=2026-05-23");
    expect(url).toContain("/home-service/v1/home");
    expect((init as RequestInit).method).toBe("GET");
    // Auth uses the capitalized "Bearer" scheme the iOS app sends, and the
    // request carries the app's identity headers so it blends with real app
    // traffic (see src/whoop/device.ts).
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer test-bearer",
      accept: "*/*",
      "user-agent": "iOS",
      "x-whoop-device-platform": "iOS",
      "x-whoop-ios-version": "5.52.0",
      "x-whoop-bundle-name": "com.whoop.iphone",
    });
  });

  it("throws WhoopAuthExpiredError on 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    await expect(makeClient().get("/x")).rejects.toBeInstanceOf(WhoopAuthExpiredError);
  });

  it("throws WhoopServerError on 5xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 502 }));
    await expect(makeClient().get("/x")).rejects.toBeInstanceOf(WhoopServerError);
  });

  it("throws WhoopApiError with parsed error_description on 4xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "invalid_request", error_description: "bad params" }),
        { status: 400 },
      ),
    );
    await expect(makeClient().get("/x")).rejects.toMatchObject({
      name: "WhoopApiError",
      status: 400,
      message: expect.stringContaining("bad params"),
    });
  });

  it("returns undefined on 204 (write endpoints)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await makeClient().put("/x", { foo: 1 });
    expect(result).toBeUndefined();
  });

  it("serializes body and sets content-type on POST", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1 }), { status: 200 }),
    );
    await makeClient().post("/x", { message: "hi" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ message: "hi" }));
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("skips undefined/null query values", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await makeClient().get("/x", { a: "yes", b: undefined, c: null, d: 5 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("a=yes");
    expect(url).toContain("d=5");
    expect(url).not.toContain("b=");
    expect(url).not.toContain("c=");
  });

  it("caches eligible GETs until their TTL expires", async () => {
    let now = 1_000;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ score: 1 }), { status: 200 })));
    const client = new WhoopClient({ getToken: async () => "test-bearer", now: () => now });
    const today = new Date().toISOString().slice(0, 10);
    await client.get("/home-service/v1/home", { date: today });
    await client.get("/home-service/v1/home", { date: today });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 30_001;
    await client.get("/home-service/v1/home", { date: today });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps date-bearing historical paths longer than current-day paths", async () => {
    let now = Date.parse("2026-08-24T12:00:00.000Z");
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const client = new WhoopClient({ getToken: async () => "test-bearer", now: () => now });
    await client.get("/progression-service/v2/weekly-plan/home-tile/2026-08-01");
    now += 6 * 60_000;
    await client.get("/progression-service/v2/weekly-plan/home-tile/2026-08-01");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.get("/progression-service/v2/weekly-plan/home-tile/2026-08-24");
    now += 6 * 60_000;
    await client.get("/progression-service/v2/weekly-plan/home-tile/2026-08-24");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the member's configured timezone when deciding whether a date is historical", async () => {
    const previousTimezone = process.env.WHOOP_TIMEZONE;
    process.env.WHOOP_TIMEZONE = "America/Los_Angeles";
    try {
      let now = Date.parse("2026-08-24T01:00:00.000Z"); // Aug 23 in Los Angeles
      fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ score: 1 }), { status: 200 })));
      const client = new WhoopClient({ getToken: async () => "test-bearer", now: () => now });
      await client.get("/home-service/v1/home", { date: "2026-08-23" });
      now += 30_001;
      await client.get("/home-service/v1/home", { date: "2026-08-23" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (previousTimezone === undefined) delete process.env.WHOOP_TIMEZONE;
      else process.env.WHOOP_TIMEZONE = previousTimezone;
    }
  });

  it("normalizes query ordering and evicts the least-recently-used entry at 100 values", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const client = makeClient();
    await client.get("/home-service/v1/home", { date: "2026-01-01", locale: "en-US" });
    await client.get("/home-service/v1/home", { locale: "en-US", date: "2026-01-01" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (let day = 2; day <= 101; day++) {
      await client.get("/home-service/v1/home", { date: `2026-01-${String(day).padStart(2, "0")}` });
    }
    expect(fetchMock).toHaveBeenCalledTimes(101);
    await client.get("/home-service/v1/home", { date: "2026-01-01", locale: "en-US" });
    expect(fetchMock).toHaveBeenCalledTimes(102);
  });

  it("does not retain pending activity records", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ state: "PENDING" }), { status: 200 })));
    const client = makeClient();
    await client.get("/developer/v2/activity/workout", { start: "2026-08-01", end: "2026-08-02" });
    await client.get("/developer/v2/activity/workout", { start: "2026-08-01", end: "2026-08-02" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous GETs but never caches completed live values", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const client = makeClient();
    const first = client.get("/activities-service/v1/user-state");
    const second = client.get("/activities-service/v1/user-state");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(new Response(JSON.stringify({ state: "idle" }), { status: 200 }));
    await Promise.all([first, second]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ state: "workout" }), { status: 200 }));
    await client.get("/activities-service/v1/user-state");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures and invalidates dependent GETs after a write", async () => {
    fetchMock.mockResolvedValueOnce(new Response("fail", { status: 500 }));
    const client = makeClient();
    await expect(client.get("/home-service/v1/home", { date: "2026-05-23" })).rejects.toBeInstanceOf(WhoopServerError);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ score: 1 }), { status: 200 }));
    await client.get("/home-service/v1/home", { date: "2026-05-23" });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.post("/core-details-bff/v0/create-activity", {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ score: 2 }), { status: 200 }));
    await client.get("/home-service/v1/home", { date: "2026-05-23" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("scopes a progression-service write to trend reads and the bootstrap profile instead of flushing every cached GET", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 })));
    const client = makeClient();
    const readings = "/progression-service/v3/trends/WEIGHT/readings";
    await client.get("/home-service/v1/home", { date: "2026-05-23" });
    await client.get(readings);
    await client.get("/users-service/v2/bootstrap");
    await client.get("/hr-zones-service/v1/bff/zones");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));
    await client.post(readings, { weight_kg: 80 });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await client.get("/home-service/v1/home", { date: "2026-05-23" });
    await client.get("/hr-zones-service/v1/bff/zones");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await client.get(readings);
    await client.get("/users-service/v2/bootstrap");
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
});
