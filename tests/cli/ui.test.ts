// The visual language's primitives (src/cli/ui.ts): when colour and Unicode are
// used, and that each primitive lays out within the width it is given.
import { describe, expect, it } from "vitest";
import {
  detectStyle, duration, glyphs, kit, listOf, maskSecrets, padEnd, shellLines, truncate, Ui, visibleWidth, when, wrap, wrapHanging,
  type Style,
} from "../../src/cli/ui.js";

const tty = { isTTY: true, columns: 120 };
const pipe = { isTTY: false };
const utf8 = { LANG: "en_US.UTF-8" };
const style = (over: Partial<Style> = {}): Style => ({ color: false, unicode: true, width: 80, ...over });

describe("detectStyle: colour", () => {
  it("is on for a terminal and off for a pipe, a file or CI", () => {
    expect(detectStyle(tty, utf8, "darwin").color).toBe(true);
    expect(detectStyle(pipe, utf8, "darwin").color).toBe(false);
    expect(detectStyle({}, { ...utf8, CI: "true" }, "linux").color).toBe(false);
  });
  it("NO_COLOR turns it off, whatever its value; an empty one doesn't count", () => {
    expect(detectStyle(tty, { ...utf8, NO_COLOR: "1" }, "darwin").color).toBe(false);
    expect(detectStyle(tty, { ...utf8, NO_COLOR: "0" }, "darwin").color).toBe(false);
    expect(detectStyle(tty, { ...utf8, NO_COLOR: "" }, "darwin").color).toBe(true);
  });
  it("TERM=dumb turns it off", () => {
    expect(detectStyle(tty, { ...utf8, TERM: "dumb" }, "linux").color).toBe(false);
  });
  it("FORCE_COLOR turns it on without a terminal, but NO_COLOR wins", () => {
    expect(detectStyle(pipe, { ...utf8, FORCE_COLOR: "1" }, "linux").color).toBe(true);
    expect(detectStyle(pipe, { ...utf8, FORCE_COLOR: "0" }, "linux").color).toBe(false);
    expect(detectStyle(tty, { ...utf8, FORCE_COLOR: "1", NO_COLOR: "1" }, "linux").color).toBe(false);
  });
});

describe("detectStyle: glyphs", () => {
  it("uses Unicode on a UTF-8 terminal, ASCII on one that can't be trusted", () => {
    expect(detectStyle(tty, utf8, "darwin").unicode).toBe(true);
    expect(detectStyle(tty, {}, "linux").unicode).toBe(true); // no locale set: files and modern terminals are UTF-8
    expect(detectStyle(tty, { LANG: "C" }, "linux").unicode).toBe(false);
    expect(detectStyle(tty, { LANG: "en_US.ISO-8859-1" }, "linux").unicode).toBe(false);
    expect(detectStyle(tty, { LC_ALL: "POSIX", LANG: "en_US.UTF-8" }, "linux").unicode).toBe(false);
    expect(detectStyle(tty, { ...utf8, TERM: "dumb" }, "linux").unicode).toBe(false);
    expect(detectStyle(tty, { ...utf8, TERM: "linux" }, "linux").unicode).toBe(false); // the kernel console
    expect(detectStyle(tty, { ...utf8, TOTEM_ASCII: "1" }, "darwin").unicode).toBe(false);
  });
  it("on Windows, only in a terminal known to render it", () => {
    expect(detectStyle(tty, {}, "win32").unicode).toBe(false); // the legacy console
    expect(detectStyle(tty, { WT_SESSION: "abc" }, "win32").unicode).toBe(true);
    expect(detectStyle(tty, { TERM_PROGRAM: "vscode" }, "win32").unicode).toBe(true);
    expect(detectStyle(tty, { TERM: "xterm-256color" }, "win32").unicode).toBe(true); // Git Bash, WSL
  });
  it("every Unicode glyph has an ASCII stand-in of the same shape", () => {
    const u = glyphs(style());
    const a = glyphs(style({ unicode: false }));
    for (const key of ["ok", "fail", "warn", "info", "pointer", "ask", "h", "v", "tl", "tr", "bl", "br"] as const) {
      expect(a[key], key).toMatch(/^[\x21-\x7e]$/);
      expect(visibleWidth(u[key]), key).toBe(1);
    }
    expect(a.spinner.every((f) => /^[\x21-\x7e]$/.test(f))).toBe(true);
    expect(a.ellipsis).toBe("...");
  });
});

describe("detectStyle: width", () => {
  it("follows the terminal between 40 and 80 columns, and assumes 80 without one", () => {
    expect(detectStyle({ isTTY: true, columns: 200 }, utf8, "darwin").width).toBe(80);
    expect(detectStyle({ isTTY: true, columns: 64 }, utf8, "darwin").width).toBe(64);
    expect(detectStyle({ isTTY: true, columns: 20 }, utf8, "darwin").width).toBe(40);
    expect(detectStyle(pipe, utf8, "darwin").width).toBe(80);
  });
});

describe("text helpers", () => {
  it("wrap breaks between words and never inside one", () => {
    const text = "Add the connector at https://totem-c0ffee2-abcdefghij-uw.a.run.app/mcp then ask it something";
    const lines = wrap(text, 30);
    expect(lines.join(" ")).toBe(text);
    expect(lines).toContain("https://totem-c0ffee2-abcdefghij-uw.a.run.app/mcp"); // whole, on its own line
    for (const l of lines) if (!l.includes("https://")) expect(l.length).toBeLessThanOrEqual(30);
  });
  it("wrap measures what is seen, not the colour codes", () => {
    expect(wrap("\x1b[1maaaa\x1b[22m bbbb cccc", 9)).toEqual(["\x1b[1maaaa\x1b[22m bbbb", "cccc"]);
    expect(visibleWidth("\x1b[36mtotem\x1b[39m")).toBe(5);
    expect(padEnd("\x1b[2mab\x1b[22m", 5)).toBe("\x1b[2mab\x1b[22m   ");
  });
  it("wrapHanging keeps a list marker hanging", () => {
    expect(wrapHanging("1. Add the connector in claude.ai (its settings are opening).", 30)).toEqual([
      "1. Add the connector in", "   claude.ai (its settings are", "   opening).",
    ]);
    expect(wrapHanging("No marker here at all, just words to wrap", 20)).toEqual(["No marker here at", "all, just words to", "wrap"]);
  });
  it("shellLines splits a long command so it still pastes as one", () => {
    const words = ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "whoop", "https://totem-c0ffee2-abcdefghij-uw.a.run.app/mcp"];
    const lines = shellLines(words, 60, "darwin");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
    for (const l of lines.slice(0, -1)) expect(l.endsWith(" \\")).toBe(true);
    expect(lines.at(-1)!.endsWith("\\")).toBe(false);
    // What a shell reads back is the original command.
    expect(lines.join("\n").replace(/ \\\n\s*/g, " ")).toBe(words.join(" "));
    expect(shellLines(["totem", "cloud"], 60, "darwin")).toEqual(["totem cloud"]);
    // cmd and PowerShell have no shared continuation character.
    expect(shellLines(words, 60, "win32")).toEqual([words.join(" ")]);
  });
  it("formats durations, times and lists", () => {
    expect([duration(400), duration(4_000), duration(102_000), duration(187_000)]).toEqual(["", "4s", "1m 42s", "3m 07s"]);
    expect(when("2026-11-21T22:10:00.000Z")).toBe("2026-11-21 22:10 UTC");
    expect(when(undefined)).toBe("unknown");
    expect(when("not a date")).toBe("not a date");
    expect([listOf(["a"]), listOf(["a", "b"]), listOf(["a", "b", "c"])]).toEqual(["a", "a and b", "a, b and c"]);
    expect(truncate("abcdefghij", 6)).toBe("abcde…");
    expect(truncate("abc", 6)).toBe("abc");
  });
  it("masks the value of anything named like a secret", () => {
    expect(maskSecrets(["variables", "--set", "MCP_AUTH_TOKEN=abc123", "AUTH_PASSWORD=hunter2", "PUBLIC_URL=https://x", "--env=prod"]))
      .toBe("variables --set MCP_AUTH_TOKEN=*** AUTH_PASSWORD=*** PUBLIC_URL=https://x --env=prod");
  });
});

describe("primitives", () => {
  const widths = [80, 60, 40];

  it.each(widths)("the next box is a closed rectangle within %i columns", (width) => {
    for (const unicode of [true, false]) {
      const k = kit(style({ width, unicode }));
      const box = k.next(["1. Add the connector in claude.ai (its settings are opening in your browser).", '2. Ask it: "How did I sleep last night?"', "", "See this again: totem connect"]).slice(1);
      const w = visibleWidth(box[0]!);
      expect(w).toBeLessThanOrEqual(width);
      for (const line of box) expect(visibleWidth(line)).toBe(w);
      const g = k.g;
      expect(box[0]!.startsWith(`${g.tl}${g.h} Next `) && box[0]!.endsWith(g.tr)).toBe(true);
      expect(box.at(-1)).toBe(`${g.bl}${g.h.repeat(w - 2)}${g.br}`);
      for (const line of box.slice(1, -1)) expect(line.startsWith(`${g.v} `) && line.endsWith(` ${g.v}`)).toBe(true);
    }
  });

  it("the next box fits its content instead of filling the line", () => {
    const box = kit(style()).next(["Restart your client."]).slice(1);
    expect(box).toEqual(["╭─ Next ───────────────╮", "│ Restart your client. │", "╰──────────────────────╯"]);
  });

  it("rows align their values, and wrap long ones under themselves", () => {
    expect(kit(style({ width: 40 })).rows([["Host", "Fly.io"], ["Volume", "totem_data, 1 GB: keeps the WHOOP login across restarts"]])).toEqual([
      "  Host     Fly.io",
      "  Volume   totem_data, 1 GB: keeps the",
      "           WHOOP login across restarts",
    ]);
  });

  it("a mark's detail rides on the line when it fits, else goes below", () => {
    const k = kit(style({ width: 40 }));
    expect(k.mark("ok", "Deployed", "1m 42s")).toEqual(["  ✓ Deployed  1m 42s"]);
    expect(k.mark("ok", "Added the whoop server to Cursor", "~/.cursor/mcp.json")).toEqual(["  ✓ Added the whoop server to Cursor", "    ~/.cursor/mcp.json"]);
    expect(k.mark("fail", "x")[0]).toBe("  ✗ x");
    expect(kit(style({ unicode: false })).mark("ok", "Deployed")).toEqual(["  + Deployed"]);
  });

  it("a problem says what went wrong, then lines up the commands that fix it", () => {
    expect(kit(style()).problem("The browser window was closed before the login finished.", { fix: [["Try again", "totem auth"], ["No browser on this machine", "totem auth --paste"]] })).toEqual([
      "✗ The browser window was closed before the login finished.",
      "  Try again                    totem auth",
      "  No browser on this machine   totem auth --paste",
    ]);
  });

  it("a problem shows a command's output line by line, continuing long lines indented", () => {
    const lines = kit(style({ width: 40 })).problem("Deploying failed.", { detail: ["==> Building image", "Error: failed to fetch an image or build from source"] }, 2);
    expect(lines).toEqual([
      "  ✗ Deploying failed.",
      "    ==> Building image",
      "    Error: failed to fetch an image or",
      "      build from source",
    ]);
  });

  it("something to paste stands alone: indentation only, no border or prefix", () => {
    expect(kit(style({ color: false })).code(["totem auth --paste"])).toEqual(["    totem auth --paste"]);
    expect(kit(style({ color: true })).code(["totem auth"])[0]).toBe("    \x1b[36mtotem auth\x1b[39m");
  });

  it("step shows where you are", () => {
    const [blank, line] = kit(style()).step(2, 6, "Secrets");
    expect(blank).toBe("");
    // A full-width rule: where you are, then the step's name.
    expect(line).toBe(`── 2/6  Secrets ${"─".repeat(64)}`);
    expect([...line!].length).toBe(80);
  });
});

describe("Ui", () => {
  const capture = (over: { live?: boolean } = {}): { ui: Ui; out: string[] } => {
    const out: string[] = [];
    return { ui: new Ui({ style: style(), write: (t) => { out.push(t); }, writeErr: (t) => { out.push(`ERR:${t}`); }, live: over.live ?? false, canAsk: false }), out };
  };

  it("never writes two blank lines in a row", () => {
    const { ui, out } = capture();
    ui.header("totem local", "Run totem on this computer.");
    ui.step(1, 3, "Prerequisites");
    ui.ok("Node.js 24.3.0");
    ui.line();
    ui.line();
    ui.next(["Done."]);
    expect(out.join("")).not.toMatch(/\n\n\n/);
    expect(out.join("")).toContain("▍ totem local\n▍ Run totem on this computer.\n\n── 1/3  Prerequisites ");
    expect(out.join("")).toContain("\n  ✓ Node.js 24.3.0\n\n╭─ Next");
  });

  it("without a terminal, slow work gets one plain line and fast work none", async () => {
    const { ui, out } = capture();
    expect(await ui.task("Checking who is signed in", async () => 1)).toBe(1);
    expect(out).toEqual([]);
    await ui.task("Building and deploying on Fly", async () => undefined, { slow: true });
    expect(out.join("")).toBe("  • Building and deploying on Fly…\n");
    expect(out.join("")).not.toMatch(/\x1b|\r/); // no cursor movement into a log
  });

  it("a problem that ends the command goes to stderr", () => {
    const { ui, out } = capture();
    ui.error("totem isn't set up yet.", { fix: [["Run on this computer", "totem local"]] });
    expect(out).toEqual(["ERR:✗ totem isn't set up yet.\n", "ERR:  Run on this computer   totem local\n"]);
  });
});
