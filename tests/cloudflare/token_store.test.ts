// The Cloudflare login store, against an in-memory stand-in for a Durable
// Object's SQLite storage, and the token manager's scheduled wake-up.
import { describe, expect, it, vi } from "vitest";
import { DurableKv, DurableTokenStore, type SqlLike } from "../../src/cloudflare/token_store.js";
import { TokenManager } from "../../src/whoop/token_manager.js";

/** Just enough SQL for the store's three statements. */
function fakeSql(): SqlLike & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    exec(query: string, ...b: unknown[]) {
      if (query.startsWith("CREATE TABLE")) return { toArray: () => [] };
      if (query.startsWith("SELECT")) return { toArray: () => (rows.has(String(b[0])) ? [{ v: rows.get(String(b[0])) }] : []) };
      if (query.startsWith("INSERT")) { rows.set(String(b[0]), String(b[1])); return { toArray: () => [] }; }
      throw new Error(`unexpected SQL: ${query}`);
    },
  };
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (expS: number): string => `${b64({ alg: "none" })}.${b64({ exp: expS, client_id: "web" })}.sig`;

describe("DurableTokenStore", () => {
  it("starts empty, saves a login, and changes its version on every save", () => {
    const sql = fakeSql();
    const store = new DurableTokenStore(new DurableKv(() => sql));
    expect(store.load()).toBeNull();
    expect(store.version()).toBeNull();
    const login = { access_token: jwt(2_000_000_000), refresh_token: "r1-" + "x".repeat(30), client_id: "web", source: "push" as const, saved_at: "2026-11-22T00:00:00.000Z" };
    store.save(login);
    expect(store.load()).toMatchObject(login);
    const v1 = store.version();
    store.save({ ...login, refresh_token: "r2-" + "x".repeat(30) });
    expect(store.version()).not.toBe(v1);
    expect(store.load()).toMatchObject({ refresh_token: "r2-" + "x".repeat(30) });
  });

  it("reads through whichever storage handle is current (the object can be rebuilt)", () => {
    let current = fakeSql();
    const kv = new DurableKv(() => current);
    kv.set("installation_id", "A");
    const rebuilt = fakeSql();
    rebuilt.rows.set("installation_id", "B");
    current = rebuilt;
    expect(kv.get("installation_id")).toBe("B");
  });
});

describe("TokenManager.wake", () => {
  it("refreshes a login that is due and saves the rotated refresh token first", async () => {
    const sql = fakeSql();
    const store = new DurableTokenStore(new DurableKv(() => sql));
    let now = Date.parse("2026-11-22T00:00:00.000Z");
    store.save({ access_token: jwt(now / 1000 + 120), refresh_token: "old-" + "x".repeat(30), client_id: "web", source: "push", saved_at: new Date(now).toISOString() });
    const refresh = vi.fn(async () => ({ accessToken: jwt(now / 1000 + 86_400), refreshToken: "new-" + "x".repeat(30), idToken: "", expiresAt: now + 86_400_000 }));
    const tokens = new TokenManager({ store, lock: null, now: () => now, refresh, log: () => {} } as never);
    tokens.start();
    tokens.stop(); // no timers: only the scheduled wake-up may refresh
    (tokens as unknown as { stopped: boolean }).stopped = false;
    await tokens.wake();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.load()).toMatchObject({ refresh_token: "new-" + "x".repeat(30) });
    expect(tokens.nextRefreshAt()).not.toBeNull();
    now += 60_000;
    await tokens.wake(); // not due again
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
