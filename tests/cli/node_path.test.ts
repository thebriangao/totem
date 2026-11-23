// totem writes the path of node into other programs' files: a client's MCP
// config ("command"), the launchd job, the cron line. process.execPath is the
// resolved path, and under Homebrew that is the versioned keg, which the next
// `brew upgrade` deletes. Those files must get a path that survives it.
import { describe, expect, it } from "vitest";
import { realSys, stableNodePath } from "../../src/cli/sys.js";

/** A realpath over a made-up filesystem: `links` maps a path prefix to what it points at. */
const realpathWith = (links: Record<string, string>) => (path: string): string => {
  for (const [from, to] of Object.entries(links)) if (path === from || path.startsWith(from + "/")) return to + path.slice(from.length);
  return path;
};

describe("stableNodePath", () => {
  it("uses Homebrew's opt link instead of the keg (Apple silicon, Intel, Linuxbrew)", () => {
    for (const prefix of ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"]) {
      const keg = `${prefix}/Cellar/node/25.9.0_1/bin/node`;
      const realpath = realpathWith({ [`${prefix}/opt/node`]: `${prefix}/Cellar/node/25.9.0_1` });
      expect(stableNodePath(keg, realpath)).toBe(`${prefix}/opt/node/bin/node`);
    }
  });

  it("follows a versioned formula to its own opt link", () => {
    const realpath = realpathWith({ "/opt/homebrew/opt/node@22": "/opt/homebrew/Cellar/node@22/22.11.0" });
    expect(stableNodePath("/opt/homebrew/Cellar/node@22/22.11.0/bin/node", realpath)).toBe("/opt/homebrew/opt/node@22/bin/node");
  });

  it("keeps the keg when the opt link isn't this node", () => {
    // Points at another version (this keg is an old one still running)…
    const other = realpathWith({ "/opt/homebrew/opt/node": "/opt/homebrew/Cellar/node/26.0.0" });
    expect(stableNodePath("/opt/homebrew/Cellar/node/25.9.0_1/bin/node", other)).toBe("/opt/homebrew/Cellar/node/25.9.0_1/bin/node");
    // …or doesn't exist.
    const missing = (path: string): string => { if (path.includes("/opt/node/")) throw new Error("ENOENT"); return path; };
    expect(stableNodePath("/opt/homebrew/Cellar/node/25.9.0_1/bin/node", missing)).toBe("/opt/homebrew/Cellar/node/25.9.0_1/bin/node");
  });

  it("leaves every other install where it is", () => {
    const never = (): string => { throw new Error("must not look"); };
    for (const path of [
      "/usr/local/bin/node", "/usr/bin/node",
      "/Users/me/.nvm/versions/node/v24.3.0/bin/node",
      "/Users/me/.local/share/fnm/node-versions/v24.3.0/installation/bin/node",
      "/Users/me/.volta/tools/image/node/24.3.0/bin/node",
      "C:\\Program Files\\nodejs\\node.exe",
    ]) expect(stableNodePath(path, never)).toBe(path);
  });

  it("is what the CLI hands to everything that writes node's path down", () => {
    expect(realSys().node).toBe(stableNodePath(process.execPath));
  });
});
