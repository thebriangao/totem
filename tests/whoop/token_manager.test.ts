import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TokenManager, WhoopLoginHandedOffError, WhoopNotLoggedInError, WhoopRefreshUnavailableError, WhoopTokenPersistError,
  WhoopTokenUnwritableError, keepAliveMsFromEnv, type TokenManagerConfig,
} from "../../src/whoop/token_manager.js";
import { FileTokenStore, MemoryTokenStore, type TokenRecord, type TokenStore } from "../../src/whoop/token_store.js";
import { TokenLock, WhoopTokenOwnedError } from "../../src/whoop/token_lock.js";
import { CognitoError, type CognitoTokens } from "../../src/whoop/cognito.js";
import { WhoopAuthExpiredError } from "../../src/whoop/errors.js";
import { WEB_CLIENT_ID } from "../../src/whoop/constants.js";
import { jwtExpiring } from "./jwt_helper.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function login(now: number, over: Partial<TokenRecord> = {}): TokenRecord {
  return {
    access_token: jwtExpiring(now, 24 * HOUR, { client_id: WEB_CLIENT_ID, n: 0 }),
    refresh_token: "rt-0",
    client_id: WEB_CLIENT_ID,
    source: "browser",
    saved_at: new Date(now).toISOString(),
    ...over,
  };
}

/** A fake Cognito: every refresh rotates the refresh token, like WHOOP's. */
function fakeCognito(now: () => number) {
  let n = 0;
  const calls: Array<{ refreshToken: string; clientId: string }> = [];
  const refresh = vi.fn(async (refreshToken: string, clientId: string): Promise<CognitoTokens> => {
    calls.push({ refreshToken, clientId });
    n++;
    return { accessToken: jwtExpiring(now(), 24 * HOUR, { client_id: WEB_CLIENT_ID, n }), refreshToken: `rt-${n}`, idToken: "", expiresAt: now() + 24 * HOUR };
  });
  return { refresh, calls };
}

const quiet = { log: () => undefined };

describe("TokenManager: durable refresh (G6)", () => {
  it("persists the rotated refresh token before handing out the new access token", async () => {
    const now = Date.now();
    const store = new MemoryTokenStore(login(now, { access_token: jwtExpiring(now, 5 * MIN) }));
    const { refresh } = fakeCognito(() => now);
    const order: string[] = [];
    const save = store.save.bind(store);
    store.save = (c) => { order.push("save"); save(c); };
    const manager = new TokenManager({ store, refresh, ...quiet });
    const token = await manager.getToken();
    order.push("handed out");
    expect(order).toEqual(["save", "handed out"]);
    const saved = store.load() as TokenRecord;
    expect(saved.refresh_token).toBe("rt-1");
    expect(saved.access_token).toBe(token);
    expect(saved.refreshed_at).toBeDefined();
    expect(saved.saved_at).toBe(new Date(now).toISOString()); // rotation keeps the login's identity
  });

  it("refreshes with the recorded client id", async () => {
    const now = Date.now();
    const store = new MemoryTokenStore(login(now, { access_token: jwtExpiring(now, 0), client_id: "" }));
    const { refresh, calls } = fakeCognito(() => now);
    await new TokenManager({ store, refresh, ...quiet }).getToken();
    expect(calls[0]).toEqual({ refreshToken: "rt-0", clientId: "" });
  });

  it("treats a failed write as fatal: no token handed out, onFatal called, later calls fail too", async () => {
    const now = Date.now();
    const store = new MemoryTokenStore(login(now, { access_token: jwtExpiring(now, 0) }));
    store.save = () => { throw new Error("EROFS: read-only file system"); };
    const onFatal = vi.fn();
    const { refresh } = fakeCognito(() => now);
    const manager = new TokenManager({ store, refresh, onFatal, ...quiet });
    await expect(manager.getToken()).rejects.toBeInstanceOf(WhoopTokenPersistError);
    expect(onFatal).toHaveBeenCalledOnce();
    await expect(manager.getToken()).rejects.toBeInstanceOf(WhoopTokenPersistError);
    expect(refresh).toHaveBeenCalledOnce();
    expect(manager.status().state).toBe("fatal");
  });

  it("refreshes once for parallel callers (single-flight)", async () => {
    const now = Date.now();
    const store = new MemoryTokenStore(login(now, { access_token: jwtExpiring(now, 0) }));
    const { refresh } = fakeCognito(() => now);
    const manager = new TokenManager({ store, refresh, ...quiet });
    const tokens = await Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("TokenManager: errors (G9)", () => {
  it("throws WhoopAuthExpiredError only when Cognito refuses the refresh", async () => {
    const now = Date.now();
    const store = new MemoryTokenStore(login(now, { access_token: jwtExpiring(now, 0) }));
    const refresh = vi.fn().mockRejectedValue(new CognitoError("NotAuthorizedException: Refresh Token has expired", 400, "NotAuthorizedException"));
    const manager = new TokenManager({ store, refresh, ...quiet });
    await expect(manager.getToken()).rejects.toBeInstanceOf(WhoopAuthExpiredError);
    expect(manager.status().state).toBe("expired");
    await expect(manager.getToken()).rejects.toThrow(/Refresh Token has expired/);
    expect(refresh).toHaveBeenCalledOnce(); // a dead refresh token isn't retried on every call
  });

  it("a network or throttling failure is not an expired login", async () => {
    const now = Date.now();
    const store = new MemoryTokenStore(login(now, { access_token: jwtExpiring(now, 0) }));
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new CognitoError("TooManyRequestsException: slow down", 400, "TooManyRequestsException"))
      .mockResolvedValue({ accessToken: jwtExpiring(now, 24 * HOUR), refreshToken: "rt-9", idToken: "", expiresAt: 0 });
    const manager = new TokenManager({ store, refresh, ...quiet });
    await expect(manager.getToken()).rejects.toBeInstanceOf(WhoopRefreshUnavailableError);
    await expect(manager.getToken()).rejects.toBeInstanceOf(WhoopRefreshUnavailableError);
    await expect(manager.getToken()).resolves.toBeTypeOf("string");
  });

  it("explains a missing login and a handed-off one", async () => {
    await expect(new TokenManager({ store: new MemoryTokenStore(), ...quiet }).getToken()).rejects.toBeInstanceOf(WhoopNotLoggedInError);
    const handed = new MemoryTokenStore({ handed_off_to: "https://totem-x.fly.dev", saved_at: "2026-11-21T00:00:00Z" });
    await expect(new TokenManager({ store: handed, ...quiet }).getToken()).rejects.toBeInstanceOf(WhoopLoginHandedOffError);
    await expect(new TokenManager({ store: handed, ...quiet }).getToken()).rejects.toThrow(/totem auth --local/);
  });
});

describe("TokenManager.invalidate", () => {
  it("forces a refresh only for the current token, and not within a minute of the last refresh", async () => {
    let now = Date.now();
    const store = new MemoryTokenStore(login(now, { access_token: jwtExpiring(now, 0) }));
    const { refresh } = fakeCognito(() => now);
    const manager = new TokenManager({ store, refresh, now: () => now, ...quiet });
    const first = await manager.getToken();
    expect(refresh).toHaveBeenCalledTimes(1);

    manager.invalidate("some-older-token");
    await manager.getToken();
    expect(refresh).toHaveBeenCalledTimes(1);

    manager.invalidate(first);
    await manager.getToken();
    expect(refresh).toHaveBeenCalledTimes(1); // within 60 s of the refresh

    now += 61_000;
    manager.invalidate(first);
    await manager.getToken();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("TokenManager keep-alive (G7)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("refreshes every 12 h by default while idle", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { refreshed_at: new Date(t0).toISOString() }));
    const { refresh } = fakeCognito(() => Date.now());
    const manager = new TokenManager({ store, refresh, ...quiet });
    manager.start();
    await vi.advanceTimersByTimeAsync(12 * HOUR - MIN);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((store.load() as TokenRecord).refresh_token).toBe("rt-1");
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(refresh).toHaveBeenCalledTimes(2);
    manager.stop();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes when less than 10 minutes of access life remain", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { access_token: jwtExpiring(t0, HOUR) }));
    const { refresh } = fakeCognito(() => Date.now());
    const manager = new TokenManager({ store, refresh, keepAliveMs: 0, ...quiet });
    manager.start();
    await vi.advanceTimersByTimeAsync(49 * MIN);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(manager.status().next_keepalive_at).toBeDefined();
    manager.stop();
  });

  it("refreshes right away when the saved login is overdue", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { refreshed_at: new Date(t0 - 13 * HOUR).toISOString() }));
    const { refresh } = fakeCognito(() => Date.now());
    const manager = new TokenManager({ store, refresh, ...quiet });
    manager.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("retries a transient failure with backoff, and stops on an expired login", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { refreshed_at: new Date(t0 - 13 * HOUR).toISOString() }));
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new CognitoError("NotAuthorizedException: revoked", 400, "NotAuthorizedException"));
    const manager = new TokenManager({ store, refresh, retryBaseMs: 60_000, ...quiet });
    manager.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(manager.status().state).toBe("expired");
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(refresh).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("still refreshes on time when timers stood still while the machine slept", async () => {
    // Node's timers count running time. On Linux that excludes suspend, so a
    // timer set for "in 50 minutes" fires 50 minutes of AWAKE time later.
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { access_token: jwtExpiring(t0, HOUR) }));
    const { refresh } = fakeCognito(() => Date.now());
    const manager = new TokenManager({ store, refresh, keepAliveMs: 0, ...quiet });
    manager.start();
    // The status names the real due time (expiry minus 10 minutes), not the next wake-up.
    expect(manager.status().next_keepalive_at).toBe(new Date(Math.floor((t0 + HOUR) / 1000) * 1000 - 10 * MIN).toISOString());
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(refresh).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 8 * HOUR); // lid closed: the wall clock jumps, timers don't
    await vi.advanceTimersByTimeAsync(61_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("keeps a failed refresh's backoff even though it wakes every minute", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { refreshed_at: new Date(t0 - 13 * HOUR).toISOString() }));
    const refresh = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const manager = new TokenManager({ store, refresh, retryBaseMs: 4 * MIN, ...quiet });
    manager.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * MIN); // three wake-ups, all before the 4-minute retry
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MIN + 1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("uses an unref'd timer so it never keeps the process alive", () => {
    const store = new MemoryTokenStore(login(Date.now()));
    const spy = vi.spyOn(globalThis, "setTimeout");
    const manager = new TokenManager({ store, ...quiet });
    manager.start();
    const timer = spy.mock.results.at(-1)?.value as { hasRef?: () => boolean } | undefined;
    if (timer && typeof timer.hasRef === "function") expect(timer.hasRef()).toBe(false);
    manager.stop();
  });
});

describe("TokenManager: no refresh storms", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** WHOOP's tokens as seen from a machine whose clock runs two days fast: expired on arrival. */
  function skewedCognito() {
    let n = 0;
    return vi.fn(async (): Promise<CognitoTokens> => {
      n++;
      return { accessToken: jwtExpiring(Date.now() - 48 * HOUR, 24 * HOUR, { n }), refreshToken: `rt-${n}`, idToken: "", expiresAt: 0 };
    });
  }

  it("a clock far ahead of WHOOP's doesn't turn every call into a refresh", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { access_token: jwtExpiring(t0 - 48 * HOUR, 24 * HOUR) }));
    const refresh = skewedCognito();
    const manager = new TokenManager({ store, refresh, keepAliveMs: 0, ...quiet });
    const first = await manager.getToken();
    expect(refresh).toHaveBeenCalledTimes(1); // the saved token looked expired: refresh once
    for (let i = 0; i < 5; i++) expect(await manager.getToken()).toBe(first); // then use what WHOOP just issued
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * MIN);
    await manager.getToken();
    expect(refresh).toHaveBeenCalledTimes(2); // not stuck on it forever either
  });

  it("...and the keep-alive doesn't refresh every second", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { access_token: jwtExpiring(t0 - 48 * HOUR, 24 * HOUR) }));
    const refresh = skewedCognito();
    const manager = new TokenManager({ store, refresh, ...quiet });
    manager.start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(8); // was ~1,800: one per second
    manager.stop();
  });

  it("a 401 still forces a refresh right after one", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0, { access_token: jwtExpiring(t0, 0) }));
    const { refresh } = fakeCognito(() => Date.now());
    const manager = new TokenManager({ store, refresh, keepAliveMs: 0, ...quiet });
    const first = await manager.getToken();
    await vi.advanceTimersByTimeAsync(61_000); // past the 60 s guard, inside the 5-minute one
    manager.invalidate(first);
    expect(await manager.getToken()).not.toBe(first);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a tiny TOTEM_KEEPALIVE_HOURS can't hammer the login service", async () => {
    const t0 = Date.now();
    const store = new MemoryTokenStore(login(t0));
    const { refresh } = fakeCognito(() => Date.now());
    const manager = new TokenManager({ store, refresh, keepAliveMs: keepAliveMsFromEnv("0.0001"), ...quiet });
    manager.start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(7);
    manager.stop();
  });
});

describe("TokenManager: one owner per login (G8)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "totem-tm-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const alive = new Set<number>();
  function processOn(pid: number, file: string, extra: Partial<TokenManagerConfig> = {}) {
    const store = new FileTokenStore(file);
    const lock = new TokenLock({ path: `${file}.lock`, pid, host: "laptop", isAlive: (p) => alive.has(p) });
    return { store, lock, manager: new TokenManager({ store, lock, ...quiet, ...extra }) };
  }

  it("a second process follows the owner's file and never refreshes", async () => {
    alive.clear(); alive.add(1).add(2);
    const file = join(dir, "tokens.json");
    const now = Date.now();
    new FileTokenStore(file).save(login(now, { access_token: jwtExpiring(now, 5 * MIN) }));
    const cognito = fakeCognito(() => Date.now());
    const owner = processOn(1, file, { refresh: cognito.refresh });
    const follower = processOn(2, file, { refresh: cognito.refresh });
    owner.manager.start();
    follower.manager.start();
    expect(owner.manager.status().role).toBe("owner");
    expect(follower.manager.status().role).toBe("follower");

    const fresh = await owner.manager.getToken(); // owner refreshes (5 min left < 10 min)
    expect(cognito.refresh).toHaveBeenCalledTimes(1);
    await expect(follower.manager.getToken()).resolves.toBe(fresh); // read from the file
    expect(cognito.refresh).toHaveBeenCalledTimes(1);
    owner.manager.stop();
    follower.manager.stop();
  });

  it("fails clearly when it would have to refresh while the owner is alive", async () => {
    alive.clear(); alive.add(1).add(2);
    const file = join(dir, "tokens.json");
    const now = Date.now();
    new FileTokenStore(file).save(login(now, { access_token: jwtExpiring(now, 10_000) }));
    const cognito = fakeCognito(() => Date.now());
    const owner = processOn(1, file, { refresh: cognito.refresh });
    const follower = processOn(2, file, { refresh: cognito.refresh });
    owner.manager.start();
    follower.manager.start();
    await expect(follower.manager.getToken()).rejects.toBeInstanceOf(WhoopTokenOwnedError);
    await expect(follower.manager.getToken()).rejects.toThrow(/token owned by pid 1/);
    expect(cognito.refresh).not.toHaveBeenCalled();
    owner.manager.stop();
    follower.manager.stop();
  });

  it("takes over when the owner died", async () => {
    alive.clear(); alive.add(1).add(2);
    const file = join(dir, "tokens.json");
    const now = Date.now();
    new FileTokenStore(file).save(login(now, { access_token: jwtExpiring(now, 0) }));
    const cognito = fakeCognito(() => Date.now());
    const owner = processOn(1, file, { refresh: cognito.refresh });
    const follower = processOn(2, file, { refresh: cognito.refresh });
    owner.manager.start();
    follower.manager.start();
    owner.lock.stopHeartbeat();
    alive.delete(1); // crashed, lock left behind
    await expect(follower.manager.getToken()).resolves.toBeTypeOf("string");
    expect(follower.manager.status().role).toBe("owner");
    expect(cognito.refresh).toHaveBeenCalledTimes(1);
    follower.manager.stop();
  });

  it("a follower can't take the login over while the owner is spending the refresh token (after a laptop sleep)", async () => {
    alive.clear(); alive.add(1).add(2);
    const file = join(dir, "tokens.json");
    let clock = Date.now();
    const now = (): number => clock;
    new FileTokenStore(file).save(login(clock, { access_token: jwtExpiring(clock, HOUR) }));
    // The owner's refresh is on the wire until we let it finish.
    let finish!: () => void;
    const onTheWire = new Promise<void>((r) => { finish = r; });
    const spent: string[] = [];
    const refresh = vi.fn(async (refreshToken: string): Promise<CognitoTokens> => {
      spent.push(refreshToken);
      await onTheWire;
      return { accessToken: jwtExpiring(clock, 24 * HOUR, { n: spent.length }), refreshToken: `rt-${spent.length}`, idToken: "", expiresAt: 0 };
    });
    const proc = (pid: number) => {
      const lock = new TokenLock({ path: `${file}.lock`, pid, host: "laptop", now, isAlive: (p) => alive.has(p) });
      return { lock, manager: new TokenManager({ store: new FileTokenStore(file), lock, now, refresh, ...quiet }) };
    };
    const owner = proc(1);
    const follower = proc(2);
    owner.manager.start();
    follower.manager.start();
    owner.lock.stopHeartbeat();

    clock += 8 * HOUR; // lid closed: the access token expired and no heartbeat ran
    const ownerCall = owner.manager.getToken();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // The follower wakes beside it and needs a token too. The owner's pid is
    // alive; only its heartbeat could look stale.
    await expect(follower.manager.getToken()).rejects.toBeInstanceOf(WhoopTokenOwnedError);
    expect(spent).toEqual(["rt-0"]); // never presented twice
    expect(follower.manager.status().role).toBe("follower");

    finish();
    const fresh = await ownerCall;
    await expect(follower.manager.getToken()).resolves.toBe(fresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    owner.manager.stop();
    follower.manager.stop();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "doesn't spend the refresh token when the token directory has become unwritable",
    async () => {
      alive.clear(); alive.add(1);
      const file = join(dir, "tokens.json");
      const now = Date.now();
      new FileTokenStore(file).save(login(now, { access_token: jwtExpiring(now, 0) }));
      const cognito = fakeCognito(() => Date.now());
      const owner = processOn(1, file, { refresh: cognito.refresh });
      owner.manager.start();
      owner.lock.stopHeartbeat();
      chmodSync(dir, 0o500); // the volume went read-only
      try {
        await expect(owner.manager.getToken()).rejects.toBeInstanceOf(WhoopTokenUnwritableError);
        expect(cognito.refresh).not.toHaveBeenCalled(); // rt-0 is still good
        expect(owner.manager.status().state).toBe("ok"); // not fatal, not expired
      } finally {
        chmodSync(dir, 0o700);
      }
      await expect(owner.manager.getToken()).resolves.toBeTypeOf("string"); // and it recovers
      expect((new FileTokenStore(file).load() as TokenRecord).refresh_token).toBe("rt-1");
      owner.manager.stop();
    },
  );
});

describe("TokenManager: the token file is the source of truth", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "totem-tm-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adopts a login another writer saved (`totem auth`), without a restart", async () => {
    const file = join(dir, "tokens.json");
    const now = Date.now();
    const store: TokenStore = new FileTokenStore(file);
    store.save(login(now));
    const onLoginChange = vi.fn();
    const manager = new TokenManager({ store, onLoginChange, ...quiet });
    const before = await manager.getToken();
    const next = login(now + 1000, { access_token: jwtExpiring(now, 24 * HOUR, { n: "new" }), refresh_token: "rt-new", saved_at: new Date(now + 1000).toISOString(), user_id: 9 });
    new FileTokenStore(file).save(next);
    const after = await manager.getToken();
    expect(after).not.toBe(before);
    expect(after).toBe(next.access_token);
    expect(onLoginChange).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 9 }));
  });

  it("a login saved during a refresh wins over the refreshed one", async () => {
    const file = join(dir, "tokens.json");
    const now = Date.now();
    new FileTokenStore(file).save(login(now, { access_token: jwtExpiring(now, 0) }));
    const replacement = login(now, { access_token: jwtExpiring(now, 24 * HOUR, { n: "auth" }), refresh_token: "rt-auth", saved_at: new Date(now + 5).toISOString() });
    const refresh = vi.fn(async (): Promise<CognitoTokens> => {
      new FileTokenStore(file).save(replacement); // `totem auth` lands mid-refresh
      return { accessToken: jwtExpiring(now, 24 * HOUR, { n: "refreshed" }), refreshToken: "rt-refreshed", idToken: "", expiresAt: 0 };
    });
    const manager = new TokenManager({ store: new FileTokenStore(file), refresh, ...quiet });
    await expect(manager.getToken()).resolves.toBe(replacement.access_token);
    expect((new FileTokenStore(file).load() as TokenRecord).refresh_token).toBe("rt-auth");
  });

  it("a refresh that lands after the login was handed off or removed doesn't write the tokens back", async () => {
    const file = join(dir, "tokens.json");
    const now = Date.now();
    const refreshed = (): CognitoTokens => ({ accessToken: jwtExpiring(now, 24 * HOUR, { n: "refreshed" }), refreshToken: "rt-refreshed", idToken: "", expiresAt: 0 });

    // `totem auth` pushed the login to a deployment and left the marker mid-refresh.
    new FileTokenStore(file).save(login(now, { access_token: jwtExpiring(now, 0) }));
    const handOff = vi.fn(async (): Promise<CognitoTokens> => {
      new FileTokenStore(file).save({ handed_off_to: "https://totem-x.fly.dev", saved_at: new Date(now + 5).toISOString() });
      return refreshed();
    });
    await expect(new TokenManager({ store: new FileTokenStore(file), refresh: handOff, ...quiet }).getToken()).rejects.toBeInstanceOf(WhoopLoginHandedOffError);
    expect(new FileTokenStore(file).load()).toMatchObject({ handed_off_to: "https://totem-x.fly.dev" });

    // The token file was deleted (a logout) mid-refresh.
    new FileTokenStore(file).save(login(now, { access_token: jwtExpiring(now, 0) }));
    const remove = vi.fn(async (): Promise<CognitoTokens> => {
      rmSync(file);
      return refreshed();
    });
    await expect(new TokenManager({ store: new FileTokenStore(file), refresh: remove, ...quiet }).getToken()).rejects.toBeInstanceOf(WhoopNotLoggedInError);
    expect(new FileTokenStore(file).load()).toBeNull();
  });

  it("annotate() never writes a stale copy over tokens another process rotated", async () => {
    const file = join(dir, "tokens.json");
    let clock = Date.now();
    const now = (): number => clock;
    new FileTokenStore(file).save(login(clock, { access_token: jwtExpiring(clock, HOUR) }));
    const cognito = fakeCognito(now);
    const proc = (pid: number) => {
      const lock = new TokenLock({ path: `${file}.lock`, pid, host: "laptop", now, isAlive: () => true });
      return { lock, manager: new TokenManager({ store: new FileTokenStore(file), lock, now, refresh: cognito.refresh, ...quiet }) };
    };
    const a = proc(1);
    a.manager.start();
    a.lock.stopHeartbeat();
    clock += 8 * HOUR; // a went silent (asleep, stalled); b takes the login over and rotates it
    const b = proc(2);
    b.manager.start();
    await b.manager.getToken();
    expect((new FileTokenStore(file).load() as TokenRecord).refresh_token).toBe("rt-1");

    a.manager.annotate({ installation_id: "A-INSTALL" }); // a hasn't noticed yet
    expect((new FileTokenStore(file).load() as TokenRecord).refresh_token).toBe("rt-1");
    // The owner still can, and keeps the rotated tokens.
    b.manager.annotate({ installation_id: "B-INSTALL" });
    expect(new FileTokenStore(file).load()).toMatchObject({ refresh_token: "rt-1", installation_id: "B-INSTALL" });
    a.manager.stop();
    b.manager.stop();
  });

  it("a refresh keeps what annotate() recorded while it was on the wire", async () => {
    const file = join(dir, "tokens.json");
    const now = Date.now();
    new FileTokenStore(file).save(login(now, { access_token: jwtExpiring(now, 0) }));
    let manager!: TokenManager;
    const refresh = vi.fn(async (): Promise<CognitoTokens> => {
      manager.annotate({ user_id: 77, installation_id: "KEEP" });
      return { accessToken: jwtExpiring(now, 24 * HOUR), refreshToken: "rt-1", idToken: "", expiresAt: 0 };
    });
    manager = new TokenManager({ store: new FileTokenStore(file), refresh, ...quiet });
    await manager.getToken();
    expect(new FileTokenStore(file).load()).toMatchObject({ refresh_token: "rt-1", user_id: 77, installation_id: "KEEP" });
  });

  it("adopt() saves a pushed login and switches to it", async () => {
    const now = Date.now();
    const store = new MemoryTokenStore(login(now));
    const manager = new TokenManager({ store, ...quiet });
    const pushed = login(now, { access_token: jwtExpiring(now, 24 * HOUR, { n: "pushed" }), refresh_token: "rt-pushed", source: "push", saved_at: new Date(now + 1).toISOString() });
    manager.adopt(pushed);
    expect(store.load()).toEqual(pushed);
    await expect(manager.getToken()).resolves.toBe(pushed.access_token);
  });

  it("adopt() clears an expired state", async () => {
    const now = Date.now();
    const store = new MemoryTokenStore(login(now, { access_token: jwtExpiring(now, 0) }));
    const refresh = vi.fn().mockRejectedValue(new CognitoError("NotAuthorizedException: x", 400, "NotAuthorizedException"));
    const manager = new TokenManager({ store, refresh, ...quiet });
    await expect(manager.getToken()).rejects.toBeInstanceOf(WhoopAuthExpiredError);
    manager.adopt(login(now, { refresh_token: "rt-new", saved_at: new Date(now + 1).toISOString() }));
    expect(manager.status().state).toBe("ok");
  });
});

describe("keepAliveMsFromEnv", () => {
  it("defaults to 12 h and accepts hours (0 = expiry-driven only)", () => {
    expect(keepAliveMsFromEnv(undefined)).toBe(12 * HOUR);
    expect(keepAliveMsFromEnv("6")).toBe(6 * HOUR);
    expect(keepAliveMsFromEnv("0")).toBe(0);
    expect(keepAliveMsFromEnv("nope")).toBe(12 * HOUR);
  });
});
