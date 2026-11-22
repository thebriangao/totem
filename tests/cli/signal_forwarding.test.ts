// `totem start` is a wrapper around the server process. A supervisor (systemd,
// a container runtime, a closed terminal) signals the wrapper: it has to pass
// SIGTERM / SIGHUP on, or the wrapper dies and the server lives on, orphaned,
// still holding its port.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WRAPPER = fileURLToPath(new URL("./fixtures/signal_wrapper.ts", import.meta.url));
const CHILD = fileURLToPath(new URL("./fixtures/signal_child.mjs", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe.skipIf(process.platform === "win32")("the subprocess runner passes termination on to its child", () => {
  let dir = "";
  let wrapper: ChildProcess | undefined;
  let childPid = 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "totem-signal-"));
    wrapper = spawn(process.execPath, ["--import", "tsx", WRAPPER, CHILD, dir], { cwd: ROOT, stdio: "ignore" });
    expect(await until(() => existsSync(join(dir, "child.pid")))).toBe(true);
    childPid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    expect(alive(childPid)).toBe(true);
  });

  afterEach(() => {
    if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
    wrapper?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["SIGTERM", "SIGHUP"] as const)("%s to the wrapper reaches the child, and both exit", async (signal) => {
    const exited = new Promise<number | null>((resolve) => wrapper!.once("exit", (code) => resolve(code)));
    wrapper!.kill(signal);
    expect(await until(() => existsSync(join(dir, "signal")))).toBe(true);
    expect(readFileSync(join(dir, "signal"), "utf8")).toBe(signal);
    // The wrapper waits for the child and reports the child's own exit code.
    expect(await exited).toBe(0);
    expect(await until(() => !alive(childPid))).toBe(true);
  });
});
