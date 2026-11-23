// whoop_profile projections (SPEC.md §4.8 profile, §4.11 integrations/privacy).
// The profile-edit screen is the source of truth for PUT-format fields;
// bootstrap fills the rest (bio data, membership, timezone).
import { asArray, asBool, asNumber, asString, isObject } from "../lib/walk.js";
import { decodePrivacyPillar } from "../lib/profile_settings.js";

/** The PUT-format profile fields from GET /profile-service/v1/profile/bff/edit. */
export interface EditableProfile {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  birthday: string | null;
  gender: string | null;
  physiological_baseline: string | null;
  height: number | null;
  weight: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  unit_system: string | null;
  locked_fields: string[];
}

export function parseProfileEdit(raw: unknown): EditableProfile | null {
  if (!isObject(raw)) return null;
  const birthday = asString(raw.birthday);
  return {
    first_name: asString(raw.first_name),
    last_name: asString(raw.last_name),
    email: asString(raw.email),
    birthday: birthday ? birthday.slice(0, 10) : null,
    gender: asString(raw.gender),
    physiological_baseline: asString(raw.physiological_baseline),
    height: asNumber(raw.height),
    weight: asNumber(raw.weight),
    city: asString(raw.city),
    state: asString(raw.state),
    country: asString(raw.country),
    unit_system: asString(raw.unit_system),
    locked_fields: asArray(raw.locked_fields).filter((f): f is string => typeof f === "string"),
  };
}

const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {});

export function projectProfileV2(input: {
  bootstrap: unknown;
  edit: unknown;
  hidden: Record<string, unknown>;
  stealth: unknown;
}) {
  const boot = obj(input.bootstrap);
  const user = obj(boot.user);
  const account = obj(boot.account);
  const profile = obj(boot.profile);
  const bio = obj(boot.bio_data);
  const edit = parseProfileEdit(input.edit);
  const bootBirthday = asString(profile.birthday);
  return {
    user_id: asNumber(user.id) ?? asNumber(account.user_id),
    first_name: edit?.first_name ?? asString(user.first_name),
    last_name: edit?.last_name ?? asString(user.last_name),
    email: edit?.email ?? asString(account.email),
    birthday: edit?.birthday ?? (bootBirthday ? bootBirthday.slice(0, 10) : null),
    // Bootstrap's gender is a display string ("i prefer not to choose") and its
    // baseline is always null; only bff/edit has the PUT enums.
    gender: edit?.gender ?? null,
    physiological_baseline: edit?.physiological_baseline ?? null,
    height_m: edit?.height ?? asNumber(profile.height),
    weight_kg: edit?.weight ?? asNumber(profile.weight),
    unit_system: edit?.unit_system ?? asString(profile.unit_system),
    city: edit?.city ?? asString(user.city),
    state: edit?.state ?? asString(user.admin_division),
    country: edit?.country ?? asString(user.country),
    tz_offset: asString(profile.timezone_offset),
    max_hr: asNumber(bio.max_heart_rate),
    resting_hr: asNumber(bio.resting_heart_rate),
    fitness_level: asString(profile.fitness_level),
    membership: asString(obj(boot.membership).status),
    hidden_metrics: Object.entries(input.hidden).filter(([, v]) => isObject(v) && v.is_hidden === true).map(([k]) => k),
    // GET /users-service/v1/stealth-mode answers a bare JSON boolean.
    stealth: typeof input.stealth === "boolean" ? input.stealth : isObject(input.stealth) ? asBool(input.stealth.enabled) : null,
    locked_fields: edit?.locked_fields ?? [],
  };
}

/** GET /entitlement-service/v1/entitlements → count on, and why each one is off. */
export function projectEntitlements(raw: unknown) {
  const map = obj(obj(raw).entitlements);
  let on = 0;
  const off: Record<string, string> = {};
  for (const [feature, value] of Object.entries(map)) {
    if (!isObject(value)) continue;
    if (value.entitled === true) { on++; continue; }
    off[feature] = asArray(value.reasons).flatMap((r) => {
      if (!isObject(r)) return [];
      const required = asString(r.required_value) ?? "?";
      return [`${asString(r.reason_type) ?? "REASON"}: needs ${required.length > 30 ? `${required.slice(0, 30)}…` : required} (has ${asString(r.current_value) ?? "?"})`];
    }).join("; ") || "not entitled";
  }
  return { on, off };
}

/**
 * GET /integrations-bff/v1/integrations/discovery. Only names and the connected
 * flag are projected, so OAuth URLs and state nonces (S24) never reach output.
 */
export function projectIntegrations(raw: unknown) {
  const connected: string[] = [];
  const available: string[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isObject(node)) return;
    if (typeof node.connected === "boolean" && (asString(node.title_display) || asString(node.reporting_key))) {
      const name = asString(node.title_display) ?? asString(node.reporting_key)!;
      const key = asString(node.id) ?? name;
      if (!seen.has(key)) {
        seen.add(key);
        (node.connected ? connected : available).push(name);
      }
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(raw);
  return { connected, available };
}

const VISIBILITY_FIELDS: Record<string, string> = {
  community_list_visibility: "community_list",
  age_visibility: "age",
  region_visibility: "region",
  data_highlights: "data_highlights",
  activity_summary: "activity_summary",
  healthspan: "healthspan",
  achievements: "achievements",
  moments_on_profile: "moments",
};

const pillar = (v: unknown) => {
  const d = decodePrivacyPillar(asString(v));
  return d ? { to: d.audience, trends: d.trends, daily: d.daily_stats } : null;
};

/** GET /privacy-service/v1/community/privacy/settings, with the composite pillar strings decoded. */
export function projectPrivacy(raw: unknown) {
  const r = obj(raw);
  const visibility: Record<string, string> = {};
  for (const [field, key] of Object.entries(VISIBILITY_FIELDS)) {
    const v = asString(r[field]);
    if (v) visibility[key] = v;
  }
  const deviations = obj(r.activity_type_sharing_deviations);
  const overrides: Record<string, string> = {};
  for (const [sport, v] of Object.entries(deviations)) if (typeof v === "string") overrides[sport] = v;
  return {
    searchable: asBool(r.searchable),
    mutual_sharing: asBool(r.mutual_community_sharing),
    visibility,
    sleep: pillar(r.sleep),
    recovery: pillar(r.recovery),
    strain: pillar(r.strain),
    activity_overrides: Object.keys(overrides).length > 0 ? overrides : null,
  };
}
