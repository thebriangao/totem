// The CLI's screens, rendered with a fake world (screens.ts, helpers.ts).
//
//   - The key screens are snapshots: tests/cli/screens/<name>.txt is exactly
//     what a terminal shows with colour off. Review a copy change by its diff
//     there; refresh with `npx vitest run tests/cli/screens.test.ts -u`.
//   - Every screen is checked against the rules of the visual language:
//     80 columns, no colour codes when colour is off, colour that is decoration
//     only, ASCII-only when asked, and no secret on screen.
//
// TOTEM_UX_OUT=<dir> also writes every screen there as text and as a terminal
// page (HTML) for screenshots.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { PLAIN, visibleWidth, type Style } from "../../src/cli/ui.js";
import { PASSWORD, terminalPage, TOKEN } from "./helpers.js";
import { KEY_SCREENS, SCREENS, render, type Screen } from "./screens.js";

const COLOR: Style = { color: true, unicode: true, width: 80 };
const ASCII: Style = { color: false, unicode: false, width: 80 };
const NARROW: Style = { color: false, unicode: true, width: 48 };
const screen = (name: string): Screen => {
  const s = SCREENS.find((x) => x.name === name);
  if (!s) throw new Error(`no screen named ${name}`);
  return s;
};
/** Log lines (the scheduled job's file) aren't laid out for a terminal. */
const isLog = (s: Screen): boolean => s.name.startsWith("update-auto-run");

describe("key screens (colour off)", () => {
  it.each(KEY_SCREENS)("%s", async (name) => {
    const { text } = await render(screen(name));
    await expect(text).toMatchFileSnapshot(`./screens/${name}.txt`);
  });
});

describe("every screen", () => {
  it("has a unique name and says what it is", () => {
    expect(new Set(SCREENS.map((s) => s.name)).size).toBe(SCREENS.length);
    for (const s of SCREENS) expect(s.about.length).toBeGreaterThan(10);
  });

  it.each(SCREENS.map((s) => [s.name, s] as const))("%s fits 80 columns, plain, with nothing secret on it", async (_name, s) => {
    const { text } = await render(s);
    expect(text).not.toMatch(/\x1b/); // no escape codes when colour is off
    expect(text.trim().length).toBeGreaterThan(0);
    if (!isLog(s)) {
      const wide = text.split("\n").filter((line) => visibleWidth(line) > 80);
      expect(wide).toEqual([]);
    }
    // The server's token is never shown; the password only on the one screen that hands it over.
    expect(text).not.toContain(TOKEN);
    if (!s.name.startsWith("cloud-")) expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("eyJ-refresh-token"); // nothing typed is echoed
  });

  it.each(SCREENS.map((s) => [s.name, s] as const))("%s: colour only decorates", async (_name, s) => {
    const plain = (await render(s)).text;
    const coloured = (await render(s, COLOR)).text;
    // Only bold, dim, four colours and their resets.
    for (const code of coloured.match(/\x1b\[[^m]*m/g) ?? []) expect(code).toMatch(/^\x1b\[(1|2|22|31|32|33|36|39)m$/);
    expect(stripVTControlCharacters(coloured)).toBe(plain);
  });

  it.each(SCREENS.map((s) => [s.name, s] as const))("%s: is pure ASCII when the terminal can't show Unicode", async (_name, s) => {
    const { text } = await render(s, ASCII);
    // What the fake hosts print (Railway's emoji) passes through; totem's own text must be ASCII.
    const own = text.split("\n").filter((line) => !/railway\.app|Machine .* good state/.test(line));
    expect(own.filter((line) => /[^\x00-\x7F]/.test(line))).toEqual([]);
  });
});

describe("narrow terminals", () => {
  it.each(["help", "local", "cloud-fly", "auth-fail-browser-closed", "status-server"])("%s wraps prose to the width", async (name) => {
    const { text } = await render(screen(name), NARROW);
    // A line may only overflow when it can't be broken: one long word (a URL,
    // a path), a menu row, or something to paste.
    const overflow = text.split("\n").filter((line) => visibleWidth(line) > NARROW.width);
    for (const line of overflow) {
      const breakable = line.trim().split(/\s+/).length > 3 && !/^\s{4,}\S/.test(line) && !/^\s*[›>]?\s+\S.*\s{2,}/.test(line);
      expect(breakable ? line : "").toBe("");
    }
  });
});

describe("exit codes", () => {
  it.each([
    ["help", 0], ["local", 0], ["cloud-fly", 0], ["auth-server", 0], ["status-server", 0], ["update-check-available", 0],
    ["error-unknown-command", 2], ["error-not-set-up", 1], ["local-login-failed", 1], ["cloud-fly-deploy-failed", 1],
    ["cloud-cancelled", 1], ["cloud-server-not-answering", 1], ["auth-fail-browser-closed", 1], ["auth-fail-rejected", 1],
    ["status-server-down", 1], ["ping-down", 1], ["update-failed-step", 1], ["error-token-on-terminal", 1],
  ] as const)("%s exits %i", async (name, code) => {
    expect((await render(screen(name))).code).toBe(code);
  });
});

// Review renders: every screen as text and as a terminal page, for screenshots.
describe.runIf(process.env.TOTEM_UX_OUT)("review renders", () => {
  it("writes every screen", async () => {
    const dir = process.env.TOTEM_UX_OUT!;
    mkdirSync(join(dir, "html"), { recursive: true });
    const index: string[] = [];
    for (const s of SCREENS) {
      const plain = await render(s, PLAIN);
      const coloured = await render(s, COLOR);
      const prompt = `\x1b[2m$ ${s.command}\x1b[22m\n`;
      writeFileSync(join(dir, `${s.name}.txt`), `$ ${s.command}\n${plain.text}\n[exit ${plain.code}]\n`);
      if (plain.commands.length) writeFileSync(join(dir, `${s.name}.cmds.txt`), plain.commands.join("\n").split(TOKEN).join("<MCP_AUTH_TOKEN>").split(PASSWORD).join("<password>") + "\n");
      writeFileSync(join(dir, "html", `${s.name}.html`), terminalPage(s.command, prompt + coloured.text));
      index.push(`${s.name}\t${s.command}\t${plain.code}\t${s.about}`);
    }
    // One narrow and one ASCII render, to see the fallbacks.
    for (const [suffix, style] of [["narrow-48", { ...COLOR, width: 48 }], ["ascii", { color: false, unicode: false, width: 80 }]] as const) {
      for (const name of ["help", "local", "cloud-fly"]) {
        const s = screen(name);
        const r = await render(s, style);
        writeFileSync(join(dir, `${name}.${suffix}.txt`), `$ ${s.command}\n${stripVTControlCharacters(r.text)}\n[exit ${r.code}]\n`);
        writeFileSync(join(dir, "html", `${name}.${suffix}.html`), terminalPage(`${s.command}  (${suffix})`, `\x1b[2m$ ${s.command}\x1b[22m\n` + r.text, style.width));
      }
    }
    writeFileSync(join(dir, "screens.tsv"), index.join("\n") + "\n");
  }, 120_000);
});
