// launchd and cron start a job with a bare PATH (/usr/bin:/bin…), where npm and
// the host's CLI usually aren't, so a scheduled update failed at `npm install`.
// update.test.ts checks that launchdPlist() and cronLine() can carry a PATH;
// this checks that `totem update --auto on` actually gives them one.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, type AppCtx } from "../../src/cli/app.js";
import { fakeWorld, type FakeWorld } from "./helpers.js";

let world: FakeWorld | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });

/** `totem update --auto on`, with node living outside the PATH the command was run with. */
async function autoOn(platform: NodeJS.Platform): Promise<{ w: FakeWorld; crontab: string[] }> {
  const crontab: string[] = [];
  const w = fakeWorld({
    platform,
    exec: (cmd, args, input) => {
      if (cmd === "crontab" && args[0] === "-l") return { code: 1, stdout: "", stderr: "no crontab for me\n" };
      if (cmd === "crontab" && args[0] === "-") crontab.push(input ?? "");
      return undefined;
    },
  });
  world = w;
  w.io.sys.node = "/opt/node24/bin/node";
  w.io.sys.env = { PATH: "/home/me/.fly/bin:/usr/local/bin:/usr/bin:/bin" };
  const app: AppCtx = { root: w.root, version: "1.5.1", pkgName: "@thebriangao/totem", pkgPath: join(w.root, "package.json"), cliEntry: join(w.root, "dist", "cli", "index.js") };
  expect(await runCli(["update", "--auto", "on"], app, w.io)).toBe(0);
  return { w, crontab };
}
const PATH = "/opt/node24/bin:/home/me/.fly/bin:/usr/local/bin:/usr/bin:/bin";

describe("the scheduled update job gets a PATH that can find npm and the host CLI", () => {
  it("launchd: the plist sets PATH to node's directory, then the PATH --auto on was run with", async () => {
    const { w } = await autoOn("darwin");
    const plist = readFileSync(join(w.home, "Library", "LaunchAgents", "com.totem.autoupdate.plist"), "utf8");
    expect(plist).toContain(`<key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${PATH}</string>\n  </dict>`);
    expect(plist).toContain("<string>/opt/node24/bin/node</string>");
  });

  it("cron: the line exports that PATH before it does anything else", async () => {
    const { crontab } = await autoOn("linux");
    expect(crontab).toHaveLength(1);
    expect(crontab[0]).toContain(`0 */6 * * * export PATH='${PATH}'; cd `);
    expect(crontab[0]).toContain("/opt/node24/bin/node ");
  });
});
