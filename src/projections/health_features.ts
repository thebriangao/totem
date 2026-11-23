// whoop_health (EXPERIMENTAL): WHOOP's paid health features. No totem test
// account has any of them, so only their locked, empty and not-set-up answers
// have been seen (live, 2026-11-22). Routes come from @Acetone1's map of the
// Android app:
//   GET /healthspan-service/v1/healthspan/bff?date=   {unlocked_content, locked_content}
//   GET /sage-service/v1/sage/bff?date=               blood pressure, same shape
//   GET /arrhythmia-service/v2/afibhistory/screen    404 "No anf user" until set up;
//       …/afibhistory/paginated?next_token=, /arrhythmia-service/v1/history/bff?historyDate=
//   GET /advanced-labs-service/v1/advanced-labs/biomarkers/summary
//       items[SEARCHABLE_BIOMARKERS_LIST].content.biomarkers[] {id, title, value, unit,
//       status_type}; without results every value is "--" and status UNAVAILABLE.
//       …/tests/history (sections[].items[], an EMPTY_TILE without tests),
//       …/biomarkers/{id}?next_token= ({navigation_title, header{title, subtitle, pills},
//       sections, status}; status UNAVAILABLE without results), …/tests/{id}, …/insights?testId=
// What is certain is exact (locked, no results, not set up, the biomarker
// list's fields, and Healthspan's unlocked screen, seen on a real account on
// 2026-11-22: projectHealthspan). Anything else is the screen passed through with
// its UI fields stripped and its size capped (src/lib/screen_content.ts).
import { get, str } from "../whoop/bff.js";
import { nodes } from "./v2/core_common.js";
import { screenContent } from "../lib/screen_content.js";

export const HEALTH_FEATURES = ["healthspan", "blood_pressure", "afib", "labs"] as const;
export type HealthFeatureName = (typeof HEALTH_FEATURES)[number];

export type FeatureStatus = "available" | "locked" | "not_set_up" | "no_data" | "unavailable";
export interface Biomarker { id: string; name: string | null; value: string | null; unit: string | null; status: string | null }
/** Healthspan, from its unlocked screen. Numbers as WHOOP shows them; years are signed (+ older, − younger). */
export interface Healthspan {
  period: string | null;
  calibrating: boolean;
  whoop_age: number | null;
  years_vs_actual_age: number | null;
  pace_of_aging: number | null;
  previous: { whoop_age: number | null; years_vs_actual_age: number | null; pace_of_aging: number | null } | null;
  /** [area, contributor, long-term average, recent average, years it adds (+) or takes off (−)]. */
  contributor_cols: ["area", "name", "long_avg", "recent_avg", "impact_years"];
  contributors: Array<[string, string, string | null, string | null, number | null]>;
}

export interface HealthFeature {
  status: FeatureStatus;
  healthspan?: Healthspan;
  message?: string | null;
  content?: unknown;
  truncated?: true;
  biomarkers?: Biomarker[];
  tests?: unknown;
  next_cursor?: string | null;
}

/** WHOOP's page token, wherever in the screen it sits (next_token / nextToken). */
export function nextToken(raw: unknown, depth = 0): string | null {
  if (depth > 6 || typeof raw !== "object" || raw === null) return null;
  for (const [k, v] of Object.entries(raw)) {
    if (/^next_?token$/i.test(k) && typeof v === "string" && v) return v;
  }
  for (const v of Object.values(raw)) {
    const t = nextToken(v, depth + 1);
    if (t) return t;
  }
  return null;
}

const lockedMessage = (raw: unknown): string | null => {
  const head = str(get(raw, "locked_content", "header_text_display"));
  const body = str(get(raw, "locked_content", "description_display"));
  return [head, body].filter(Boolean).join(": ") || null;
};

/** A screen whose filled-in shape is unknown: stripped, capped, with its page token. */
export function passThrough(content: unknown, maxChars = 2_500): HealthFeature {
  const { content: c, truncated } = screenContent(content, maxChars);
  const next = nextToken(content);
  return { status: "available", content: c, ...(truncated ? { truncated: true as const } : {}), ...(next ? { next_cursor: next } : {}) };
}

const num = (v: unknown): number | null => {
  const m = typeof v === "string" ? v.replace(/,/g, "").match(/[-+]?\d+(?:\.\d+)?/) : null;
  return m ? Number(m[0]) : typeof v === "number" ? v : null;
};
/** "TIME IN HR ZONES 1-3 (WEEKLY)" as "Time in HR zones 1-3 (weekly)". */
const sentence = (s: string | null): string => {
  const low = (s ?? "").toLowerCase();
  return (low.charAt(0).toUpperCase() + low.slice(1)).replace(/\brhr\b/gi, "RHR").replace(/\bhr\b/gi, "HR").replace(/^vo₂/i, "VO₂").replace(/\bvo₂ max\b/i, "VO₂ max");
};
/** "1.8 years older" as +1.8, "YOUNGER" as negative. */
const signedYears = (value: unknown, ...hints: unknown[]): number | null => {
  const n = num(value);
  if (n === null) return null;
  if (typeof value === "string" && /^\s*[-+]/.test(value)) return n;
  return hints.some((h) => typeof h === "string" && /younger/i.test(h)) ? -Math.abs(n) : Math.abs(n);
};
const amoeba = (a: unknown) => a && typeof a === "object" ? {
  whoop_age: num(get(a, "age_value_display")),
  years_vs_actual_age: signedYears(get(a, "years_difference_value_display"), get(a, "years_difference_subtitle_display"), get(a, "years_difference_value_style"), get(a, "age_subtitle_display")),
  pace_of_aging: num(get(a, "pace_of_aging_display")),
} : null;
const reading = (r: unknown): string | null => {
  const v = str(get(r, "value_display"));
  // No data yet: WHOOP shows "--" (with a placeholder unit).
  if (!v || /^[-–—\s]+$/.test(v)) return null;
  const unit = str(get(r, "value_unit_display"));
  return unit ? `${v} ${unit}` : v;
};

/**
 * Healthspan's unlocked screen (seen live, 2026-11-22): whoop_age_amoeba
 * {age_value_display, years_difference_value_display + its OLDER/YOUNGER
 * subtitle, pace_of_aging_display "1.1x", is_calibrating}, the same for the
 * previous period, the period in date_picker.current_date_range_display, and
 * items[TILE_SECTION Sleep|Strain|Fitness].content.items[CONTRIBUTORS_CONTAINER]
 * .content.contributors[{title_display, content: {top_range_value (long-term
 * average), expanded_bottom_range_value (recent), impact_value_display "+0.4"
 * years, impact_value_style OLDER|YOUNGER}}]. Anything else passes through.
 */
export function projectHealthspan(unlocked: unknown): HealthFeature {
  const now = amoeba(get(unlocked, "whoop_age_amoeba"));
  if (!now || now.whoop_age === null) return passThrough(unlocked);
  const contributors: Healthspan["contributors"] = [];
  for (const section of nodes(get(unlocked, "items")).filter((i) => str(i.type) === "TILE_SECTION")) {
    const area = str(get(section, "content", "title_display")) ?? "";
    for (const box of nodes(get(section, "content", "items")).filter((i) => str(i.type) === "CONTRIBUTORS_CONTAINER")) {
      for (const c of nodes(get(box, "content", "contributors"))) {
        const body = get(c, "content");
        contributors.push([area, sentence(str(c.title_display)), reading(get(body, "top_range_value")), reading(get(body, "expanded_bottom_range_value")),
          signedYears(get(body, "impact_value_display"), get(body, "impact_value_style"))]);
      }
    }
  }
  return {
    status: "available",
    healthspan: {
      period: str(get(unlocked, "date_picker", "current_date_range_display")),
      calibrating: get(unlocked, "is_calibrating") === true || get(unlocked, "whoop_age_amoeba", "is_calibrating") === true,
      ...now,
      previous: amoeba(get(unlocked, "previous_whoop_age_amoeba")),
      contributor_cols: ["area", "name", "long_avg", "recent_avg", "impact_years"],
      contributors,
    },
  };
}

/** Healthspan and blood pressure: one locked/unlocked screen. */
export function projectLockable(raw: unknown, unlockedProjection: (u: unknown) => HealthFeature = passThrough): HealthFeature {
  const unlocked = get(raw, "unlocked_content");
  if (unlocked !== null && unlocked !== undefined) return unlockedProjection(unlocked);
  if (get(raw, "locked_content")) return { status: "locked", message: lockedMessage(raw) };
  return { status: "unavailable", message: "WHOOP returned neither content nor a lock." };
}

/** The biomarkers that have a result, from the summary screen. */
export function projectLabs(raw: unknown): HealthFeature {
  const list = nodes(get(raw, "items")).find((i) => str(i.type) === "SEARCHABLE_BIOMARKERS_LIST");
  if (!list) return { status: "unavailable", message: "WHOOP's lab summary had no biomarker list." };
  const withData = nodes(get(list, "content", "biomarkers")).filter((b) => str(b.status_type) !== "UNAVAILABLE" && str(b.value) !== "--");
  if (!withData.length) return { status: "no_data", message: "No lab results (WHOOP Advanced Labs or uploaded)." };
  return {
    status: "available",
    biomarkers: withData.map((b) => ({ id: str(b.id) ?? "", name: str(b.title), value: str(b.value), unit: str(b.unit), status: str(b.status_type) })),
  };
}

/** The lab tests on the Lab History screen, without its empty "upload labs" tile. */
export function projectLabTests(raw: unknown): unknown {
  const items = nodes(get(raw, "paginated_records", "sections")).flatMap((s) => nodes(s.items)).filter((i) => str(i.type) !== "EMPTY_TILE");
  return items.length ? screenContent(items, 1_500).content : null;
}

/**
 * A biomarker screen without results. Seen live on 2026-11-22: top-level
 * status "UNAVAILABLE" (the summary's status_type for the same case), an
 * EMPTY_TILE "Add Lab Results" section and a "learn more" EXPANDABLE_LIST.
 * Without the status, a screen holding only those two kinds counts as empty.
 */
export function biomarkerEmpty(raw: unknown): boolean {
  if (str(get(raw, "status")) === "UNAVAILABLE") return true;
  const items = nodes(get(raw, "sections")).flatMap((s) => nodes(s.items));
  return items.some((i) => str(i.type) === "EMPTY_TILE") && items.every((i) => ["EMPTY_TILE", "EXPANDABLE_LIST"].includes(str(i.type) ?? ""));
}

/** A biomarker's screen: its results, or no_data with what the biomarker is. */
export function projectBiomarker(raw: unknown): HealthFeature {
  if (!biomarkerEmpty(raw)) return passThrough(raw, 3_000);
  const name = str(get(raw, "header", "title"));
  return {
    status: "no_data",
    message: `No results${name ? ` for ${name}` : ""} yet.`,
    content: screenContent({ name, about: str(get(raw, "header", "subtitle")), tags: get(raw, "header", "pills") }).content,
  };
}
