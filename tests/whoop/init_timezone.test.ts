// The member's timezone comes from their WHOOP profile at boot. Until that
// lookup lands the server uses the host's zone, which is UTC in a container.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startTimezoneAutoDetect, stopTimezoneAutoDetect, timezoneSettled } from "../../src/whoop/init_timezone.js";
import { getProfileTimezone, setProfileTimezone } from "../../src/lib/timezone.js";
import { isoDay } from "../../src/lib/dates.js";
import { defineTool } from "../../src/tools/define.js";
import type { WhoopClient } from "../../src/whoop/client.js";

const profile = (offset: string) => ({ profile: { timezone_offset: offset } });
const clientWith = (get: () => Promise<unknown>) => ({ get: vi.fn(get) }) as unknown as WhoopClient & { get: ReturnType<typeof vi.fn> };
const previousTz = process.env.WHOOP_TIMEZONE;

beforeEach(() => {
  delete process.env.WHOOP_TIMEZONE;
  setProfileTimezone(null);
});
afterEach(() => {
  stopTimezoneAutoDetect();
  setProfileTimezone(null);
  vi.useRealTimers();
  if (previousTz === undefined) delete process.env.WHOOP_TIMEZONE;
  else process.env.WHOOP_TIMEZONE = previousTz;
});

describe("startTimezoneAutoDetect", () => {
  it("retries a failed lookup within seconds instead of at the next hourly refresh", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = clientWith(async () => {
      if (++calls === 1) throw new Error("WHOOP 503");
      return profile("-0700");
    });
    startTimezoneAutoDetect(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(getProfileTimezone()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getProfileTimezone()).toBe("-0700"); // was: null for the next 60 minutes
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("backs off across repeated failures, then settles into the hourly refresh", async () => {
    vi.useFakeTimers();
    const client = clientWith(async () => { throw new Error("offline"); });
    startTimezoneAutoDetect(client);
    await vi.advanceTimersByTimeAsync(0);
    for (const [wait, expected] of [[2_000, 2], [10_000, 3], [30_000, 4], [120_000, 5]] as const) {
      await vi.advanceTimersByTimeAsync(wait);
      expect(client.get).toHaveBeenCalledTimes(expected);
    }
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(client.get).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.get).toHaveBeenCalledTimes(6);
  });

  it("keeps the hourly cadence when the profile simply has no offset", async () => {
    vi.useFakeTimers();
    const client = clientWith(async () => ({ profile: {} }));
    startTimezoneAutoDetect(client);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("a restart cancels the earlier loop", async () => {
    vi.useFakeTimers();
    const stale = clientWith(async () => profile("-0700"));
    startTimezoneAutoDetect(stale);
    startTimezoneAutoDetect(clientWith(async () => profile("+0100")));
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(stale.get).toHaveBeenCalledTimes(1);
    expect(getProfileTimezone()).toBe("+0100");
  });
});

describe("timezoneSettled", () => {
  it("resolves at once when auto-detect isn't running", async () => {
    await expect(Promise.race([timezoneSettled().then(() => "settled"), Promise.resolve().then(() => Promise.resolve("pending"))])).resolves.toBe("settled");
  });

  it("waits for the first lookup, but never more than 3 seconds", async () => {
    vi.useFakeTimers();
    startTimezoneAutoDetect(clientWith(() => new Promise(() => {}))); // never answers
    const done = vi.fn();
    void timezoneSettled().then(done);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toHaveBeenCalled();
  });

  it("a tool called before the lookup lands still reports the member's day, not the host's", async () => {
    // 12:00Z on May 25 is already May 26 at +14:00, and still May 25 in UTC and
    // in every zone a CI host or laptop is likely to be in.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-05-25T12:00:00Z") });
    let answer!: (value: unknown) => void;
    startTimezoneAutoDetect(clientWith(() => new Promise((resolve) => { answer = resolve; })));

    const server = new McpServer({ name: "t", version: "0" });
    defineTool(server, { name: "whoop_today_probe", description: "today", input: {}, annotations: {} },
      async () => ({ content: [{ type: "text", text: isoDay() }] }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);

    const call = client.callTool({ name: "whoop_today_probe", arguments: {} });
    await new Promise((resolve) => setImmediate(resolve)); // the request reaches the handler first…
    answer(profile("+1400"));                               // …and the profile answers after
    const result = await call;
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("2026-05-26");
  });
});
