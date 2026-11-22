import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TokenLock, WhoopTokenOwnedError, type AcquireResult, type TokenLockOptions } from "../../src/whoop/token_lock.js";

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

describe("TokenLock: only one process wins a stale lock", () => {
  beforeEach(() => { alive.clear(); });

  it("a process acting on an old reading of the stale lock can't delete the winner's new lock", () => {
    lock(100).tryAcquire(); // the owner, which then dies
    alive.add(200).add(300);
    const a = lock(200);
    const b = lock(300);
    // b judges the lock stale; before it acts on its second reading, a completes
    // a whole takeover. (Two real processes interleave like this; see below.)
    const read = b.readHolder.bind(b);
    let reads = 0;
    let aResult: AcquireResult | undefined;
    b.readHolder = () => {
      const holder = read();
      if (++reads === 2) aResult = a.tryAcquire();
      return holder;
    };
    const bResult = b.tryAcquire();
    expect([aResult?.acquired, bResult.acquired].filter(Boolean)).toHaveLength(1);
    expect([a.held, b.held].filter(Boolean)).toHaveLength(1);
    const winner = a.held ? a : b;
    expect(winner.verify()).toBe(true); // and the file agrees
    expect(readdirSync(dir)).toEqual(["tokens.json.lock"]); // no guard left behind
  });

  it("confirm() proves ownership and stamps a fresh heartbeat; a lost lock answers 'lost'", () => {
    alive.add(100).add(200);
    const a = lock(100);
    a.tryAcquire();
    clock += 8 * 3_600_000; // the laptop slept: no heartbeat ran
    expect(a.confirm()).toBe("held");
    expect(lock(200).tryAcquire().acquired).toBe(false); // fresh again: no takeover
    clock += 8 * 3_600_000;
    const b = lock(200);
    expect(b.tryAcquire()).toEqual({ acquired: true }); // a is alive but silent for hours
    expect(a.confirm()).toBe("lost");
    expect(a.held).toBe(false);
    expect(b.verify()).toBe(true); // a's confirm did not write over b's lock
  });

  it("confirm() answers 'busy', and nothing is taken over, while another process holds the guard", () => {
    alive.add(100);
    const a = lock(100);
    a.tryAcquire();
    writeFileSync(`${path}.guard`, "someone-else");
    expect(a.confirm()).toBe("busy");
    expect(a.heartbeat()).toBe(true); // a skipped beat, not a lost lock
    alive.delete(100);
    alive.add(200);
    expect(lock(200).tryAcquire().acquired).toBe(false); // can't replace a stale lock without the guard
    rmSync(`${path}.guard`);
    expect(lock(200).tryAcquire()).toEqual({ acquired: true });
  });

  it("clears a guard left by a process that died holding it", () => {
    lock(100).tryAcquire(); // dead owner
    alive.add(200);
    writeFileSync(`${path}.guard`, "dead");
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${path}.guard`, old, old);
    expect(lock(200).tryAcquire()).toEqual({ acquired: true });
    expect(existsSync(`${path}.guard`)).toBe(false);
  });

  it("release doesn't delete a lock while another process holds the guard", () => {
    alive.add(100);
    const a = lock(100);
    a.tryAcquire();
    writeFileSync(`${path}.guard`, "someone-else");
    a.release();
    expect(existsSync(path)).toBe(true);
    expect(a.held).toBe(false);
  });

  // The real thing: separate processes, a real file system. Before the guard,
  // 2 to 5 of 8 racers believed they owned the lock in 24 of 25 rounds.
  it("exactly one of several real processes takes over a dead owner's lock", async () => {
    const racer = fileURLToPath(new URL("./fixtures/lock_racer.ts", import.meta.url));
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const RACERS = 6;
    for (let round = 0; round < 3; round++) {
      const lockPath = join(dir, `round-${round}.lock`);
      const gate = join(dir, `round-${round}.go`);
      writeFileSync(lockPath, JSON.stringify({ pid: 2_000_000_000, host: hostname(), nonce: "dead", started_at: "", heartbeat_at: new Date().toISOString() }));
      const outputs = Array.from({ length: RACERS }, () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", racer, lockPath, gate], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        child.once("error", reject);
        child.once("exit", () => resolve(out));
      }));
      // Open the gate once every racer is spinning on it.
      for (let i = 0; i < 200 && readdirSync(dir).filter((f) => f.startsWith(`round-${round}.ready.`)).length < RACERS; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      writeFileSync(gate, "");
      const results = (await Promise.all(outputs)).map((o) => JSON.parse(o) as { acquired: boolean; stillOwner: boolean });
      expect(results).toHaveLength(RACERS);
      expect(results.filter((r) => r.acquired)).toHaveLength(1);
      expect(results.filter((r) => r.stillOwner)).toHaveLength(1);
    }
  }, 60_000);
});
