// Syntax colouring for the few snippets the Connect page shows: one-line shell
// commands, a small JSON entry and the server address. Not a general
// highlighter: it reproduces what Shiki's shellscript and json grammars give
// these snippets under the Pierre themes (@pierre/theme 2.1.0, checked by
// running Shiki over them on 2026-11-22), so the page needs no dependency.
//
//   shell: the command (first word, and the first after && || | ;) is a function,
//          a word starting with "-" is an option (constant), anything else is an
//          argument (string), and the operators are punctuation.
//   json:  a key is a property name, a value string is a string, the rest is
//          punctuation.
//   URLs (the server address, and any argument or JSON value that is one) are
//   left uncoloured on purpose, so the address reads as plain text everywhere.
//
// Output is escaped HTML with one class per token (t-cmd, t-flag, t-str, t-key,
// t-punc, and t-url, which has no colour but keeps a URL in one piece); the
// page's CSS maps each class to its Pierre Light and Pierre Dark colour (PIERRE
// below).

export type CodeLang = "shell" | "json" | "url";
type Token = "cmd" | "flag" | "str" | "key" | "punc" | "url" | null;

/** Pierre Light and Pierre Dark (@pierre/theme 2.1.0): editor colours and the token colours these snippets use. */
export const PIERRE = {
  light: { bg: "#ffffff", fg: "#0a0a0a", cmd: "#693acf", flag: "#d5a910", str: "#199f43", key: "#d5512f", punc: "#636363" },
  dark: { bg: "#0a0a0a", fg: "#fafafa", cmd: "#9d6afb", flag: "#ffd452", str: "#5ecc71", key: "#ff855e", punc: "#636363" },
} as const;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const OPERATORS = new Set(["&&", "||", "|", ";"]);
const isUrl = (s: string): boolean => /^"?https?:\/\//i.test(s);

export function shellTokens(line: string): Array<[Token, string]> {
  const out: Array<[Token, string]> = [];
  let commandNext = true;
  for (const part of line.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { out.push([null, part]); continue; }
    if (OPERATORS.has(part)) { out.push(["punc", part]); commandNext = true; continue; }
    if (commandNext) { out.push(["cmd", part]); commandNext = false; continue; }
    out.push([part.startsWith("-") ? "flag" : isUrl(part) ? "url" : "str", part]);
  }
  return out;
}

export function jsonTokens(text: string): Array<[Token, string]> {
  const out: Array<[Token, string]> = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|([{}[\],:])|(\s+)|([^\s{}[\],:"]+)/g;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        out.push(["key", m[1]]);
        const ws = m[2].slice(0, -1);
        if (ws) out.push([null, ws]);
        out.push(["punc", ":"]);
      } else out.push([isUrl(m[1]) ? "url" : "str", m[1]]);
    } else if (m[3] !== undefined) out.push(["punc", m[3]]);
    else if (m[4] !== undefined) out.push([null, m[4]]);
    else out.push([null, m[5]!]);
  }
  return out;
}

/** The snippet as escaped HTML, one span per coloured token. */
export function highlight(text: string, lang: CodeLang): string {
  const tokens = lang === "json" ? jsonTokens(text) : lang === "url" ? [["url", text] as [Token, string]] : shellTokens(text);
  return tokens.map(([t, s]) => (t ? `<span class="t-${t}">${esc(s)}</span>` : esc(s))).join("");
}
