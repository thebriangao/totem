// Pure projections for the coach's memory (context hub) and AI settings.
// specs/ai.md §2.10–§2.11.
import { byType, get, str } from "../whoop/bff.js";
import type { MemoryOutT, MemoryRowT } from "../schemas/memory.js";

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "Start date: Nov 22, 2026" → "2026-11-22"; unparseable text is kept (label stripped). */
export function parseCardDate(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/\b([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})\b/);
  const month = m ? MONTHS[m[1]!.toLowerCase()] : undefined;
  if (m && month) return `${m[3]}-${month}-${m[2]!.padStart(2, "0")}`;
  const stripped = text.replace(/^[^:]*:\s*/, "").trim();
  return stripped || null;
}

/** CONTEXT_CARD content → compact row. The CONTEXT_DEFAULT tag carries the category label. */
export function projectContextCard(content: unknown): MemoryRowT | null {
  const id = str(get(content, "id"));
  if (!id) return null;
  const categoryTag = arr(get(content, "tags")).find((t) => get(t, "tag_style") === "CONTEXT_DEFAULT");
  return {
    id,
    title: str(get(content, "title")),
    summary: clip(str(get(content, "subtitle")) ?? str(get(content, "description"))),
    status: str(get(content, "status")),
    category: str(get(categoryTag, "title")),
  };
}

/** List rows carry a short summary; the detail view has the full text. */
function clip(text: string | null, max = 140): string | null {
  return text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The raw CONTEXT_CARD content for one id in an items response (for detail-free dates). */
export function findCardContent(raw: unknown, id: string): unknown {
  return arr(get(raw, "items")).map((it) => get(it, "content")).find((c) => get(c, "id") === id);
}

/**
 * Items response `{filters, items[CONTEXT_CARD]}` → rows (first `limit`) + the
 * category keys that have items. Rows carry their category only on the
 * all-categories timeline.
 */
export function projectMemoryItems(raw: unknown, category: string, limit = Infinity): Extract<MemoryOutT, { view: "items" }> {
  const all = arr(get(raw, "items"))
    .map((it) => projectContextCard(get(it, "content")))
    .filter((it): it is MemoryRowT => it !== null);
  const items = all.slice(0, limit).map((row) => {
    if (category === "timeline") return row;
    const { category: _omit, ...rest } = row;
    return rest;
  });
  const categories = byType(get(raw, "filters"), "TAG").flatMap((tag) => {
    // The selected pill has no action; fall back to its analytics label, then its title.
    const path = str(get(tag, "content", "action", "parameters", "request", "path"));
    const label = str(get(tag, "content", "title"));
    const key = path?.match(/[?&]category=([^&]+)/)?.[1] ??
      str(get(tag, "primary_analytic_event", "label")) ??
      (label ? label.trim().toLowerCase().replace(/\s+/g, "_") : null);
    return key ? [key] : [];
  });
  return { view: "items", category, categories, total: all.length, items };
}

/** context-detail screen → header, toggle state and the "Relevant Conversations" lines. */
export function projectMemoryDetail(raw: unknown, id: string, card?: unknown): Extract<MemoryOutT, { view: "detail" }> {
  const header = byType(raw, "CONTEXT_DETAIL_HEADER")[0];
  const toggle = byType(raw, "CONTEXT_STATUS_TOGGLE")[0];
  const changelog = byType(raw, "SECTION").find((s) => get(s, "content", "id") === "changelog_section");
  const lines = byType(changelog, "MARKDOWN_TEXT")
    .map((n) => str(get(n, "content", "text")))
    .filter((t): t is string => t !== null && t !== "Relevant Conversations")
    .map((t) => t.replace(/^-\s*/, "").replace(/\*\*/g, "").replace(/\s{2,}/g, " ").trim());
  return {
    view: "detail",
    id,
    title: str(get(header, "content", "title")),
    summary: str(get(header, "content", "subtitle")),
    status: str(get(toggle, "content", "current_state")),
    started: parseCardDate(str(get(card, "last_updated_at_text"))),
    expires: parseCardDate(str(get(card, "expires_at_text"))),
    conversations: lines,
    note: "Opening the detail marked this memory seen in the WHOOP app.",
  };
}

/** WHOOP_COACH_MEMORY from GET/PUT /ai-conversation-service/v1/settings. */
export function memoryEnabled(raw: unknown): boolean | null {
  const row = arr(get(raw, "settings")).find((s) => get(s, "setting_key") === "WHOOP_COACH_MEMORY");
  const active = get(row, "active");
  return typeof active === "boolean" ? active : null;
}
