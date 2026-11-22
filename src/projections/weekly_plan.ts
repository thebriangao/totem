// Weekly plan (SPEC.md §4.7; specs/discovery.md §2.11). Two reads, merged by goal id:
//   GET /progression-service/v1/weekly-plan?date=     header_items[CURRENT_PLAN_TILE{plan_id}],
//       progress_bar, goal_section[{id: TargetGoalType, goal_cards[{content{title,
//       circular_progress_indicator, plan_progress_status}}]}]. With no plan, the
//       goal_section holds locked PLAN_TILEs (no ids) instead.
//   GET /progression-service/v2/weekly-plan/home-tile/{date}   WEEKLY_PLAN_HOME_TILE{title,
//       days_left_display, progress_bar, items[{id, title, circular_progress_indicator}]}, or
//       TEXT_WITH_ILLUSTRATION when there is no plan.
// Weeks run Monday–Sunday.
import type { WeeklyPlanOutT } from "../schemas/weekly_plan.js";
import { byType, get, parseDurationMs, parseNumber, str, type Node } from "../whoop/bff.js";

const isObj = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Monday–Sunday week containing `date` (YYYY-MM-DD). */
export function planWeek(date: string): { start: string; end: string } {
  const t = Date.parse(`${date}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(t + (6 - dow) * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

/** "10,000+ Steps" → 10000; "2:00+ Strength Activity Time" → 120 (minutes). */
export function goalTarget(title: string | null): number | null {
  if (!title) return null;
  const clock = title.match(/(\d+:\d{2})\s*\+/);
  const ms = clock ? parseDurationMs(clock[1]) : null;
  return ms !== null ? Math.round(ms / 60_000) : parseNumber(title);
}

function progress(indicator: unknown): { days_met: [number, number] | null; pct: number | null; value: string | null } {
  const steps = get(indicator, "current_progress_steps");
  const pct = get(indicator, "current_progress_percentage");
  const cur = num(get(steps, "current_step"));
  const total = num(get(steps, "total_steps"));
  const p = num(get(pct, "percentage"));
  return {
    days_met: cur !== null && total !== null ? [cur, total] : null,
    pct: p === null ? null : Math.round(p * 10) / 10,
    value: str(get(pct, "text_display")),
  };
}

export function projectWeeklyPlan(v1: unknown, tile: unknown, date: string): WeeklyPlanOutT {
  const planTile = byType(v1, "CURRENT_PLAN_TILE")[0];
  const home = get(tile, "tile");
  const homeActive = get(home, "type") === "WEEKLY_PLAN_HOME_TILE";
  const hasPlan = Boolean(planTile) || homeActive;
  const homeItems = homeActive ? arr(get(home, "content", "items")).filter(isObj) : [];
  const sections = hasPlan ? arr(get(v1, "plan", "goal_section")).filter((g) => isObj(g) && typeof g.id === "string") as Node[] : [];
  const ids = [...new Set([...sections.map((g) => g.id as string), ...homeItems.map((i) => str(i.id)).filter((i): i is string => !!i)])];
  const goals = ids.map((id) => {
    const card = get(arr(sections.find((g) => g.id === id)?.goal_cards)[0], "content");
    const item = homeItems.find((i) => i.id === id);
    // The target sits in whichever title has it: the v1 steps card says "8,000+ Steps", but the
    // v1 time-goal card is just "Strength Activity Time" and only the tile says "2:00+ …".
    const target = goalTarget(str(get(card, "title"))) ?? goalTarget(str(get(item, "title")));
    const p = progress(get(card, "circular_progress_indicator") ?? get(item, "circular_progress_indicator"));
    // "Steps Taken This Week: 1,197", or a time goal's "0:32" (h:mm done so far).
    const weekText = str(get(card, "plan_progress_status", "title"));
    const doneMs = parseDurationMs(p.value);
    const thisWeek = weekText && /this week/i.test(weekText)
      ? parseNumber(weekText.split(":").pop())
      : doneMs !== null ? Math.round(doneMs / 60_000) : null;
    return { type: id, target, days_met: p.days_met, pct: p.pct, this_week: thisWeek };
  });
  return {
    has_plan: hasPlan,
    plan_id: str(get(planTile, "content", "destination", "parameters", "plan_id")),
    plan: str(get(planTile, "content", "title_display")) ?? (homeActive ? str(get(home, "content", "title")) : null),
    week: planWeek(date),
    days_left: homeActive ? parseNumber(get(home, "content", "days_left_display")) : null,
    pct: num(get(home, "content", "progress_bar", "percent_value")) ?? (hasPlan ? num(get(v1, "plan", "progress_bar", "percent_value")) : null),
    goals,
  };
}
