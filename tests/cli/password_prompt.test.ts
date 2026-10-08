import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptHidden } from "../../src/cli/ui.js";

function terminal(isTTY = true, initiallyRaw = false) {
  const input = Object.assign(new PassThrough(), {
    isTTY,
    isRaw: initiallyRaw,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; },
  });
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as typeof process.stdin);
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  return { input, output };
}

afterEach(() => vi.restoreAllMocks());

describe("hidden password prompt", () => {
  it.each([
    ["symbols", ["Dummy#Value!\r"], "Dummy#Value!"],
    ["edge whitespace", [" DummyValue! \r"], " DummyValue! "],
    ["bracketed paste", ["\x1b[200~DummyValue!\x1b[201~\r"], "DummyValue!"],
    ["split paste markers", ["\x1b[20", "0~DummyValue!\x1b[", "201~\r"], "DummyValue!"],
    ["Ctrl-U", ["mistake\x15DummyValue!\r"], "DummyValue!"],
    ["backspace", ["DummyValue?\x7f!\r"], "DummyValue!"],
    ["cursor editing", ["DummyValue?\x1b[D\x1b[3~!\r"], "DummyValue!"],
  ])("preserves the intended password with %s", async (_label, chunks, expected) => {
    const { input, output } = terminal();
    const result = promptHidden("Password");
    for (const chunk of chunks) input.write(chunk);
    expect(await result).toBe(expected);
    // All editing/redraw output must stay off stdout, not just the secret.
    expect(stripVTControlCharacters(output.join(""))).toBe("? Password › \n");
    expect(input.isRaw).toBe(false);
    input.destroy();
  });

  it("preserves whitespace with piped input", async () => {
    const { input, output } = terminal(false);
    const result = promptHidden("Password");
    input.write(" DummyValue! \n");
    expect(await result).toBe(" DummyValue! ");
    expect(output.join("")).not.toContain("DummyValue");
    input.destroy();
  });

  it("resolves on EOF and restores an existing raw-mode setting", async () => {
    const { input } = terminal(true, true);
    const result = promptHidden("Password");
    input.end();
    expect(await result).toBe("");
    expect(input.isRaw).toBe(true);
  });

  it("can read another prompt after closing the first", async () => {
    const { input } = terminal();
    for (const value of ["FirstDummy!", "SecondDummy!"]) {
      const result = promptHidden("Password");
      input.write(`${value}\r`);
      expect(await result).toBe(value);
    }
    input.destroy();
  });
});
