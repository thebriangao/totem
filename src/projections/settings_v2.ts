// Pure projections for preferences and HR zones (SPEC.md §4.6, §4.8).
import { asArray, asBool, asNumber, asString, isObject } from "../lib/walk.js";
import { FIXED_GAUGES } from "../lib/profile_settings.js";
import { BEHAVIORS_BY_ID } from "../data/behaviors.js";
import type { HrZonesV2OutT } from "../schemas/settings_v2.js";

/** GET /journal-service/v1/journals/preferences. */
export function projectJournalPrefs(raw: unknown) {
  const r = isObject(raw) ? raw : {};
  return {
    journal_enabled: asBool(r.journal_enabled),
    journal_autopop_enabled: asBool(r.journal_autopop_enabled),
    ai_autopop_enabled: asBool(r.ai_autopop_enabled),
  };
}

/** GET /notification-service/v1/notifications/user-settings/bff → {namespace: active}. `active:false` = blocked. */
export function projectNotifications(raw: unknown): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const s of asArray(isObject(raw) ? raw.settings : null)) {
    if (isObject(s) && asString(s.push_namespace)) out[s.push_namespace as string] = asBool(s.active);
  }
  return out;
}

/** GET /ai-conversation-service/v1/settings → {setting_key: active}. */
export function projectAiSettings(raw: unknown): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const s of asArray(isObject(raw) ? raw.settings : null)) {
    if (isObject(s) && asString(s.setting_key)) out[s.setting_key as string] = asBool(s.active);
  }
  return out;
}

const metricsOf = (section: unknown): string[] =>
  asArray(isObject(section) ? section.metrics : null).flatMap((m) => (isObject(m) && asString(m.metric) ? [m.metric as string] : []));

/** GET /home-service/v2/home/dashboard/customize: the user's gauges are slots 1 and 3. */
export function projectDashboard(raw: unknown) {
  const r = isObject(raw) ? raw : {};
  const gauges = asArray(r.gauge_metrics)
    .flatMap((g) => (isObject(g) && asString(g.metric) ? [{ index: asNumber(g.index) ?? -1, metric: g.metric as string }] : []))
    .sort((a, b) => a.index - b.index);
  const fixed = FIXED_GAUGES as readonly string[];
  const user = gauges.filter((g) => g.index === 1 || g.index === 3);
  return {
    gauges: (user.length > 0 ? user : gauges.filter((g) => !fixed.includes(g.metric))).map((g) => g.metric),
    pinned: metricsOf(r.pinned_metrics_section),
  };
}

export interface BehaviorToggle {
  id: number;
  title: string | null;
  internal_name: string | null;
  question: string | null;
  custom: boolean;
  selected: boolean;
}

/**
 * GET /journal-service/v3/journals/behaviors (the app's customize-journal
 * screen) → every behaviour with its `selected` flag: the tracked set.
 * `GET /activities-service/v1/journals/behaviors/user` is NOT the tracked set:
 * it lists stock behaviours only, so a tracked custom behaviour is missing
 * from it (verified live 2026-11-21: 309 there, 310 selected here).
 * `complete` is false when there are no toggles or one lacks a boolean `selected`.
 */
export function projectBehaviorToggles(raw: unknown) {
  const toggles: BehaviorToggle[] = [];
  const seen = new Set<number>();
  let complete = true;
  for (const group of asArray(isObject(raw) ? raw.grouped_toggles : null)) {
    for (const t of asArray(isObject(group) ? group.toggles : null)) {
      const id = isObject(t) ? asNumber(t.id) : null;
      if (!isObject(t) || id === null || !Number.isInteger(id) || typeof t.selected !== "boolean") {
        complete = false;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      toggles.push({
        id,
        title: asString(t.title),
        internal_name: asString(t.internal_name),
        question: asString(t.subtitle),
        custom: t.custom === true || !BEHAVIORS_BY_ID.has(id),
        selected: t.selected,
      });
    }
  }
  const tracked = toggles.filter((t) => t.selected);
  return {
    toggles,
    ids: tracked.map((t) => t.id),
    count: tracked.length,
    custom_count: tracked.filter((t) => t.custom).length,
    complete: complete && toggles.length > 0,
  };
}

export type ZoneId = "ZONE_0" | "ZONE_1" | "ZONE_2" | "ZONE_3" | "ZONE_4" | "ZONE_5";
export interface ZoneRow { id: ZoneId; min: number; max: number }
/** HR zones as the write tool works with them; `hrZonesOut` makes the compact output. */
export interface HrZonesState {
  max_hr: number | null;
  resting_hr: number | null;
  is_custom: boolean | null;
  zones: ZoneRow[];
  default_zones: ZoneRow[];
}
const ZONE_IDS: readonly string[] = ["ZONE_0", "ZONE_1", "ZONE_2", "ZONE_3", "ZONE_4", "ZONE_5"];

function zoneRows(list: unknown): ZoneRow[] {
  return asArray(list)
    .flatMap((z) => {
      if (!isObject(z)) return [];
      const id = asString(z.id);
      const min = asNumber(z.min);
      const max = asNumber(z.max);
      return id && ZONE_IDS.includes(id) && min !== null && max !== null ? [{ id: id as ZoneId, min: Math.round(min), max: Math.round(max) }] : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * GET /hr-zones-service/v1/bff/zones + /bff/settings. `is_custom` lives only in
 * settings (`manual_heart_rate_zones_form.toggle_value`); the effective zones
 * are the settings form rows, with ZONE_0 from bff/zones.
 */
export function parseHrZones(input: { zones: unknown; settings: unknown }): HrZonesState {
  const zones = isObject(input.zones) ? input.zones : {};
  const settings = isObject(input.settings) ? input.settings : {};
  let maxHr: number | null = null;
  let restingHr: number | null = null;
  for (const row of asArray(settings.heart_rate_entry_row)) {
    if (!isObject(row)) continue;
    if (row.id === "MAX_HR") maxHr = asNumber(row.value);
    if (row.id === "RESTING_HR") restingHr = asNumber(row.value);
  }
  const form = isObject(settings.manual_heart_rate_zones_form) ? settings.manual_heart_rate_zones_form : null;
  const fromZones = zoneRows(zones.zones);
  const fromForm = zoneRows(form?.zone_rows);
  const effective = fromForm.length === 5 ? [...fromZones.filter((z) => z.id === "ZONE_0"), ...fromForm] : fromZones;
  return {
    max_hr: maxHr === null ? null : Math.round(maxHr),
    resting_hr: restingHr === null ? null : Math.round(restingHr),
    is_custom: form ? asBool(form.toggle_value) : null,
    zones: effective,
    default_zones: zoneRows(settings.default_hr_zones),
  };
}

const zoneMap = (rows: ZoneRow[]): Record<string, [number, number]> =>
  Object.fromEntries(rows.map((z) => [z.id.replace("ONE_", ""), [z.min, z.max]]));

/** Compact output: {Z0: [min, max], …}; defaults only when the zones are custom. */
export function hrZonesOut(state: HrZonesState): HrZonesV2OutT {
  return {
    max_hr: state.max_hr,
    resting_hr: state.resting_hr,
    is_custom: state.is_custom,
    zones: zoneMap(state.zones),
    defaults: state.is_custom && state.default_zones.length > 0 ? zoneMap(state.default_zones) : null,
  };
}
