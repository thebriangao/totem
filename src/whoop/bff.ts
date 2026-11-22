// Helpers for WHOOP's server-driven screens ("BFF" responses): deeply nested
// `sections[] / items[] / content` trees whose values are display strings.
// Key off stable ids and types, never array positions.

export type Node = Record<string, unknown>;

const isObj = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/** Depth-first walk over every object node in a JSON tree. */
export function* walk(root: unknown): Generator<Node> {
  const stack: unknown[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
    } else if (isObj(cur)) {
      yield cur;
      const vals = Object.values(cur);
      for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
    }
  }
}

export function findAll(root: unknown, pred: (n: Node) => boolean): Node[] {
  const out: Node[] = [];
  for (const n of walk(root)) if (pred(n)) out.push(n);
  return out;
}
export function findFirst(root: unknown, pred: (n: Node) => boolean): Node | undefined {
  for (const n of walk(root)) if (pred(n)) return n;
  return undefined;
}
/** Nodes whose `type` equals one of the given values. */
export function byType(root: unknown, ...types: string[]): Node[] {
  return findAll(root, (n) => typeof n.type === "string" && types.includes(n.type));
}
/** First node whose `id` equals the given value. */
export function byId(root: unknown, id: string): Node | undefined {
  return findFirst(root, (n) => n.id === id);
}
/** Read a nested property path safely: get(n, "content", "title"). */
export function get(node: unknown, ...path: Array<string | number>): unknown {
  let cur: unknown = node;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}
export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** "1,234" / "12.5" / "-3" / "+4%" → number; "--", "---", "" → null. */
export function parseNumber(display: unknown): number | null {
  if (typeof display === "number") return Number.isFinite(display) ? display : null;
  if (typeof display !== "string") return null;
  const m = display.replace(/,/g, "").match(/[-+]?\d*\.?\d+/);
  return m ? Number(m[0]) : null;
}
/** "32%" → 32. */
export function parsePercent(display: unknown): number | null {
  return typeof display === "string" && display.includes("%") ? parseNumber(display) : parseNumber(display);
}
/** "0:38" (h:mm) or "1:02:03" (h:mm:ss) → milliseconds. "45m", "2h 5m" also accepted. */
export function parseDurationMs(display: unknown): number | null {
  if (typeof display !== "string") return null;
  const s = display.trim();
  const clock = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (clock) return ((Number(clock[1]) * 60 + Number(clock[2])) * 60 + Number(clock[3] ?? 0)) * 1000;
  const h = s.match(/(\d+)\s*h/)?.[1];
  const m = s.match(/(\d+)\s*m(?!s)/)?.[1];
  const sec = s.match(/(\d+)\s*s/)?.[1];
  if (h === undefined && m === undefined && sec === undefined) return null;
  return ((Number(h ?? 0) * 60 + Number(m ?? 0)) * 60 + Number(sec ?? 0)) * 1000;
}
/** "174.2 lb" / "79 kg" / "126 lbs" → {value, unit}. */
export function parseWeight(display: unknown): { value: number; unit: "kg" | "lb" } | null {
  if (typeof display !== "string") return null;
  const value = parseNumber(display);
  if (value === null) return null;
  const unit = /kg/i.test(display) ? "kg" : /lb/i.test(display) ? "lb" : null;
  return unit ? { value, unit } : null;
}
