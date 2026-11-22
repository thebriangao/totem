// An npm install (no .git) lists its versions with `npm view … versions`, which
// includes prereleases. Only plain x.y.z releases are installable: a prerelease
// must never be shown as the latest or installed by the scheduled job.
// update.test.ts checks isRelease(); this checks the updater uses it.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { runCli, type AppCtx } from "../../src/cli/app.js";
import { fakeWorld, type FakeWorld } from "./helpers.js";

const PUBLISHED = ["1.5.0", "1.5.1", "1.6.0-rc.1", "1.6.0", "2.0.0-beta.1", "2.0.0-rc.2"];

let world: FakeWorld | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });

async function update(...args: string[]): Promise<{ w: FakeWorld; code: number; text: string }> {
  const w = fakeWorld({
    exec: (cmd, a) => (cmd === "npm" && a[0] === "view" ? { code: 0, stdout: JSON.stringify(PUBLISHED), stderr: "" } : undefined),
    http: (url) => (url.includes("api.github.com") ? { status: 404, body: "" } : undefined),
  });
  world = w;
  const app: AppCtx = { root: w.root, version: "1.5.1", pkgName: "@thebriangao/totem", pkgPath: join(w.root, "package.json"), cliEntry: join(w.root, "dist", "cli", "index.js") };
  const code = await runCli(["update", ...args], app, w.io);
  return { w, code, text: w.transcript() };
}

describe("an npm install never takes a prerelease", () => {
  it("--check reports the newest plain release as the latest", async () => {
    const { text } = await update("--check");
    expect(text).toMatch(/Latest\s+1\.6\.0\b/);
    expect(text).toContain("An update is available: 1.6.0.");
    expect(text).not.toMatch(/2\.0\.0|rc|beta/);
  });

  it("the scheduled job installs that release, not the prerelease above it", async () => {
    const { w, code } = await update("--auto-run");
    expect(code).toBe(0);
    const installs = w.commands.filter((c) => c.startsWith("exec  npm install"));
    expect(installs).toEqual(["exec  npm install -g @thebriangao/totem@1.6.0"]);
  });
});
