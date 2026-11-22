// applyVersion against REAL git, in a throwaway repository with two release
// tags. update_apply.test.ts checks which git commands are issued; this checks
// what git then does with them, for the case a fake can't show: the update's
// own `npm install` rewrote package-lock.json (a tracked file that differs
// between any two releases) before the update failed or finished.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec as realExec } from "../../src/cli/sys.js";
import { applyVersion, type UpdateCtx } from "../../src/cli/update.js";
import { fakeWorld, linkDependencies, type FakeWorld } from "./helpers.js";

// The person's own git config (hooks, signing, templates) stays out of it.
const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const hasGit = spawnSync("git", ["--version"]).status === 0;

let world: FakeWorld | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });

interface Repo { w: FakeWorld; ctx: UpdateCtx; git: (...args: string[]) => string; version: () => string }

/** A checkout at v1.0.0 with v1.1.0 released; `npm` is whatever the test says. */
function checkout(npm: (repo: string, nth: number) => { code: number; stderr?: string }): Repo {
  const w = fakeWorld({ unbuilt: true });
  world = w;
  const repo = join(w.home, "repo");
  mkdirSync(repo);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  const release = (v: string): void => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: v }, null, 2) + "\n");
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "x", version: v, lockfileVersion: 3, packages: { "": { name: "x", version: v } } }, null, 2) + "\n");
    git("add", "-A");
    git("commit", "-qm", v);
    git("tag", `v${v}`);
  };
  git("init", "-q", "-b", "main");
  release("1.0.0");
  release("1.1.0");
  execFileSync("git", ["clone", "-q", "--bare", repo, join(w.home, "origin.git")], { env: GIT_ENV });
  git("remote", "add", "origin", join(w.home, "origin.git"));
  git("checkout", "-q", "v1.0.0");
  linkDependencies(repo); // the build step looks up tsc here; untracked, so git doesn't mind

  let installs = 0;
  w.io.sys.exec = async (cmd, args, o = {}) => {
    if (cmd === "git") return realExec("git", args, { cwd: o.cwd, env: GIT_ENV });
    if (cmd === "npm") return { stdout: "", stderr: "", ...npm(repo, ++installs) };
    return { code: 0, stdout: "", stderr: "" }; // the build
  };
  const ctx: UpdateCtx = {
    root: repo, version: "1.0.0", pkgPath: join(repo, "package.json"), pkgName: "x", cliEntry: "x", isGit: true,
    detectDeploy: () => null, redeploy: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return { w, ctx, git, version: () => (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version };
}

/** What a different npm does to a lockfile it didn't write. */
const rewriteLock = (repo: string): void => {
  const lock = join(repo, "package-lock.json");
  writeFileSync(lock, readFileSync(lock, "utf8").replace('"lockfileVersion": 3', '"lockfileVersion": 3,\n  "requires": true'));
};

describe.skipIf(!hasGit || process.platform === "win32")("applyVersion with real git, when npm rewrites package-lock.json", () => {
  // git refused the checkout back ("Your local changes to package-lock.json
  // would be overwritten"), so the install stayed on the new tag with the old
  // build: the half-applied state the rollback exists to prevent.
  it("still goes back to the version it started from when the install then fails", async () => {
    const { w, ctx, git, version } = checkout((repo, nth) => {
      rewriteLock(repo);
      return nth === 1 ? { code: 1, stderr: "npm error network ENOTFOUND" } : { code: 0 };
    });
    expect(await applyVersion(ctx, { version: "1.1.0", tag: "v1.1.0" }, w.io)).toBe("failed");
    expect(w.transcript()).not.toContain("Couldn't go back");
    expect(w.transcript()).toContain("Back on 1.0.0; nothing changed");
    expect(version()).toBe("1.0.0");
    expect(git("describe", "--tags", "--exact-match", "HEAD").trim()).toBe("v1.0.0");
    expect(git("status", "--porcelain", "--untracked-files=no").trim()).toBe("");
  });

  // Otherwise the next `totem update` (and every scheduled one) stops at
  // "This checkout has uncommitted changes to tracked files".
  it("leaves the tracked tree clean after an update that worked", async () => {
    const { w, ctx, git, version } = checkout((repo) => { rewriteLock(repo); return { code: 0 }; });
    expect(await applyVersion(ctx, { version: "1.1.0", tag: "v1.1.0" }, w.io)).toBe("done");
    expect(version()).toBe("1.1.0");
    expect(git("status", "--porcelain", "--untracked-files=no").trim()).toBe("");
  });

  it("goes back as before when npm leaves the lockfile alone", async () => {
    const { w, ctx, git, version } = checkout((_repo, nth) => (nth === 1 ? { code: 1, stderr: "npm error" } : { code: 0 }));
    expect(await applyVersion(ctx, { version: "1.1.0", tag: "v1.1.0" }, w.io)).toBe("failed");
    expect(version()).toBe("1.0.0");
    expect(git("status", "--porcelain", "--untracked-files=no").trim()).toBe("");
  });
});
