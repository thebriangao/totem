// whoop_profile include=health: WHOOP's paid health features, which no totem
// test account has (routes from @Acetone1's Android list; locked and empty
// shapes recorded live on 2026-11-22):
//   GET /healthspan-service/v1/healthspan/bff?date=   {unlocked_content, locked_content}
//   GET /sage-service/v1/sage/bff?date=               blood pressure, same shape
//   GET /advanced-labs-service/v1/advanced-labs/biomarkers/summary
//       items[SEARCHABLE_BIOMARKERS_LIST].content.biomarkers[] {id, title, value, unit,
//       status_type}; without results every value is "--" and status UNAVAILABLE
//   GET /arrhythmia-service/v2/afibhistory/screen    404 "No anf user" until set up
// Locked and empty answers are certain. An unlocked Healthspan, blood pressure or
// AFib screen has never been seen, so it is passed through as stripped content
// marked unverified; lab biomarkers keep the fields the empty list already shows.
import { get, str } from "../whoop/bff.js";
import { nodes } from "./v2/core_common.js";
import { screenContent } from "../lib/screen_content.js";

export type FeatureStatus = "available" | "locked" | "not_set_up" | "no_data" | "unavailable";
export interface HealthFeature {
  status: FeatureStatus;
  message?: string | null;
  unverified?: true;
  content?: unknown;
  truncated?: true;
  biomarkers?: Array<{ id: string; name: string | null; value: string | null; unit: string | null; status: string | null }>;
}

const lockedMessage = (raw: unknown): string | null => {
  const head = str(get(raw, "locked_content", "header_text_display"));
  const body = str(get(raw, "locked_content", "description_display"));
  return [head, body].filter(Boolean).join(": ") || null;
};

function passThrough(content: unknown): HealthFeature {
  const { content: c, truncated } = screenContent(content);
  return { status: "available", unverified: true, content: c, ...(truncated ? { truncated: true as const } : {}) };
}

/** Healthspan and blood pressure: one locked/unlocked screen. */
export function projectLockable(raw: unknown): HealthFeature {
  const unlocked = get(raw, "unlocked_content");
  if (unlocked !== null && unlocked !== undefined) return passThrough(unlocked);
  if (get(raw, "locked_content")) return { status: "locked", message: lockedMessage(raw) };
  return { status: "unavailable", message: "WHOOP returned neither content nor a lock." };
}

export function projectLabs(raw: unknown): HealthFeature {
  const list = nodes(get(raw, "items")).find((i) => str(i.type) === "SEARCHABLE_BIOMARKERS_LIST");
  const rows = nodes(get(list, "content", "biomarkers"));
  const withData = rows.filter((b) => str(b.status_type) !== "UNAVAILABLE" && str(b.value) !== "--");
  if (!list) return { status: "unavailable", message: "WHOOP's lab summary had no biomarker list." };
  if (!withData.length) return { status: "no_data", message: "No lab results (WHOOP Advanced Labs or uploaded)." };
  return {
    status: "available",
    unverified: true,
    biomarkers: withData.map((b) => ({
      id: str(b.id) ?? "",
      name: str(b.title),
      value: str(b.value),
      unit: str(b.unit),
      status: str(b.status_type),
    })),
  };
}

export function projectAfib(raw: unknown): HealthFeature {
  return passThrough(raw);
}
