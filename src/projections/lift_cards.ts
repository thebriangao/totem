// Parsers for the Strength Trainer card screens shared by whoop_lift_sessions and
// whoop_lift_exercise: GET /weightlifting-service/v3/exercise/{id}/exercise_history
// and …/personal_records. Both return EXPANDABLE_CARDs, one per workout (history)
// or per medal (records):
//   header_content.EXERCISE_RECORD_HEADER{record_title{value,unit}, record_subtitle, achievement_icon, record_date}
//   expanded_content[EXERCISE_BREAKDOWN{table_titles ["REPS","WEIGHT"]|["TIME","WEIGHT"], rows[].items[]{value, units, achievement_icon}},
//                    EXERCISE_BREAKDOWN{table_titles ["TOTAL"]}, CARD_BUTTON → destination.parameters.activity_id]
// Values are display strings in the account's current unit ("209" + "lbs", "5:00" + "min", "1,000").
import { byType, get, parseNumber, str, type Node } from "../whoop/bff.js";

export type MedalT = "GOLD" | "SILVER" | "BRONZE";

export function medal(icon: unknown): MedalT | null {
  if (icon === "BADGE_GOLD") return "GOLD";
  if (icon === "BADGE_SILVER") return "SILVER";
  if (icon === "BADGE_BRONZE") return "BRONZE";
  return null;
}

/** "lbs" / "lb" → "lb", "kg" → "kg"; anything else (reps, min, null) → null. */
export function weightUnit(u: unknown): "kg" | "lb" | null {
  if (typeof u !== "string") return null;
  if (/^kgs?$/i.test(u.trim())) return "kg";
  if (/^lbs?$/i.test(u.trim())) return "lb";
  return null;
}

/** Lift time displays are m:ss ("5:00" = 5 min) or h:mm:ss. "--" / "" → null. */
export function clockSeconds(display: unknown): number | null {
  if (typeof display !== "string") return null;
  const m = display.trim().match(/^(?:(\d+):)?(\d+):(\d{2})$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "November 21, 2026" / "Nov 21, 2026" / "· Nov 21, 2026" → "2026-11-21"; null if unparseable. */
export function displayDate(display: unknown): string | null {
  if (typeof display !== "string") return null;
  const m = display.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const idx = MONTHS.findIndex((name) => name.startsWith(m[1]!.toLowerCase()));
  if (idx < 0) return null;
  return `${m[3]}-${String(idx + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

export interface CardSet {
  reps: number | null;
  time_seconds: number | null;
  weight: number | null;
  unit: "kg" | "lb" | null;
  medal: MedalT | null;
}

export interface LiftCard {
  date: string | null;
  activity_id: string | null;
  medal: MedalT | null;
  /** The card's headline record, e.g. {value: 209, unit: "lbs"} or {value: 8, unit: "reps"}. */
  record: { value: number | null; display: string | null; unit: string | null };
  sets: CardSet[];
  total: { reps: number | null; time_seconds: number | null; volume: number | null; unit: "kg" | "lb" | null };
}

function cellValue(item: unknown): { value: string | null; units: string | null; medal: MedalT | null } {
  return { value: str(get(item, "value")), units: str(get(item, "units")), medal: medal(get(item, "achievement_icon")) };
}

function parseBreakdownRow(titles: string[], items: unknown[]): CardSet {
  const set: CardSet = { reps: null, time_seconds: null, weight: null, unit: null, medal: null };
  titles.forEach((title, i) => {
    const cell = cellValue(items[i]);
    set.medal = set.medal ?? cell.medal;
    const t = title.toUpperCase();
    if (t === "REPS") set.reps = parseNumber(cell.value);
    else if (t === "TIME") set.time_seconds = clockSeconds(cell.value);
    else if (t === "WEIGHT") {
      set.weight = parseNumber(cell.value);
      set.unit = weightUnit(cell.units);
    }
  });
  return set;
}

/** One EXPANDABLE_CARD → a workout's sets for one exercise. */
export function parseLiftCard(card: Node): LiftCard {
  const header = (byType(card, "EXERCISE_RECORD_HEADER")[0]?.content ?? {}) as Node;
  const breakdowns = byType(card, "EXERCISE_BREAKDOWN").map((b) => (b.content ?? {}) as Node);
  const titlesOf = (b: Node): string[] => (Array.isArray(b.table_titles) ? b.table_titles.filter((t): t is string => typeof t === "string") : []);
  const setTable = breakdowns.find((b) => !titlesOf(b).includes("TOTAL"));
  const totalTable = breakdowns.find((b) => titlesOf(b).includes("TOTAL"));
  const columns = setTable ? titlesOf(setTable) : [];
  const rows = (Array.isArray(setTable?.rows) ? setTable.rows : []) as Node[];
  const sets = rows.map((r) => parseBreakdownRow(columns, Array.isArray(r.items) ? r.items : []));

  // The TOTAL row uses the set table's columns: [reps|time total, weight total].
  const totalItems = (get(totalTable, "rows", 0, "items") ?? []) as unknown[];
  const firstTotal = cellValue(totalItems[0]);
  const secondTotal = cellValue(totalItems[1]);
  const timeBased = columns[0]?.toUpperCase() === "TIME";
  const button = byType(card, "CARD_BUTTON").find((b) => typeof get(b, "content", "destination", "parameters", "activity_id") === "string");
  const title = get(header, "record_title");
  const titleValue = str(get(title, "value"));
  return {
    date: displayDate(get(header, "record_date")),
    activity_id: (get(button, "content", "destination", "parameters", "activity_id") as string | undefined) ?? null,
    medal: medal(get(header, "achievement_icon")),
    record: {
      value: str(get(title, "unit")) === "min" ? clockSeconds(titleValue) : parseNumber(titleValue),
      display: titleValue && str(get(title, "unit")) ? `${titleValue} ${str(get(title, "unit"))}` : titleValue,
      unit: str(get(title, "unit")) === "min" ? "s" : (weightUnit(get(title, "unit")) ?? str(get(title, "unit"))),
    },
    sets,
    total: {
      reps: timeBased ? null : parseNumber(firstTotal.value),
      time_seconds: timeBased ? clockSeconds(firstTotal.value) : null,
      volume: parseNumber(secondTotal.value),
      unit: weightUnit(secondTotal.units),
    },
  };
}

/** exercise_history / personal_records → cards plus the `startDate` cursor for the next (older) page. */
export function parseLiftCards(raw: unknown): { cards: LiftCard[]; next_cursor: string | null } {
  const items = (Array.isArray(get(raw, "items")) ? get(raw, "items") : []) as unknown[];
  const cards = items
    .filter((it): it is Node => typeof it === "object" && it !== null && (it as Node).type === "EXPANDABLE_CARD")
    .map(parseLiftCard);
  return { cards, next_cursor: str(get(raw, "show_more", "next_start_date")) };
}
