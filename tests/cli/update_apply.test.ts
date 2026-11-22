// applyVersion's git path against a fake machine: it must always check out the
// release tag (latest included), never pull main, and go back to where it
// started when the update doesn't finish.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "../../src/cli/sys.js";
import { applyVersion, followsReleases, runUpdate, type UpdateCtx } from "../../src/cli/update.js";
import { fakeWorld, type FakeWorld, type WorldOptions } from "./helpers.js";

type Handler = NonNullable<WorldOptions["exec"]>;
const out = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr });

const onBranch = (name: string): Handler => (cmd, args) =>
  cmd === "git" && args[0] === "symbolic-ref" ? out(`${name}\n`) : undefined;
const detachedAt = (sha: string): Handler => (cmd, args) =>
  cmd === "git" && args[0] === "symbolic-ref" ? fail("", 1)
    : cmd === "git" && args.join(" ") === "rev-parse HEAD" ? out(`${sha}\n`) : undefined;

let world: FakeWorld | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });

function setup(exec: Handler, over: Partial<UpdateCtx> = {}): { w: FakeWorld; ctx: UpdateCtx; git: () => string[] } {
  const w = fakeWorld({ exec });
  world = w;
  mkdirSync(join(w.root, ".git"));
  const ctx: UpdateCtx = {
    root: w.root, version: "1.5.0", pkgPath: join(w.root, "package.json"), pkgName: "@thebriangao/totem",
    cliEntry: join(w.root, "dist", "cli", "index.js"), isGit: true, detectDeploy: () => null,
    redeploy: async () => ({ code: 0, stdout: "", stderr: "" }), ...over,
  };
  return { w, ctx, git: () => w.commands.filter((c) => c.startsWith("exec  git ")).map((c) => c.slice("exec  git ".length)) };
}
const checkouts = (git: () => string[]): string[] => git().filter((a) => a.startsWith("checkout"));
const TARGET = { version: "1.5.1", tag: "v1.5.1" };

describe("applyVersion (git install)", () => {
  it("checks out the release tag for the latest version instead of pulling main", async () => {
    const { w, ctx, git } = setup(() => undefined);
    expect(await applyVersion(ctx, TARGET, w.io)).toBe("done");
    expect(git()).toContain("fetch --tags --quiet origin");
    expect(git()).toContain("checkout --quiet v1.5.1");
    expect(git().some((a) => a.startsWith("pull") || a === "checkout main")).toBe(false);
  });

  it("builds by running typescript's JS entry with node (not the .bin shim)", async () => {
    const { w, ctx } = setup(() => undefined);
    await applyVersion(ctx, TARGET, w.io);
    const build = w.commands.find((c) => c.startsWith("exec  /usr/local/bin/node "));
    expect(build).toMatch(/typescript[\\/]bin[\\/]tsc$/);
  });

  // Without this, the checkout stays on the new tag: package.json then reads the
  // new version, the next check finds nothing newer and says "up to date" while
  // the old build is still what runs.
  it("goes back to the starting commit when `npm install` fails", async () => {
    const start = detachedAt("abc1234");
    const { w, ctx, git } = setup((cmd, args, input, world_) =>
      cmd === "npm" && args[0] === "install" && (world_.counts.installs = (world_.counts.installs ?? 0) + 1) === 1
        ? fail("npm error code ENOENT")
        : start(cmd, args, input, world_));
    expect(await applyVersion(ctx, TARGET, w.io)).toBe("failed");
    expect(checkouts(git)).toEqual(["checkout --quiet v1.5.1", "checkout --quiet abc1234"]);
    // …and rebuilds the version it went back to.
    expect(w.counts.installs).toBe(2);
    expect(w.commands.filter((c) => c.startsWith("exec  /usr/local/bin/node "))).toHaveLength(1);
    expect(w.transcript()).toContain("Back on 1.5.0; nothing changed");
    expect(w.transcript()).toContain("npm error code ENOENT");
  });

  it("goes back to the branch it was on when the build fails", async () => {
    const start = onBranch("main");
    const { w, ctx, git } = setup((cmd, args, input, world_) =>
      cmd === "/usr/local/bin/node" && (world_.counts.builds = (world_.counts.builds ?? 0) + 1) === 1
        ? { code: 2, stdout: "src/x.ts(1,1): error TS1005: ';' expected.", stderr: "" }
        : start(cmd, args, input, world_));
    expect(await applyVersion(ctx, TARGET, w.io)).toBe("failed");
    expect(checkouts(git)).toEqual(["checkout --quiet v1.5.1", "checkout --quiet main"]);
    expect(w.counts.builds).toBe(2);
    expect(w.transcript()).toContain("error TS1005");
  });

  it("goes back when the deploy fails, so the install matches the server", async () => {
    const { w, ctx, git } = setup(detachedAt("abc1234"), {
      detectDeploy: () => ({ platform: "fly", app: "totem-x", url: "https://totem-x.fly.dev" }),
      redeploy: async () => fail("Error: failed to build"),
    });
    expect(await applyVersion(ctx, TARGET, w.io)).toBe("failed");
    expect(checkouts(git)).toEqual(["checkout --quiet v1.5.1", "checkout --quiet abc1234"]);
    expect(w.transcript()).toContain("The deploy failed. The server is unchanged.");
  });

  it("says what to run when it can't go back", async () => {
    const start = detachedAt("abc1234");
    const { w, ctx } = setup((cmd, args, input, world_) => {
      if (cmd === "npm") return fail("npm error");
      if (cmd === "git" && args.join(" ") === "checkout --quiet abc1234") return fail("error: unable to unlink old file");
      return start(cmd, args, input, world_);
    });
    expect(await applyVersion(ctx, TARGET, w.io)).toBe("failed");
    expect(w.transcript()).toContain("git checkout abc1234 && npm install && totem build");
  });

  it("leaves a successful update where it is", async () => {
    const { w, ctx, git } = setup(detachedAt("abc1234"));
    expect(await applyVersion(ctx, TARGET, w.io)).toBe("done");
    expect(checkouts(git)).toEqual(["checkout --quiet v1.5.1"]);
  });

  it("says the server wasn't updated when its host CLI isn't on this machine", async () => {
    const w = fakeWorld({ missing: ["fly", "flyctl"] });
    world = w;
    const ctx: UpdateCtx = {
      root: w.root, version: "1.5.0", pkgPath: join(w.root, "package.json"), pkgName: "@thebriangao/totem", cliEntry: "x", isGit: true,
      detectDeploy: () => ({ platform: "fly", app: "totem-x", url: "https://totem-x.fly.dev" }),
      redeploy: async () => { throw new Error("must not deploy"); },
    };
    expect(await applyVersion(ctx, TARGET, w.io)).toBe("local-only");
    expect(w.transcript().replace(/\s+/g, " ")).toMatch(/Fly CLI \(flyctl\) isn't installed on this machine, so the server still runs 1\.5\.0/);
  });
});

// The scheduled job checks out a release tag. On a feature branch that would
// silently take someone's checkout off their branch.
describe("auto-run (git install)", () => {
  const newer: Handler = (cmd, args) => (cmd === "git" && args[0] === "tag" ? out("v9.9.9\nv1.5.0\n") : undefined);
  const branch = (name: string): Handler => (cmd, args, input, world_) =>
    cmd === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD" ? out(`${name}\n`) : newer(cmd, args, input, world_);
  // No release notes: the fake world never answers GitHub with a release list.
  const noNotes = { status: 404, body: "" };

  it("only follows main or a detached release checkout", () => {
    expect(followsReleases("main")).toBe(true);
    expect(followsReleases("HEAD")).toBe(true);
    expect(followsReleases("v2")).toBe(false);
    expect(followsReleases("feature/main")).toBe(false);
    expect(followsReleases("")).toBe(false);
  });

  it("leaves a checkout on another branch alone", async () => {
    const { w, ctx, git } = setup(branch("v2-ux"));
    w.io.sys.httpGet = async () => ({ ...noNotes, ms: 1 });
    expect(await runUpdate(["--auto-run"], ctx, w.io)).toBe(0);
    expect(git().some((a) => a.startsWith("checkout") || a.startsWith("fetch"))).toBe(false);
    expect(w.commands.some((c) => c.startsWith("exec  npm"))).toBe(false);
    expect(w.transcript()).toMatch(/on branch 'v2-ux'.*skipped/);
  });

  it.each(["main", "HEAD"])("updates a checkout on %s", async (name) => {
    const { w, ctx, git } = setup(branch(name));
    w.io.sys.httpGet = async () => ({ ...noNotes, ms: 1 });
    expect(await runUpdate(["--auto-run"], ctx, w.io)).toBe(0);
    expect(git()).toContain("checkout --quiet v9.9.9");
    expect(w.transcript()).toMatch(/\] now on 9\.9\.9/);
  });

  // The log must never say "up to date" on top of a failed update.
  it("logs a failed update as failed, and exits non-zero", async () => {
    const { w, ctx } = setup((cmd, args, input, world_) => (cmd === "npm" ? fail("npm error code ENOENT") : branch("main")(cmd, args, input, world_)));
    w.io.sys.httpGet = async () => ({ ...noNotes, ms: 1 });
    expect(await runUpdate(["--auto-run"], ctx, w.io)).toBe(1);
    expect(w.transcript()).toMatch(/\] FAILED: still on 1\.5\.0; the next check tries again/);
    expect(w.transcript()).not.toMatch(/up to date/);
  });
});
