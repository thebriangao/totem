// TOOLS.md is written from the tool registry (scripts/tools-md.ts). When a
// tool changes, regenerate it: npx tsx scripts/tools-md.ts > TOOLS.md
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toolsMarkdown } from "../../scripts/tools-md.js";

describe("TOOLS.md", () => {
  it("matches the tool registry", async () => {
    expect(readFileSync(resolve("TOOLS.md"), "utf8")).toBe(await toolsMarkdown());
  });
});
