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
//   GET /ecg-service/v1/ecg/about                    {page_title, information_items[{info_label, info_value}]}
// What is certain is exact (locked, no results, not set up, the ECG about page,
// the biomarker list's fields). Anything else is the screen passed through with
// its UI fields stripped and its size capped (src/lib/screen_content.ts).
import { get, str } from "../whoop/bff.js";
import { nodes } from "./v2/core_common.js";
import { screenContent } from "../lib/screen_content.js";

export const HEALTH_FEATURES = ["healthspan", "blood_pressure", "afib", "labs", "ecg"] as const;
export type HealthFeatureName = (typeof HEALTH_FEATURES)[number];

export type FeatureStatus = "available" | "locked" | "not_set_up" | "no_data" | "not_readable" | "unavailable";
export interface Biomarker { id: string; name: string | null; value: string | null; unit: string | null; status: string | null }
export interface HealthFeature {
  status: FeatureStatus;
  message?: string | null;
  content?: unknown;
  truncated?: true;
  biomarkers?: Biomarker[];
  tests?: unknown;
  about?: Record<string, string>;
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

/** Healthspan and blood pressure: one locked/unlocked screen. */
export function projectLockable(raw: unknown): HealthFeature {
  const unlocked = get(raw, "unlocked_content");
  if (unlocked !== null && unlocked !== undefined) return passThrough(unlocked);
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

/** The ECG feature's regulatory page: label → value. */
export function projectEcgAbout(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of nodes(get(raw, "information_items"))) {
    const label = str(item.info_label);
    const value = str(item.info_value);
    if (label && value) out[label] = value;
  }
  return out;
}
