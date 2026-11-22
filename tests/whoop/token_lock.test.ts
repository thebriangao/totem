import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenLock, WhoopTokenOwnedError, type TokenLockOptions } from "../../src/whoop/token_lock.js";

let dir: string;
let path: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "totem-lock-"));
  path = join(dir, "tokens.json.lock");
  clock = Date.now();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = new Set<number>();
const lock = (pid: number, over: Partial<TokenLockOptions> = {}): TokenLock =>
  new TokenLock({ path, pid, host: "laptop", now: () => clock, isAlive: (p) => alive.has(p), ...over });

describe("TokenLock contention", () => {
  beforeEach(() => { alive.clear(); alive.add(100).add(200); });

  it("lets exactly one process own the login", () => {
    const a = lock(100);
    const b = lock(200);
    expect(a.tryAcquire()).toEqual({ acquired: true });
    const second = b.tryAcquire();
    expect(second.acquired).toBe(false);
    expect(second.acquired === false && second.holder?.pid).toBe(100);
    expect(a.held).toBe(true);
    expect(b.held).toBe(false);
  });

  it("writes pid, host and a heartbeat into the lock file", () => {
    lock(100).tryAcquire();
    const info = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(info).toMatchObject({ pid: 100, host: "laptop", heartbeat_at: new Date(clock).toISOString() });
    expect(typeof info.nonce).toBe("string");
  });

  it("re-acquiring a lock we hold is a no-op", () => {
    const a = lock(100);
    a.tryAcquire();
    expect(a.tryAcquire()).toEqual({ acquired: true });
  });

  it("release removes only our own lock", () => {
    const a = lock(100);
    const b = lock(200);
    a.tryAcquire();
    b.release(); // not ours
    expect(existsSync(path)).toBe(true);
    a.release();
    expect(existsSync(path)).toBe(false);
    expect(b.tryAcquire()).toEqual({ acquired: true });
  });

  it("the error names the owner and the rule", () => {
    const a = lock(100);
    a.tryAcquire();
    const err = new WhoopTokenOwnedError(a.readHolder(), path);
    expect(err.message).toMatch(/token owned by pid 100/);
    expect(err.message).toMatch(/Don't run local and remote on one login/);
  });
});

describe("TokenLock stale takeover", () => {
  beforeEach(() => { alive.clear(); });

  it("takes over when the owner's pid is gone (same host)", () => {
    alive.add(100);
    lock(100).tryAcquire();
    alive.delete(100); // crashed without releasing
    const b = lock(200);
    expect(b.tryAcquire()).toEqual({ acquired: true });
    expect(b.readHolder()?.pid).toBe(200);
  });

  it("does not take over a live owner with a fresh heartbeat", () => {
    alive.add(100).add(200);
    lock(100).tryAcquire();
    clock += 60_000;
    expect(lock(200).tryAcquire().acquired).toBe(false);
  });

  it("takes over another host's lock once its heartbeat is older than 90 s", () => {
    lock(100, { host: "fly-machine" }).tryAcquire();
    const b = lock(200);
    clock += 89_000;
    expect(b.tryAcquire().acquired).toBe(false);
    clock += 2_000;
    expect(b.tryAcquire()).toEqual({ acquired: true });
  });

  it("heartbeats keep a lock alive past the stale window", () => {
    const a = lock(100, { host: "other" });
    a.tryAcquire();
    for (let i = 0; i < 5; i++) { clock += 30_000; expect(a.heartbeat()).toBe(true); }
    expect(lock(200).tryAcquire().acquired).toBe(false);
  });

  it("treats its own pid with another nonce as a dead previous incarnation (container pid 1)", () => {
    alive.add(1);
    lock(1).tryAcquire(); // the container before the restart
    const restarted = lock(1);
    expect(restarted.tryAcquire()).toEqual({ acquired: true });
  });

  it("the loser of a takeover finds out on verify/heartbeat", () => {
    const a = lock(100, { host: "other" });
    a.tryAcquire();
    clock += 120_000; // a's event loop stalled
    const b = lock(200);
    expect(b.tryAcquire()).toEqual({ acquired: true });
    expect(a.verify()).toBe(false);
    expect(a.heartbeat()).toBe(false);
    expect(a.held).toBe(false);
    a.release(); // must not delete b's lock
    expect(b.verify()).toBe(true);
  });

  it("a half-written lock is respected while young and taken over when old", () => {
    writeFileSync(path, "");
    expect(lock(200).tryAcquire().acquired).toBe(false);
    const old = (clock - 120_000) / 1000;
    utimesSync(path, old, old);
    expect(lock(200).tryAcquire()).toEqual({ acquired: true });
  });
});
