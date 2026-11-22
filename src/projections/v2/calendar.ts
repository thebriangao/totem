// whoop_calendar: GET /home-service/v1/calendar/{recovery|strain|sleep}?date=
// (SPEC.md §4.2). Days carry only "1".."31" (no full date) and cycle_id (dropped:
// unstable, useless here). Encoded as one character per day of the month:
// H/M/L = high/medium/low, "-" = data but no score, "." = no data.
import { get, isNode, nodes, str } from "./core_common.js";

export const CALENDAR_PILLARS = ["recovery", "strain", "sleep"] as const;
export type CalendarPillar = (typeof CALENDAR_PILLARS)[number];

export interface CalendarV2 {
  pillar: CalendarPillar;
  month: string;
  /** days[i] is day i+1 of the month. */
  days: string;
  /** WHOOP's thresholds for the letters that apply to this pillar. */
  key: Record<string, string>;
}

export function stateChar(state: string | null, hasData: boolean): string {
  if (state && state !== "NO_DATA") {
    if (state.startsWith("HIGH")) return "H";
    if (state.startsWith("MEDIUM")) return "M";
    if (state.startsWith("LOW")) return "L";
    return "?";
  }
  return hasData ? "-" : ".";
}

export function projectCalendarV2(raw: unknown, pillar: CalendarPillar, anyDate: string): CalendarV2 {
  const month = anyDate.slice(0, 7);
  const chars: string[] = [];
  for (const d of nodes(get(raw, "days_of_month"))) {
    const n = Number(str(d.date_value_display));
    if (!Number.isInteger(n) || n < 1 || n > 31) continue;
    chars[n - 1] = stateChar(str(d.day_state), d.has_data === true);
  }
  const key: Record<string, string> = {};
  for (const k of nodes(isNode(raw) ? raw.calendar_key : null)) {
    const label = str(k.text_display);
    if (label) key[stateChar(str(k.state), true)] = label;
  }
  return { pillar, month, days: Array.from(chars, (c) => c ?? ".").join(""), key };
}
