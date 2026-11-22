// The visual language's primitives (src/cli/ui.ts): when colour and Unicode are
// used, and that each primitive lays out within the width it is given.
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { logoPixels } from "../../src/cli/logo.js";
import {
  brandSgr, detectStyle, duration, glyphs, kit, listOf, maskSecrets, onDark, onLight, padEnd, paint, PALETTE, roleSgr, shellLines, truncate, Ui,
  visibleWidth, when, wrap, wrapHanging, xterm256, type Role, type Style,
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

describe("detectStyle: the brand colour", () => {
  it("draws ice #B7D3F2 exactly on a 24-bit terminal, the nearest of 256 otherwise, bright blue on a basic one", () => {
    const truecolor = detectStyle(tty, { ...utf8, COLORTERM: "truecolor" }, "darwin");
    expect(truecolor.palette).toBe("truecolor");
    expect(brandSgr(truecolor)).toBe("38;2;183;211;242");
    expect(detectStyle(tty, { ...utf8, TERM_PROGRAM: "iTerm.app" }, "darwin").palette).toBe("truecolor");
    expect(detectStyle(tty, { ...utf8, WT_SESSION: "x" }, "win32").palette).toBe("truecolor");
    const apple = detectStyle(tty, { ...utf8, TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, "darwin");
    expect(apple.palette).toBe("256");
    expect(brandSgr(apple)).toBe("38;5;153");
    const basic = detectStyle(tty, { ...utf8, TERM: "xterm" }, "linux");
    expect(basic.palette).toBe("basic");
    expect(brandSgr(basic)).toBe("94");
    expect(brandSgr(style())).toBe("94"); // a Style without a palette is basic
  });
  it("takes the logo's darker fold shade when the terminal says its background is light", () => {
    const light = detectStyle(tty, { ...utf8, COLORTERM: "truecolor", COLORFGBG: "0;15" }, "darwin");
    expect(light.light).toBe(true);
    expect(brandSgr(light)).toBe("38;2;122;156;198");
    expect(brandSgr({ ...light, palette: "256" })).toBe("38;5;110");
    expect(detectStyle(tty, { ...utf8, COLORFGBG: "15;default;0" }, "darwin").light).toBe(false);
  });
  it("draws the brand word and the logo in ice, and what needs you in the palette", () => {
    const st = style({ color: true, palette: "truecolor" });
    const p = paint(st);
    const fg = (role: Role): string => `\x1b[${roleSgr(st, role)}m`;
    const rgb = (hex: string): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
    expect(roleSgr(st, "lead")).toBe(`38;2;${rgb(PALETTE.lead)}`); // already readable on a dark terminal: as given
    expect(p.ask("?")).toBe(`${fg("lead")}?\x1b[39m`); // questions and choices
    expect(p.accent("totem logs")).toBe(`${fg("command")}totem logs\x1b[39m`); // commands
    expect(p.link("https://x.example/mcp")).toBe(`${fg("link")}https://x.example/mcp\x1b[39m`); // addresses
    expect(p.secret("pw")).toBe(`\x1b[1;${roleSgr(st, "secret")}mpw\x1b[39;22m`); // the one-time password, bold
    expect([p.green("✓"), p.yellow("!"), p.red("✗")]).toEqual([`${fg("ok")}✓\x1b[39m`, `${fg("warn")}!\x1b[39m`, `${fg("fail")}✗\x1b[39m`]);
    expect(brandSgr(style({ palette: "256" }), "fold")).toBe("38;5;110");
    expect(brandSgr(style({ palette: "truecolor" }), "ice", true)).toBe("48;2;183;211;242");
    const k = kit(st);
    expect(k.header("totem cloud")[0]).toBe("\x1b[1m\x1b[38;2;183;211;242mtotem\x1b[39m cloud\x1b[22m"); // the brand word in ice
    expect(k.answered("Host?", "Fly.io")).toBe(`${fg("lead")}?\x1b[39m \x1b[1mHost?\x1b[22m ${fg("lead")}Fly.io\x1b[39m`);
    // Addresses take the link colour in details, rows and the Next block; the rest keeps its style.
    expect(k.mark("ok", "Login sent", "https://x.example")[0]).toContain(`\x1b[2m(\x1b[22m${fg("link")}https://x.example\x1b[39m\x1b[2m)\x1b[22m`);
    expect(k.rows([["Address", "https://x.example/mcp"]])[0]).toContain(`${fg("link")}https://x.example/mcp\x1b[39m`);
    expect(k.next(["Every app: https://x.example/connect"]).join("\n")).toContain(`Every app: ${fg("link")}https://x.example/connect\x1b[39m`);
    expect(k.rows([["URL", p.link("https://y.example")]])[0]).toContain(`${fg("link")}https://y.example\x1b[39m`); // already coloured: untouched
  });

  it("brings each colour to 4.5:1: darker on white, lighter on a dark terminal", () => {
    const lum = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const dark = lum([30, 30, 30]);
    for (const hex of Object.values(PALETTE)) {
      const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      const light = onLight(rgb), lifted = onDark(rgb);
      for (const out of [light, lifted]) expect(out.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), hex).toBe(true);
      expect(1.05 / (lum(light) + 0.05), hex).toBeGreaterThanOrEqual(4.5);
      expect((lum(lifted) + 0.05) / (dark + 0.05), hex).toBeGreaterThanOrEqual(4.5);
    }
    // A colour that already reads is left as it is; a dark one comes up, keeping its hue.
    expect(onDark([113, 201, 250])).toEqual([113, 201, 250]);
    const indigo = onDark([102, 16, 242]);
    expect(indigo[2]).toBeGreaterThan(indigo[0]);
    expect(lum(indigo)).toBeGreaterThan(lum([102, 16, 242]));
    expect(roleSgr(style({ palette: "truecolor", light: true }), "lead")).not.toBe(roleSgr(style({ palette: "truecolor" }), "lead"));
  });

  it("finds the nearest of 256 colours on a terminal without 24-bit colour, and the basic one nearest in meaning below that", () => {
    expect(xterm256([255, 0, 0])).toBe(196);
    expect(xterm256([128, 128, 128])).toBe(244);
    expect(roleSgr(style({ palette: "256" }), "lead")).toMatch(/^38;5;\d+$/);
    expect(roleSgr(style(), "fail")).toBe("31");
    expect(roleSgr(style(), "lead")).toBe("36");
  });

  it("are off without colour", () => {
    const p = paint(style({ color: true, palette: "truecolor" }));
    expect(p.brand("totem")).toBe("\x1b[38;2;183;211;242mtotem\x1b[39m");
    expect(paint(style({ color: true })).accent("x")).toBe("\x1b[37mx\x1b[39m"); // basic terminal: its white
    expect(paint(style({ palette: "truecolor" })).brand("totem")).toBe("totem");
    expect(paint(style({ palette: "truecolor" })).accent("totem")).toBe("totem");
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
    for (const key of ["ok", "fail", "warn", "info", "pointer", "ask"] as const) {
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

  it.each(widths)("next is a bold title and its steps under it, within %i columns", (width) => {
    for (const unicode of [true, false]) {
      const k = kit(style({ width, unicode }));
      const [title, ...body] = k.next(["1. Add the connector in claude.ai (its settings are opening in your browser).", '2. Ask it: "How did I sleep last night?"', "", "See this again: totem connect"]);
      expect(title).toBe("Next");
      for (const line of body) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(line === "" || line.startsWith("  ")).toBe(true);
      }
      expect(body[0]!.startsWith("  1. Add the connector")).toBe(true);
    }
  });

  it("next keeps step numbers in the lead colour and commands in theirs, so they stand out from the prose", () => {
    const lead = "\x1b[36m", command = "\x1b[37m"; // a basic terminal's nearest
    const body = kit(style({ color: true })).next(["1. Restart your client.", "2. If ChatGPT asks you to sign in again, run: codex mcp login whoop", "Check the server: totem status"]).slice(1);
    expect(body[0]).toBe(`  ${lead}1.\x1b[39m Restart your client.`);
    expect(body.join("\n")).toContain(`run: ${command}codex mcp login whoop\x1b[39m`);
    expect(body.at(-1)).toBe(`  Check the server: ${command}totem status\x1b[39m`);
  });

  it("rows align their values after a colon, and wrap long ones under themselves", () => {
    expect(kit(style({ width: 40 })).rows([["Host", "Fly.io"], ["Volume", "totem_data, 1 GB: keeps the WHOOP login across restarts"]])).toEqual([
      "  Host:    Fly.io",
      "  Volume:  totem_data, 1 GB: keeps the",
      "           WHOOP login across restarts",
    ]);
  });

  it("a mark's detail follows it: a time in brackets, anything else in parentheses, on its own line when it doesn't fit", () => {
    const k = kit(style({ width: 40 }));
    expect(k.mark("ok", "Deployed", "1m 42s")).toEqual(["✓ Deployed [1m 42s]"]);
    expect(k.mark("ok", "Volume created", "4s")).toEqual(["✓ Volume created [4s]"]);
    expect(k.mark("ok", "Signed in to Fly", "you@example.com")).toEqual(["✓ Signed in to Fly (you@example.com)"]);
    expect(k.mark("ok", "Added the whoop server to Cursor", "~/.cursor/mcp.json")).toEqual(["✓ Added the whoop server to Cursor", "  ~/.cursor/mcp.json"]);
    expect(k.mark("fail", "x")[0]).toBe("✗ x");
    expect(kit(style({ unicode: false })).mark("ok", "Deployed")).toEqual(["+ Deployed"]);
  });

  it("a problem says what went wrong, then lines up the commands that fix it", () => {
    expect(kit(style()).problem("The browser window was closed before the login finished.", { fix: [["Try again", "totem auth"], ["No browser on this machine", "totem auth --paste"]] })).toEqual([
      "✗ The browser window was closed before the login finished.",
      "  Try again                    totem auth",
      "  No browser on this machine   totem auth --paste",
    ]);
  });

  it("a problem shows a command's output line by line, continuing long lines indented", () => {
    const lines = kit(style({ width: 40 })).problem("Deploying failed.", { detail: ["==> Building image", "Error: failed to fetch an image or build from source"] });
    expect(lines).toEqual([
      "✗ Deploying failed.",
      "  ==> Building image",
      "  Error: failed to fetch an image or",
      "    build from source",
    ]);
  });

  it("something to paste stands alone: indentation only, no border or prefix", () => {
    expect(kit(style({ color: false })).code(["totem auth --paste"])).toEqual(["  totem auth --paste"]);
    expect(kit(style({ color: true })).code(["totem auth"])[0]).toBe("  \x1b[37mtotem auth\x1b[39m");
  });

  it("step is the count in brackets and the title", () => {
    expect(kit(style()).step(2, 6, "Secrets")).toEqual(["[2/6] Secrets"]);
    expect(kit(style({ unicode: false })).step(3, 3, "Connect your apps")).toEqual(["[3/3] Connect your apps"]);
  });

  it("header is the command, then its purpose", () => {
    expect(kit(style({ width: 40 })).header("totem auth", "Log in to WHOOP. The login is saved on this computer.")).toEqual([
      "totem auth",
      "Log in to WHOOP. The login is saved on",
      "this computer.",
    ]);
  });

  it("questions are asked and answered on one line", () => {
    const k = kit(style());
    expect(k.question("Deploy this?", "(Y/n)")).toBe("? Deploy this? (Y/n)");
    expect(k.answered("Where should the server run?", "Fly.io")).toBe("? Where should the server run? Fly.io");
  });

  it("banner draws the logo beside the title where there is colour, and falls back to a header", () => {
    const coloured = kit(style({ color: true, palette: "truecolor" })).banner("totem cloud", "Deploy your own server.");
    expect(coloured).toHaveLength(5); // the logo's five rows, the text beside them
    expect(coloured[1]).toContain("\x1b[1m\x1b[38;2;183;211;242mtotem\x1b[39m cloud\x1b[22m");
    expect(coloured.every((l) => visibleWidth(l) <= 80)).toBe(true);
    expect(kit(style({ color: true, palette: "truecolor" })).logo).toBe(true);
    // No colour, ASCII, a narrow terminal or logo: false: no picture.
    for (const s of [style(), style({ color: true, unicode: false }), style({ color: true, width: 50 }), style({ color: true, logo: false })]) {
      expect(kit(s).logo).toBe(false);
      expect(stripVTControlCharacters(kit(s).banner("totem cloud", "Deploy your own server.")[0]!)).toBe("totem cloud");
    }
  });

  it("the logo is rasterized from the SVG: a hexagon, the same turned half a circle", () => {
    const px = logoPixels(12, 10);
    expect(px).toHaveLength(10);
    const turned = px.map((row) => [...row].reverse()).reverse();
    expect(turned).toEqual(px);
    expect(px[0]!.filter(Boolean).length).toBeLessThan(px[4]!.filter(Boolean).length); // pointed at the top
    expect(px.flat()).toContain("fold");
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
    expect(out.join("")).toBe(["", "totem local", "Run totem on this computer.", "", "[1/3] Prerequisites", "✓ Node.js 24.3.0", "", "Next", "  Done.", ""].join("\n"));
  });

  it("without a terminal, slow work gets one plain line and fast work none", async () => {
    const { ui, out } = capture();
    expect(await ui.task("Checking who is signed in", async () => 1)).toBe(1);
    expect(out).toEqual([]);
    await ui.task("Building and deploying on Fly", async () => undefined, { slow: true });
    expect(out.join("")).toBe("• Building and deploying on Fly…\n");
    expect(out.join("")).not.toMatch(/\x1b|\r/); // no cursor movement into a log
  });

  it("a problem that ends the command goes to stderr", () => {
    const { ui, out } = capture();
    ui.error("totem isn't set up yet.", { fix: [["Run on this computer", "totem local"]] });
    expect(out).toEqual(["ERR:✗ totem isn't set up yet.\n", "ERR:  Run on this computer   totem local\n"]);
  });
});
