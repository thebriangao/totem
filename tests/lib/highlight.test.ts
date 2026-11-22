// The Connect page's highlighter against what Shiki's shellscript and json
// grammars give the same snippets under the Pierre themes (run on 2026-11-22
// with shiki 3 and @pierre/theme 2.1.0), except URLs, which stay uncoloured.
import { describe, expect, it } from "vitest";
import { highlight, jsonTokens, PIERRE, shellTokens } from "../../src/lib/highlight.js";

const URL = "https://totem-c0ffee.fly.dev/mcp";
const words = (tokens: Array<[string | null, string]>) => tokens.filter(([t]) => t !== null);

describe("shellTokens", () => {
  it("matches Shiki: the command, then options and arguments", () => {
    expect(words(shellTokens(`claude mcp add --transport http --scope user whoop ${URL}`))).toEqual([
      ["cmd", "claude"], ["str", "mcp"], ["str", "add"], ["flag", "--transport"], ["str", "http"], ["flag", "--scope"], ["str", "user"], ["str", "whoop"], ["url", URL],
    ]);
    expect(words(shellTokens(`codex mcp add whoop --url ${URL}`))).toEqual([
      ["cmd", "codex"], ["str", "mcp"], ["str", "add"], ["str", "whoop"], ["flag", "--url"], ["url", URL],
    ]);
  });

  it("starts a new command after an operator", () => {
    expect(words(shellTokens(`cd ~/.config/opencode && opencode mcp add whoop --url ${URL}`))).toEqual([
      ["cmd", "cd"], ["str", "~/.config/opencode"], ["punc", "&&"], ["cmd", "opencode"], ["str", "mcp"], ["str", "add"], ["str", "whoop"], ["flag", "--url"], ["url", URL],
    ]);
  });

  it("keeps the text exactly", () => {
    const line = `cd ~/x  &&  opencode   mcp add whoop --url ${URL}`;
    expect(shellTokens(line).map(([, s]) => s).join("")).toBe(line);
  });
});

describe("jsonTokens", () => {
  it("matches Shiki: keys, string values and punctuation", () => {
    const entry = JSON.stringify({ mcpServers: { whoop: { serverUrl: URL } } }, null, 2);
    expect(jsonTokens(entry).map(([, s]) => s).join("")).toBe(entry);
    expect(words(jsonTokens(entry))).toEqual([
      ["punc", "{"], ["key", '"mcpServers"'], ["punc", ":"], ["punc", "{"], ["key", '"whoop"'], ["punc", ":"], ["punc", "{"],
      ["key", '"serverUrl"'], ["punc", ":"], ["url", `"${URL}"`], ["punc", "}"], ["punc", "}"], ["punc", "}"],
    ]);
  });
});

describe("highlight", () => {
  it("escapes what it colours", () => {
    expect(highlight('x "<b>" --y=\'&\'', "shell")).toBe('<span class="t-cmd">x</span> <span class="t-str">&quot;&lt;b&gt;&quot;</span> <span class="t-flag">--y=&#39;&amp;&#39;</span>');
    // URLs stay uncoloured (t-url has no colour; it only keeps them in one piece).
    expect(highlight("https://a.example/mcp?x=<1>", "url")).toBe('<span class="t-url">https://a.example/mcp?x=&lt;1&gt;</span>');
  });

  it("uses the Pierre theme colours", () => {
    expect(PIERRE.light).toEqual({ bg: "#ffffff", fg: "#0a0a0a", cmd: "#693acf", flag: "#d5a910", str: "#199f43", key: "#d5512f", punc: "#636363" });
    expect(PIERRE.dark).toEqual({ bg: "#0a0a0a", fg: "#fafafa", cmd: "#9d6afb", flag: "#ffd452", str: "#5ecc71", key: "#ff855e", punc: "#636363" });
  });
});
