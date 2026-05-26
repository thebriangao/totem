import type { CalendarOutT } from "../schemas/calendar.js";
import { isObject, asArray, asNumber, asString } from "../lib/walk.js";

interface ProjectCalendarInput {
  overview: unknown;
  recovery: unknown;
  date: string;
}

export function projectCalendar(input: ProjectCalendarInput): CalendarOutT {
  const overview = isObject(input.overview) ? input.overview : {};
  const recovery = isObject(input.recovery) ? input.recovery : {};

  const overviewDays = asArray(overview.days_of_month);
  const recoveryDays = asArray(recovery.days_of_month);

  const recoveryByDate = new Map<string, { score: number | null; state: "GREEN" | "YELLOW" | "RED" | null }>();
  for (const r of recoveryDays) {
    if (!isObject(r)) continue;
    const d = asString(r.date);
    if (!d) continue;
    recoveryByDate.set(d, {
      score: asNumber(r.score ?? r.recovery_score),
      state: asString(r.state ?? r.recovery_state) as "GREEN" | "YELLOW" | "RED" | null,
    });
  }

  const days: CalendarOutT["days"] = [];
  for (const d of overviewDays) {
    if (!isObject(d)) continue;
    const date = asString(d.date);
    if (!date) continue;
    const rec = recoveryByDate.get(date);
    days.push({
      date,
      recovery_score: rec?.score ?? asNumber(d.recovery_score),
      recovery_state: rec?.state ?? (asString(d.recovery_state) as "GREEN" | "YELLOW" | "RED" | null),
      sleep_score: asNumber(d.sleep_score),
      day_strain: asNumber(d.day_strain),
    });
  }

  return { month: input.date.slice(0, 7), days };
}
