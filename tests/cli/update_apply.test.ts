// applyVersion's git path, with every subprocess stubbed: it must always check
// out the release tag (latest included), never pull main.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";

const calls: Array<{ cmd: string; args: string[] }> = [];
vi.mock("../../src/cli/ui.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/cli/ui.js")>();
  const ok = { code: 0, stdout: "", stderr: "" };
  return {
    ...real,
    capture: (cmd: string, args: string[]) => { calls.push({ cmd, args }); return ok; },
    captureAsync: async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return ok; },
    spin: () => ({ stop: () => {} }),
  };
});

const { applyVersion } = await import("../../src/cli/update.js");

const root = resolve(import.meta.dirname, "..", "..");
const ctx = {
  root, version: "1.5.0", pkgPath: resolve(root, "package.json"), pkgName: "@thebriangao/totem",
  cliEntry: "x", isGit: true, detectDeploy: () => null, redeploy: async () => 0,
};

describe("applyVersion (git install)", () => {
  beforeEach(() => { calls.length = 0; vi.spyOn(console, "log").mockImplementation(() => {}); });

  it("checks out the release tag for the latest version instead of pulling main", async () => {
    expect(await applyVersion(ctx, { version: "1.5.1", tag: "v1.5.1" })).toBe(0);
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(git).toContain("fetch --tags --quiet origin");
    expect(git).toContain("checkout --quiet v1.5.1");
    expect(git.some((a) => a.startsWith("pull") || a === "checkout main")).toBe(false);
  });

  it("builds by running typescript's JS entry with node (not the .bin shim)", async () => {
    await applyVersion(ctx, { version: "1.5.1", tag: "v1.5.1" });
    const build = calls.find((c) => c.cmd === process.execPath);
    expect(build?.args[0]).toMatch(/typescript[\\/]bin[\\/]tsc$/);
  });
});
