// applyVersion's git path, with every subprocess stubbed: it must always check
// out the release tag (latest included), never pull main, and go back to where
// it started when the update doesn't finish.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";

type Result = { code: number; stdout: string; stderr: string };
const calls: Array<{ cmd: string; args: string[] }> = [];
/** Per-test answers for a stubbed command; anything unanswered succeeds with no output. */
let answer: (cmd: string, args: string[]) => Result | undefined = () => undefined;
const ok: Result = { code: 0, stdout: "", stderr: "" };
const respond = (cmd: string, args: string[]): Result => {
  calls.push({ cmd, args });
  return answer(cmd, args) ?? ok;
};

vi.mock("../../src/cli/ui.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/cli/ui.js")>();
  return {
    ...real,
    capture: (cmd: string, args: string[]) => respond(cmd, args),
    captureAsync: async (cmd: string, args: string[]) => respond(cmd, args),
    commandExists: () => true,
    httpGet: async () => ({ status: 0, body: "" }), // no release notes: never the network
    ping: async () => 0,
    spin: () => ({ stop: () => {} }),
  };
});

const { applyVersion, runUpdate, followsReleases } = await import("../../src/cli/update.js");

const root = resolve(import.meta.dirname, "..", "..");
const ctx = {
  root, version: "1.5.0", pkgPath: resolve(root, "package.json"), pkgName: "@thebriangao/totem",
  cliEntry: "x", isGit: true, detectDeploy: () => null as { platform: string; app?: string; url?: string } | null, redeploy: async () => 0,
};
const git = (): string[] => calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
const onBranch = (name: string) => (cmd: string, args: string[]): Result | undefined =>
  cmd === "git" && args[0] === "symbolic-ref" ? { code: 0, stdout: `${name}\n`, stderr: "" } : undefined;
const detachedAt = (sha: string) => (cmd: string, args: string[]): Result | undefined =>
  cmd === "git" && args[0] === "symbolic-ref" ? { code: 1, stdout: "", stderr: "" }
    : cmd === "git" && args[0] === "rev-parse" ? { code: 0, stdout: `${sha}\n`, stderr: "" } : undefined;

describe("applyVersion (git install)", () => {
  let printed: string[];
  beforeEach(() => {
    calls.length = 0;
    answer = () => undefined;
    printed = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { printed.push(a.join(" ")); });
  });

  it("checks out the release tag for the latest version instead of pulling main", async () => {
    expect(await applyVersion(ctx, { version: "1.5.1", tag: "v1.5.1" })).toBe(0);
    expect(git()).toContain("fetch --tags --quiet origin");
    expect(git()).toContain("checkout --quiet v1.5.1");
    expect(git().some((a) => a.startsWith("pull") || a === "checkout main")).toBe(false);
  });

  it("builds by running typescript's JS entry with node (not the .bin shim)", async () => {
    await applyVersion(ctx, { version: "1.5.1", tag: "v1.5.1" });
    const build = calls.find((c) => c.cmd === process.execPath);
    expect(build?.args[0]).toMatch(/typescript[\\/]bin[\\/]tsc$/);
  });

  // Without this, the checkout stays on the new tag: package.json then reads the
  // new version, the next check finds nothing newer and says "up to date" while
  // the old build is still what runs.
  it("goes back to the starting commit when `npm install` fails", async () => {
    const start = detachedAt("abc1234");
    let installs = 0;
    answer = (cmd, args) => (cmd === "npm" && args[0] === "install" && ++installs === 1
      ? { code: 1, stdout: "", stderr: "npm error code ENOENT" }
      : start(cmd, args));
    expect(await applyVersion(ctx, { version: "1.5.1", tag: "v1.5.1" })).toBe(1);
    const checkouts = git().filter((a) => a.startsWith("checkout"));
    expect(checkouts).toEqual(["checkout --quiet v1.5.1", "checkout --quiet abc1234"]);
    // …and rebuilds the version it went back to.
    expect(installs).toBe(2);
    expect(calls.filter((c) => c.cmd === process.execPath)).toHaveLength(1);
    expect(printed.join("\n")).toMatch(/Went back to v1\.5\.0/);
  });

  it("goes back to the branch it was on when the build fails", async () => {
    const start = onBranch("main");
    let builds = 0;
    answer = (cmd, args) => (cmd === process.execPath && ++builds === 1 ? { code: 2, stdout: "src/x.ts(1,1): error TS1005", stderr: "" } : start(cmd, args));
    expect(await applyVersion(ctx, { version: "1.5.1", tag: "v1.5.1" })).toBe(1);
    expect(git().filter((a) => a.startsWith("checkout"))).toEqual(["checkout --quiet v1.5.1", "checkout --quiet main"]);
    expect(builds).toBe(2);
  });

  it("goes back when the deploy fails, so the install matches the server", async () => {
    answer = detachedAt("abc1234");
    const deployed = { ...ctx, detectDeploy: () => ({ platform: "fly", app: "totem-x", url: "https://totem-x.fly.dev" }), redeploy: async () => 1 };
    expect(await applyVersion(deployed, { version: "1.5.1", tag: "v1.5.1" })).toBe(1);
    expect(git().filter((a) => a.startsWith("checkout"))).toEqual(["checkout --quiet v1.5.1", "checkout --quiet abc1234"]);
  });

  it("says what to run when it can't go back", async () => {
    const start = detachedAt("abc1234");
    answer = (cmd, args) => {
      if (cmd === "npm") return { code: 1, stdout: "", stderr: "npm error" };
      if (cmd === "git" && args.join(" ") === "checkout --quiet abc1234") return { code: 1, stdout: "", stderr: "error: unable to unlink old file" };
      return start(cmd, args);
    };
    expect(await applyVersion(ctx, { version: "1.5.1", tag: "v1.5.1" })).toBe(1);
    expect(printed.join("\n")).toContain("git checkout abc1234 && npm install && totem build");
  });

  it("leaves a successful update where it is", async () => {
    answer = detachedAt("abc1234");
    expect(await applyVersion(ctx, { version: "1.5.1", tag: "v1.5.1" })).toBe(0);
    expect(git().filter((a) => a.startsWith("checkout"))).toEqual(["checkout --quiet v1.5.1"]);
  });
});

// The scheduled job checks out a release tag. On a feature branch that would
// silently take someone's checkout off their branch.
describe("auto-run (git install)", () => {
  let printed: string[];
  const newer = (cmd: string, args: string[]): Result | undefined => {
    if (cmd === "git" && args[0] === "tag") return { code: 0, stdout: "v9.9.9\nv1.5.0\n", stderr: "" };
    return undefined;
  };
  const branch = (name: string) => (cmd: string, args: string[]): Result | undefined =>
    cmd === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD" ? { code: 0, stdout: `${name}\n`, stderr: "" } : newer(cmd, args);

  beforeEach(() => {
    calls.length = 0;
    printed = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { printed.push(a.join(" ")); });
  });

  it("only follows main or a detached release checkout", () => {
    expect(followsReleases("main")).toBe(true);
    expect(followsReleases("HEAD")).toBe(true);
    expect(followsReleases("v2")).toBe(false);
    expect(followsReleases("feature/main")).toBe(false);
    expect(followsReleases("")).toBe(false);
  });

  it("leaves a checkout on another branch alone", async () => {
    answer = branch("v2-ux");
    expect(await runUpdate(["--auto-run"], ctx)).toBe(0);
    expect(git().some((a) => a.startsWith("checkout") || a.startsWith("fetch"))).toBe(false);
    expect(calls.some((c) => c.cmd === "npm")).toBe(false);
    expect(printed.join("\n")).toMatch(/on branch 'v2-ux'.*skipping/);
  });

  it.each(["main", "HEAD"])("updates a checkout on %s", async (name) => {
    answer = branch(name);
    expect(await runUpdate(["--auto-run"], ctx)).toBe(0);
    expect(git()).toContain("checkout --quiet v9.9.9");
  });
});
