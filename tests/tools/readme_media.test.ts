// The README's hero (docs/media/totem-local-{light,dark}.svg) is drawn from the
// CLI's real output. When the CLI's look or wording changes, regenerate both:
//   npx tsx scripts/readme-media.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { heroPath, heroSvg, THEMES } from "../../scripts/readme-media.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const READMES = ["README.md", ...readdirSync(join(ROOT, "docs/i18n")).filter((f) => /^README\..+\.md$/.test(f)).map((f) => `docs/i18n/${f}`)];
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
// GitHub's heading anchor: lower-case, punctuation dropped, spaces to hyphens.
const slug = (heading: string): string => heading.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "").replace(/ /g, "-");
// Everything in backticks outside the code blocks: commands, flags, file paths.
const commands = (md: string): string[] => (md.replace(/```[\s\S]*?```/g, "").match(/`[^`]+`/g) ?? []).sort();

describe("the README and its translations", () => {
  it.each(READMES)("%s: every link, image and anchor leads somewhere", (file) => {
    const md = read(file);
    const anchors = new Set([...md.matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1]!)));
    const targets = [...md.matchAll(/\]\(([^)\s]+)\)|(?:href|src|srcset)="([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
    const broken = targets.filter((t) => !/^https?:/.test(t))
      .filter((t) => (t.startsWith("#") ? !anchors.has(t.slice(1)) : !existsSync(join(ROOT, dirname(file), t.split("#")[0]!))));
    expect(broken).toEqual([]);
  });

  it("each translation names the same commands, flags and files as the English one", () => {
    const english = commands(read("README.md"));
    for (const file of READMES.slice(1)) expect(commands(read(file)), file).toEqual(english);
  });
});

describe("the README's hero", () => {
  it.each(THEMES)("%s: is the current `totem local` screen", async (theme) => {
    const svg = await heroSvg(theme);
    expect(svg).toBe(readFileSync(heroPath(theme), "utf8"));
    // What the picture promises a reader: the logo, the three steps and the apps.
    for (const text of ["[1/3]", "[3/3]", "Added the whoop server to Claude Code", "How did I sleep last night?"]) expect(svg).toContain(text);
    expect(svg).toMatch(/<rect class="p"/); // the logo's pixels
  });

  it("is a light window in the light picture and a dark one in the dark picture", async () => {
    // The window's fill, read as luminance: a light page never gets a dark terminal.
    const fill = (svg: string): number => {
      const hex = svg.match(/<rect x="0\.5" y="0\.5"[^>]* fill="#([0-9a-f]{6})"/)![1]!;
      return [0, 2, 4].reduce((sum, i, k) => sum + parseInt(hex.slice(i, i + 2), 16) * [0.2126, 0.7152, 0.0722][k]!, 0) / 255;
    };
    expect(fill(await heroSvg("light"))).toBeGreaterThan(0.9);
    expect(fill(await heroSvg("dark"))).toBeLessThan(0.1);
  });

  it.each(THEMES)("%s: shows the finished screen to a viewer that doesn't animate", async (theme) => {
    const svg = await heroSvg(theme);
    // Rows are only ever hidden by the animation, never by default.
    expect(svg).not.toMatch(/<g[^>]*(opacity="0"|style="[^"]*opacity:\s*0)/);
    expect(svg).toContain("prefers-reduced-motion");
  });
});

describe("the README's pictures", () => {
  it.each(READMES)("%s: every picture has a light and a dark version", (file) => {
    // A <picture> with a dark <source> and a light <img>, never a lone image of one theme.
    const md = read(file);
    const media = [...md.matchAll(/<img\b[^>]*src="([^"]*\/media\/[^"]+)"/g)].map((m) => m[1]!);
    expect(media.length).toBeGreaterThan(0);
    for (const light of media) {
      expect(light, file).toMatch(/-light\.(svg|png)$/);
      expect(md, file).toContain(`<source media="(prefers-color-scheme: dark)" srcset="${light.replace("-light.", "-dark.")}">`);
    }
  });
});
