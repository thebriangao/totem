// `totem update --auto on|off` on Linux edits the person's crontab: it reads it
// with `crontab -l`, and writes back every line but its own (plus its own, for
// "on"). The crontab is theirs: a read that failed must never be mistaken for
// an empty crontab and written back.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { runCli, type AppCtx } from "../../src/cli/app.js";
import type { ExecResult } from "../../src/cli/sys.js";
import { fakeWorld, type FakeWorld } from "./helpers.js";

const JOBS = "MAILTO=me@example.com\n0 3 * * * /usr/local/bin/backup.sh\n*/5 * * * * /home/me/bin/sync\n";
const TOTEM = "0 */6 * * * cd '/old/totem' && /usr/bin/node /old/totem/dist/cli/index.js update --auto-run >> '/old/totem/.totem-autoupdate.log' 2>&1 # com.totem.autoupdate\n";

let world: FakeWorld | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });

/** Run `totem update --auto <value>` on a Linux box whose `crontab -l` answers `list`. */
async function auto(value: "on" | "off", list: ExecResult): Promise<{ code: number; text: string; written: string[] }> {
  const written: string[] = [];
  const w = fakeWorld({
    platform: "linux",
    exec: (cmd, args, input) => {
      if (cmd !== "crontab") return undefined;
      if (args[0] === "-l") return list;
      if (args[0] === "-") written.push(input ?? "");
      return undefined;
    },
  });
  world = w;
  const app: AppCtx = { root: w.root, version: "1.5.1", pkgName: "@thebriangao/totem", pkgPath: join(w.root, "package.json"), cliEntry: join(w.root, "dist", "cli", "index.js") };
  const code = await runCli(["update", "--auto", value], app, w.io);
  return { code, text: w.transcript(), written };
}
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const unreadable: ExecResult = { code: 1, stdout: "", stderr: "crontab: can't open your crontab file: Resource temporarily unavailable\n" };
const none: ExecResult = { code: 1, stdout: "", stderr: "no crontab for me\n" };

describe("auto-update and the person's crontab", () => {
  it.each(["on", "off"] as const)("--auto %s writes nothing when the crontab can't be read", async (value) => {
    const { code, text, written } = await auto(value, unreadable);
    expect(written).toEqual([]);
    expect(code).toBe(1);
    expect(text).toContain("Couldn't read your crontab, so totem left it as it is.");
    expect(text).toContain("Resource temporarily unavailable");
    expect(text).not.toContain("Auto-update is o");
  });

  it("--auto on starts from nothing when there is no crontab yet", async () => {
    for (const noCrontab of [none, { code: 1, stdout: "", stderr: "crontab: can't open 'me': No such file or directory\n" }]) {
      const { code, written } = await auto("on", noCrontab);
      expect(code).toBe(0);
      expect(written).toHaveLength(1);
      expect(written[0]!.trim().split("\n")).toHaveLength(1);
      expect(written[0]).toMatch(/update --auto-run .* # com\.totem\.autoupdate\n$/);
      world?.cleanup();
    }
  });

  it("--auto on keeps every other job and replaces its own line", async () => {
    const { written } = await auto("on", ok(JOBS + TOTEM));
    expect(written).toHaveLength(1);
    const lines = written[0]!.trim().split("\n");
    expect(lines.slice(0, 3)).toEqual(JOBS.trim().split("\n"));
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain("# com.totem.autoupdate");
    expect(lines[3]).not.toContain("/old/totem");
  });

  it("--auto off removes only its own line", async () => {
    const { code, written } = await auto("off", ok(JOBS + TOTEM));
    expect(code).toBe(0);
    expect(written).toEqual([JOBS]);
  });

  it("--auto off leaves a crontab without its line alone", async () => {
    expect((await auto("off", ok(JOBS))).written).toEqual([]);
    world?.cleanup();
    const { code, text, written } = await auto("off", none);
    expect(written).toEqual([]);
    expect(code).toBe(0);
    expect(text).toContain("Auto-update is off");
  });
});
