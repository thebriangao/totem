// A WHOOP app screen whose shape totem has never seen filled in (a feature no
// test account has unlocked), reduced to its content: UI plumbing dropped, text
// and numbers kept, size capped. Callers label the result unverified.

/** Keys that only drive the app's UI. */
const UI_KEY =
  /(icon|image|url|color|colour|style|tint|gradient|background|font|typography|animation|lottie|corner|radius|analytics|destination|navigation|interaction|bindings|dismiss|deeplink|feature_flag|template|haptic|orientation|accessibility)/i;

const MAX_STRING = 300;
const MAX_DEPTH = 8;

function strip(node: unknown, depth: number, maxItems: number): unknown {
  if (typeof node === "string") return node.length > MAX_STRING ? `${node.slice(0, MAX_STRING)}…` : node;
  if (typeof node !== "object" || node === null) return node;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(node)) {
    const kept = node.slice(0, maxItems).map((x) => strip(x, depth + 1, maxItems)).filter((x) => x !== undefined && x !== null && x !== "");
    return kept.length ? kept : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (UI_KEY.test(k)) continue;
    const s = strip(v, depth + 1, maxItems);
    if (s === undefined || s === null || s === "") continue;
    if (typeof s === "object" && !Array.isArray(s) && Object.keys(s).length === 0) continue;
    out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The screen's content within maxChars of JSON; truncated when lists were cut to fit. */
export function screenContent(node: unknown, maxChars = 2_000): { content: unknown; truncated: boolean } {
  const full = strip(node, 0, Infinity) ?? null;
  if (JSON.stringify(full).length <= maxChars) return { content: full, truncated: false };
  for (const items of [20, 8, 3, 1]) {
    const cut = strip(node, 0, items) ?? null;
    if (JSON.stringify(cut).length <= maxChars) return { content: cut, truncated: true };
  }
  return { content: null, truncated: true };
}
