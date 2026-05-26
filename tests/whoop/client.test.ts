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
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "bearer test-bearer",
      accept: "application/json",
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
});
