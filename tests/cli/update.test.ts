// Pure-logic tests for the updater. The I/O (git/npm/launchctl/network) can't
// run in CI, but version comparison, release parsing, and the scheduler-file
// generation are pure and must not regress.
import { describe, it, expect } from "vitest";
import { compareSemver, isNewer, parseReleases, launchdPlist, cronLine } from "../../src/cli/update.js";

describe("compareSemver", () => {
  it("orders by major/minor/patch", () => {
    expect(compareSemver("1.4.2", "1.4.1")).toBe(1);
    expect(compareSemver("1.4.1", "1.4.2")).toBe(-1);
    expect(compareSemver("1.4.0", "1.4.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });
  it("is numeric, not lexicographic (1.10 > 1.9)", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemver("1.4.10", "1.4.2")).toBe(1);
  });
  it("ignores a leading v", () => {
    expect(compareSemver("v1.4.2", "1.4.1")).toBe(1);
    expect(compareSemver("v1.4.1", "v1.4.1")).toBe(0);
  });
  it("sorts a list newest-first", () => {
    const sorted = ["1.2.0", "1.4.1", "1.10.0", "1.4.10"].sort((a, b) => compareSemver(b, a));
    expect(sorted).toEqual(["1.10.0", "1.4.10", "1.4.1", "1.2.0"]);
  });
});

describe("isNewer", () => {
  it("is true only for a strictly greater version", () => {
    expect(isNewer("1.4.2", "1.4.1")).toBe(true);
    expect(isNewer("1.4.1", "1.4.2")).toBe(false);
    expect(isNewer("1.4.1", "1.4.1")).toBe(false);
  });
});

describe("parseReleases", () => {
  const json = JSON.stringify([
    { tag_name: "v1.4.2", name: "v1.4.2", body: "Bug-fix release for #2.\nmore detail", published_at: "2026-06-07T21:00:23Z", draft: false },
    { tag_name: "v1.4.1", name: "v1.4.1", body: "- **Fixed:** the journal bug", published_at: "2026-06-06T05:40:08Z" },
    { tag_name: "v9.9.9", draft: true },
  ]);
  const map = parseReleases(json);

  it("indexes by version without the leading v", () => {
    expect(map.has("1.4.2")).toBe(true);
    expect(map.has("1.4.1")).toBe(true);
  });
  it("skips drafts", () => {
    expect(map.has("9.9.9")).toBe(false);
    expect(map.size).toBe(2);
  });
  it("extracts the published date (YYYY-MM-DD)", () => {
    expect(map.get("1.4.2")?.date).toBe("2026-06-07");
  });
  it("derives notes from the body's first line, markdown stripped", () => {
    expect(map.get("1.4.1")?.notes).toContain("Fixed");
    expect(map.get("1.4.1")?.notes).not.toContain("*");
  });
  it("never throws on garbage input", () => {
    expect(parseReleases("not json").size).toBe(0);
    expect(parseReleases("{}").size).toBe(0);
  });
});

describe("launchdPlist", () => {
  const xml = launchdPlist(
    ["/usr/local/bin/node", "/app/dist/cli/index.js", "update", "--auto-run"],
    21600, "/app", "/app/.totem-autoupdate.log",
  );
  it("is a well-formed plist with our label", () => {
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain("<string>com.totem.autoupdate</string>");
  });
  it("runs `update --auto-run` on the given interval", () => {
    expect(xml).toContain("<string>--auto-run</string>");
    expect(xml).toContain("<string>/app/dist/cli/index.js</string>");
    expect(xml).toContain("<integer>21600</integer>");
  });
  it("sets the working dir + log path", () => {
    expect(xml).toContain("<key>WorkingDirectory</key>");
    expect(xml).toContain("<string>/app</string>");
    expect(xml).toContain("/app/.totem-autoupdate.log");
  });
});

describe("cronLine", () => {
  const line = cronLine(["/usr/local/bin/node", "/app/dist/cli/index.js", "update", "--auto-run"], "/app", "/app/.totem-autoupdate.log");
  it("is a 6h cron entry tagged so we can find + remove it", () => {
    expect(line).toContain("0 */6 * * *");
    expect(line).toContain("# com.totem.autoupdate");
    expect(line).toContain("update --auto-run");
    expect(line).toContain("cd /app");
  });
});
