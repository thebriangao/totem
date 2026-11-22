// Milestones and the data streak (SPEC.md §4.7; specs/discovery.md §2.13), via the BFF walker.
//   GET /milestones-service/v1/bff/milestones/hub: a header ROW of MARKDOWN_TEXT value/label
//       pairs (Total / Unique / Rare), then TAG_SELECTOR.content.tag_maps[tag] →
//       CELEBRATION_MEDIA_WITH_CAPTION{caption_text, media.text_overlay (count),
//       sub_caption_text ("Top 18%" | "**1** of 5"), destination.parameters.milestone_type}.
//       Tags: all, sleep, recovery, strain, healthspan, other, activities ("all" repeats the rest).
//   GET …/milestones/{type}/details: TITLE_SUBTITLE, CELEBRATION_MEDIA (count),
//       MILESTONE_PROGRESS_CARD_V2{title "4 more", progress_percent}, earned grid with dates.
//   GET /streaks-service/v1/bff/streaks/data-streak: value, state, started / max, week tracker.
// Not /achievements-service/v1/progression: that's a static 2021 level table.
import type { BadgeT, MilestoneDetailOutT, StreakT } from "../schemas/milestones.js";
import { byType, get, parseNumber, str, walk, type Node } from "../whoop/bff.js";

const isObj = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Nov 21, 2026" → "2026-11-21". */
export function displayDate(s: unknown): string | null {
  const m = typeof s === "string" ? s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/) : null;
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  return m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : null;
}

function badgeStatus(sub: string | null): string | null {
  if (!sub) return null;
  const plain = sub.replace(/\*/g, "").trim();
  const top = plain.match(/top\s*(\d+(?:\.\d+)?)\s*%/i);
  if (top) return `top ${top[1]}%`;
  const of = plain.match(/(\d+)\s*of\s*(\d+)/i);
  return of ? `${of[1]}/${of[2]}` : plain;
}

function badge(cell: Node, tag: string): BadgeT | null {
  const c = cell.content;
  const type = str(get(c, "destination", "parameters", "milestone_type"));
  if (!type) return null;
  return {
    type,
    tag,
    name: str(get(c, "caption_text")),
    count: parseNumber(get(c, "media", "text_overlay")) ?? 0,
    status: badgeStatus(str(get(c, "sub_caption_text"))),
  };
}

export function projectMilestonesHub(raw: unknown): { totals: { total: number | null; unique: number | null; rare: number | null }; badges: BadgeT[] } {
  // Header counts: the value text precedes its label in document order.
  const totals = { total: null as number | null, unique: null as number | null, rare: null as number | null };
  const header = byType(raw, "ROW")[0];
  let last: number | null = null;
  for (const n of walk(header)) {
    if (n.type !== "MARKDOWN_TEXT") continue;
    const text = str(get(n, "content", "text"));
    const label = text?.trim().toLowerCase();
    if (label === "total" || label === "unique" || label === "rare") totals[label] = last;
    else last = parseNumber(text);
  }

  const tagMaps = get(byType(raw, "TAG_SELECTOR")[0], "content", "tag_maps");
  const groups: Array<[string, unknown]> = isObj(tagMaps)
    ? Object.entries(tagMaps).filter(([tag]) => tag !== "all")
    : byType(raw, "SECTION")
        .map((s) => [String(get(s, "content", "id") ?? "").replace(/^section-/, ""), s] as [string, unknown])
        .filter(([tag]) => tag && tag !== "all");
  const badges: BadgeT[] = [];
  for (const [tag, node] of groups) {
    for (const cell of byType(node, "CELEBRATION_MEDIA_WITH_CAPTION")) {
      const b = badge(cell, tag);
      if (b && !badges.some((x) => x.type === b.type)) badges.push(b);
    }
  }
  return { totals, badges };
}

const topPct = (b: BadgeT): number => Number(b.status?.match(/^top ([\d.]+)%$/)?.[1] ?? 101);
const progressFrac = (b: BadgeT): number => {
  const m = b.status?.match(/^(\d+)\/(\d+)$/);
  return m ? Number(m[1]) / Number(m[2]) : 0;
};

/** Earned badges, most-earned (then rarest) first. */
export function topBadges(badges: BadgeT[], n = 5): BadgeT[] {
  return badges.filter((b) => b.count > 0).sort((a, b) => b.count - a.count || topPct(a) - topPct(b)).slice(0, n);
}

/** Unearned badges closest to their first level. */
export function nearestBadges(badges: BadgeT[], n = 3): BadgeT[] {
  return badges.filter((b) => b.count === 0 && progressFrac(b) > 0).sort((a, b) => progressFrac(b) - progressFrac(a)).slice(0, n);
}

export function projectDataStreak(raw: unknown): StreakT {
  const list = arr(get(byType(raw, "HORIZONTAL_DIVIDED_LIST")[0], "content", "list_items")).filter(isObj);
  const item = (re: RegExp) => list.find((i) => re.test(str(i.subtitle) ?? ""));
  const tracked = arr(get(byType(raw, "HORIZONTAL_TRACKER")[0], "content", "tracked_items")).filter(isObj);
  const card = byType(raw, "MILESTONE_PROGRESS_CARD")[0];
  const week = tracked.length
    ? {
        worn: tracked.filter((t) => /\/active\//.test(str(t.icon_url) ?? "")).map((t) => str(t.title) ?? ""),
        missed: tracked.filter((t) => /circle_cross/.test(str(t.icon_url) ?? "")).map((t) => str(t.title) ?? ""),
      }
    : null;
  return {
    days: parseNumber(get(raw, "streak_value")),
    state: str(get(raw, "today_streak_state")),
    started: displayDate(item(/started/i)?.title),
    max: parseNumber(item(/max/i)?.title),
    next_milestone_in_days: parseNumber(get(card, "content", "title")),
    this_week: week,
  };
}

export function projectMilestoneDetail(raw: unknown, type: string): MilestoneDetailOutT {
  const title = byType(raw, "TITLE_SUBTITLE")[0];
  const media = byType(raw, "CELEBRATION_MEDIA")[0];
  const card = byType(raw, "MILESTONE_PROGRESS_CARD_V2")[0];
  const pct = get(card, "content", "progress_percent");
  const earned = byType(raw, "CELEBRATION_MEDIA_WITH_CAPTION").map((cell) => [
    parseNumber(get(cell, "content", "media", "text_overlay")),
    displayDate(get(cell, "content", "sub_caption_text")),
  ] as [number | null, string | null]).filter(([, d]) => d !== null);
  return {
    type,
    name: str(get(title, "content", "title")),
    about: str(get(title, "content", "subtitle")),
    count: parseNumber(get(media, "content", "text_overlay")),
    next: card
      ? { more: parseNumber(get(card, "content", "title")), pct: typeof pct === "number" ? Math.round(pct * 1000) / 10 : null }
      : null,
    earned,
  };
}
