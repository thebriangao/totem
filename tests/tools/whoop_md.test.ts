// WHOOP.md is written from the endpoint catalog (scripts/whoop-md.ts). When the
// catalog changes, regenerate it: npx tsx scripts/whoop-md.ts > WHOOP.md
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { whoopMarkdown } from "../../scripts/whoop-md.js";

describe("WHOOP.md", () => {
  it("matches the endpoint catalog", () => {
    expect(readFileSync(resolve("WHOOP.md"), "utf8")).toBe(whoopMarkdown());
  });

  it("holds no account identifiers", () => {
    const text = whoopMarkdown();
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|net|org)\b/i);
    expect(text).not.toMatch(/\buser_id[ =:]\s*\d{6,}/i);
  });
});
