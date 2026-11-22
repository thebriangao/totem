// AUTO-GENERATED from whoop-testing/probes/2026-11-21/endpoints.json (live probe run, 2026-11-21, plus the
// heart-rate and bulk-history endpoints checked live the same day; the last block is @Acetone1's Android
// routes, checked on the test account on 2026-11-22).
// Do not edit by hand. Paths are templated; no real identifiers. Verdicts:
//   verified = worked live and was read back; not-found / server-error-500 / service-only-401 = do not use.
export interface EndpointEntry {
  method: string;
  path: string;
  domain: string;
  verdict: string;
  tools: readonly string[];
  notes: string;
}

export const ENDPOINT_CATALOG: readonly EndpointEntry[] = [
  {
    "method": "GET",
    "path": "/activities-service/v1/activity-types",
    "domain": "activities",
    "verdict": "not-found",
    "tools": [],
    "notes": "404"
  },
  {
    "method": "GET",
    "path": "/activities-service/v1/cycles/aggregate/range/{user_id}",
    "domain": "activities",
    "verdict": "not-found",
    "tools": [],
    "notes": "legacy list gone"
  },
  {
    "method": "GET",
    "path": "/activities-service/v1/sports",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop://catalog/sports"
    ],
    "notes": "205 current sports {id=sport_id, name, activity_type_internal_name, is_current}; new 336–346"
  },
  {
    "method": "GET",
    "path": "/activities-service/v1/sports/history",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop://catalog/sports"
    ],
    "notes": "214 incl. non-current -1,50,54,58,67,68,69,72,116 (rejected by create)"
  },
  {
    "method": "GET",
    "path": "/activities-service/v2/activities",
    "domain": "activities",
    "verdict": "not-found",
    "tools": [],
    "notes": "?start&end → 404; no collection GET"
  },
  {
    "method": "POST",
    "path": "/activities-service/v2/activities",
    "domain": "activities",
    "verdict": "verified",
    "tools": [],
    "notes": "Any type; 409 plain text 'Overlapping activity found for user'; not needed"
  },
  {
    "method": "DELETE",
    "path": "/activities-service/v2/activities/{id}",
    "domain": "activities",
    "verdict": "service-only-401",
    "tools": [],
    "notes": "401 'Authorization was not valid' even after refresh (2ebbff38); activity untouched"
  },
  {
    "method": "GET",
    "path": "/activities-service/v2/activities/{id}",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop_activity_edit",
      "whoop_activity_log"
    ],
    "notes": "Raw record; only place with live score_state (incomplete/complete); version, during, type"
  },
  {
    "method": "GET",
    "path": "/activities-service/v2/activity-types",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop://catalog/sports",
      "whoop_activity_log",
      "whoop_activity_edit"
    ],
    "notes": "208 types {internal_name, display_name, category, score_type, has_gps, msk_linkable}; no sport_id; 'cheeerleading ' typo (don't trim)"
  },
  {
    "method": "POST",
    "path": "/core-details-bff/v0/create-activity",
    "domain": "activities",
    "verdict": "verified",
    "tools": [],
    "notes": "Legacy live Start/Stop (today's totem body). Non-current sport_id → 400; unknown sport_id → HTML 500. Superseded by v2 create."
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v1/activity-score-type",
    "domain": "activities",
    "verdict": "verified-quirky",
    "tools": [],
    "notes": "RECOVERY → {score_type:RECOVERY}; CARDIO/SLEEP → 400; deleted/nonexistent → {score_type:CARDIO}. Don't use."
  },
  {
    "method": "DELETE",
    "path": "/core-details-bff/v1/cardio-details",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop_activity_delete"
    ],
    "notes": "204 for every CARDIO/RECOVERY type and create path; re-delete → 404 text; not tried on SLEEP"
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v1/cardio-details",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop_workouts",
      "whoop_lift_sessions",
      "whoop_activity_edit",
      "whoop_activity_delete"
    ],
    "notes": "200 for CARDIO/RECOVERY in any state ('---' while unscored); 400 'Cannot view activity details for a pending activity' for pending SLEEP; details_edit_components, link_workout_option_enabled, weightlifting_cardio_details"
  },
  {
    "method": "DELETE",
    "path": "/core-details-bff/v1/recovery-details",
    "domain": "activities",
    "verdict": "verified",
    "tools": [],
    "notes": "204 on RECOVERY and CARDIO; redundant"
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v1/recovery-details",
    "domain": "activities",
    "verdict": "not-found",
    "tools": [],
    "notes": "405"
  },
  {
    "method": "PUT",
    "path": "/core-details-bff/v1/recovery-details",
    "domain": "activities",
    "verdict": "verified",
    "tools": [],
    "notes": "Same effect as v2 cardio-details PUT, flat record; works on RECOVERY and CARDIO; redundant"
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v2/activity-type/user-created",
    "domain": "activities",
    "verdict": "verified",
    "tools": [],
    "notes": "recently used types; optional"
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v2/cardio-details",
    "domain": "activities",
    "verdict": "not-found",
    "tools": [],
    "notes": "405"
  },
  {
    "method": "PUT",
    "path": "/core-details-bff/v2/cardio-details",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop_activity_edit"
    ],
    "notes": "Edit times/type for any type incl. CARDIO↔RECOVERY and nap→sleep; sleep→nap silently refused. 400 bounds; 404; 409 empty list; 412 retry; unknown type → 500 empty."
  },
  {
    "method": "POST",
    "path": "/core-details-bff/v2/create-activity",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop_activity_log"
    ],
    "notes": "Any v2 type incl. RECOVERY and nap/sleep. 400 unknown name / bad window / no-ms timestamp; 409 structured overlap list; 422 missing field (empty). Future times accepted (→ undeletable cycle). Main sleep re-cycles the day"
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v2/recovery-details",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop_workouts"
    ],
    "notes": "RECOVERY detail (MINUTES, MIN/AVG HR); CARDIO id → 400 'not a recovery activity'"
  },
  {
    "method": "GET",
    "path": "/strap-location-service/v1/garment",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop://catalog/garments"
    ],
    "notes": "garment ids 1,2,3,6,7,9,10,11,12–15 (12–15 GEN_4 only); garment_id is optional and unvalidated on writes"
  },
  {
    "method": "POST",
    "path": "/ai-conversation-bff/v1/conversation",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_coach_ask",
      "whoop_coach_history"
    ],
    "notes": "Create/reopen keyed by fingerprint. Reopen of listed fp: no side effects. Unlisted fp: creates; daily-outlook___cycle___{id}/day-in-review___cycle___{id} GENERATES."
  },
  {
    "method": "DELETE",
    "path": "/ai-conversation-bff/v1/conversation/{fingerprint}",
    "domain": "ai",
    "verdict": "verified",
    "tools": [],
    "notes": "204; UUID alias entry needs own DELETE; not wrapped in v2.0"
  },
  {
    "method": "GET",
    "path": "/ai-conversation-bff/v1/conversation/{fingerprint}/suggestions",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_coach_ask"
    ],
    "notes": "{suggestions[]}"
  },
  {
    "method": "POST",
    "path": "/ai-conversation-bff/v1/conversation/{fingerprint}/turn",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_coach_ask"
    ],
    "notes": "Address by fingerprint (UUID works but creates phantom list entry). 409 while a turn is ACTIVE."
  },
  {
    "method": "GET",
    "path": "/ai-conversation-bff/v1/conversation/{fingerprint}/turn/{turnId}",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_coach_ask",
      "whoop_coach_history"
    ],
    "notes": "ONLY by fingerprint (UUID/list id → HTML 404). Poll until COMPLETE; join all MARKDOWN_CHAT_TEXT across assistant messages."
  },
  {
    "method": "POST",
    "path": "/ai-conversation-bff/v1/conversation/{fingerprint}/turn/{turnId}/seen",
    "domain": "ai",
    "verdict": "verified",
    "tools": [],
    "notes": "read receipt; never send (also /end-seen, /{fp}/last-viewed-turn)"
  },
  {
    "method": "GET",
    "path": "/ai-conversation-bff/v1/conversations",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_coach_history"
    ],
    "notes": "grouped by day; entry id ≠ metadata.id; only conversations with a user turn + outlooks"
  },
  {
    "method": "POST",
    "path": "/ai-conversation-bff/v1/files",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_coach_ask"
    ],
    "notes": "→ {file_id:'<uuid>.png', size}; attach via turn file_ids"
  },
  {
    "method": "DELETE",
    "path": "/ai-conversation-bff/v1/files/{file_id}",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_coach_ask"
    ],
    "notes": "204; deleted id silently dropped if re-attached"
  },
  {
    "method": "GET",
    "path": "/ai-conversation-bff/v1/files/{file_id}",
    "domain": "ai",
    "verdict": "not-found",
    "tools": [],
    "notes": "405"
  },
  {
    "method": "GET",
    "path": "/ai-conversation-bff/v1/recommendation-widget",
    "domain": "ai",
    "verdict": "verified",
    "tools": [],
    "notes": "RECOMMENDATION_TILEs; deferred"
  },
  {
    "method": "POST",
    "path": "/ai-conversation-bff/v1/recommendations/generate-alternatives",
    "domain": "ai",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "seen in widget; not called"
  },
  {
    "method": "POST",
    "path": "/ai-conversation-bff/v1/recommendations/{id}/commit",
    "domain": "ai",
    "verdict": "verified",
    "tools": [],
    "notes": "no body; COMMITTED; no visible side effect; deferred"
  },
  {
    "method": "POST",
    "path": "/ai-conversation-bff/v1/recommendations/{id}/uncommit",
    "domain": "ai",
    "verdict": "verified",
    "tools": [],
    "notes": "no body; UNCOMMITTED; deferred"
  },
  {
    "method": "GET",
    "path": "/ai-conversation-service/v1/settings",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_preferences"
    ],
    "notes": "WHOOP_COACH, _DATA, _CONCISE, _MEMORY"
  },
  {
    "method": "PUT",
    "path": "/ai-conversation-service/v1/settings",
    "domain": "ai",
    "verdict": "verified",
    "tools": [
      "whoop_memory_set"
    ],
    "notes": "memory off → coach still claims to remember but stores nothing"
  },
  {
    "method": "POST",
    "path": "/auth-service/v3/whoop/",
    "domain": "auth",
    "verdict": "decided",
    "tools": [
      "(client: token_manager)"
    ],
    "notes": "Cognito proxy. x-amz-target AWSCognitoIdentityProviderService.InitiateAuth, AuthFlow REFRESH_TOKEN_AUTH, ClientId 37365lrcda1js3fapqfe2n40eh. Refresh token rotates every call: persist before use. USER_PASSWORD_AUTH needs"
  },
  {
    "method": "GET",
    "path": "/community-service/v1/communities/memberships",
    "domain": "community",
    "verdict": "not-probed",
    "tools": [
      "whoop_community"
    ],
    "notes": "Probes excluded social; capture says works. Own memberships only (D9)."
  },
  {
    "method": "GET",
    "path": "/community-service/v1/leaderboards/communities/{communityId}/{window}/{metric}/{kind}/user/{own_user_id}",
    "domain": "community",
    "verdict": "not-probed",
    "tools": [
      "whoop_community"
    ],
    "notes": "Own leaderboard row only (D9); never the full board"
  },
  {
    "method": "GET",
    "path": "/developer/v2/activity/sleep",
    "domain": "developer",
    "verdict": "verified",
    "tools": [],
    "notes": "200 records:[] (only scored records; account has none); shape unverified live"
  },
  {
    "method": "GET",
    "path": "/developer/v2/activity/workout",
    "domain": "developer",
    "verdict": "verified",
    "tools": [],
    "notes": "Works with web token but OMITS pending/incomplete cardio; RECOVERY as SCORED score:null; app never calls it. Off by default (D1)."
  },
  {
    "method": "GET",
    "path": "/developer/v2/activity/workout/{id}",
    "domain": "developer",
    "verdict": "not-found",
    "tools": [],
    "notes": "404"
  },
  {
    "method": "GET",
    "path": "/developer/v2/cycle",
    "domain": "developer",
    "verdict": "verified",
    "tools": [],
    "notes": "cycle records incl. undocumented step_count"
  },
  {
    "method": "GET",
    "path": "/developer/v2/recovery",
    "domain": "developer",
    "verdict": "verified",
    "tools": [],
    "notes": "200 records:[]; shape unverified live"
  },
  {
    "method": "GET",
    "path": "/developer/v2/user/measurement/body",
    "domain": "developer",
    "verdict": "verified",
    "tools": [],
    "notes": "{height_meter, weight_kilogram, max_heart_rate}"
  },
  {
    "method": "GET",
    "path": "/developer/v2/user/profile/basic",
    "domain": "developer",
    "verdict": "verified",
    "tools": [],
    "notes": "{user_id, email, first_name, last_name}"
  },
  {
    "method": "GET",
    "path": "/advanced-labs-service/v1/advanced-labs",
    "domain": "health",
    "verdict": "verified",
    "tools": [],
    "notes": "upsell-only BFF without results; no whoop_labs in v2.0"
  },
  {
    "method": "GET",
    "path": "/activities-service/v1/user-state",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_now",
      "whoop_day"
    ],
    "notes": "{latestMetricsProcessed, source, startAt, state idle|workout, activity, trackedSleep}"
  },
  {
    "method": "GET",
    "path": "/coaching-service/v1/health/bff/monitor",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_recovery"
    ],
    "notes": "KEY_METRIC_TILE ids RESPIRATORY_RATE|BLOOD_OXYGEN|RHR|HRV|SKIN_TEMPERATURE_FAHRENHEIT; analytics{ranges}; today only; skin temp is °F deviation"
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v1/start-activity/strain",
    "domain": "home",
    "verdict": "verified",
    "tools": [],
    "notes": "cycle strain + optimal strain mapping for Start Activity screen"
  },
  {
    "method": "GET",
    "path": "/entitlement-service/v1/entitlements",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "entitlements{feature:{entitled, reasons[]}}, context{current_membership_tier}; explains 'feature unavailable'"
  },
  {
    "method": "GET",
    "path": "/health-service/v2/stress-bff/{date}",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_stress",
      "whoop_now"
    ],
    "notes": "~145 KB; stress_state, gauge, graphs, sessions, trend_list"
  },
  {
    "method": "GET",
    "path": "/health-service/v2/stress-bff/{date}/calendar",
    "domain": "home",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "500 on test account (200 in May capture); account-specific or global unknown"
  },
  {
    "method": "GET",
    "path": "/health-tab-bff/v1/health-tab",
    "domain": "home",
    "verdict": "verified",
    "tools": [],
    "notes": "healthspan hero (locked), monitor tile, stress card, menstrual tile; no live-HR tile (live HR is BLE) → whoop_live_hr dropped"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/calendar/overview",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_calendar",
      "whoop_workouts"
    ],
    "notes": "byte-identical to recovery; use has_data to prune per-day walks. days_of_month[{date_value_display, has_data, cycle_id, day_state}]; no full date; future days can show has_data"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/calendar/recovery",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_calendar"
    ],
    "notes": "states LOW/MEDIUM/HIGH_RECOVERY|NO_DATA. days_of_month[{date_value_display, has_data, cycle_id, day_state}]; no full date; future days can show has_data"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/calendar/sleep",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_calendar"
    ],
    "notes": "HIGH_SLEEP|NO_DATA observed; LOW_SLEEP inferred. days_of_month[{date_value_display, has_data, cycle_id, day_state}]; no full date; future days can show has_data"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/calendar/strain",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_calendar"
    ],
    "notes": "states LOW_STRAIN|HIGH_STRAIN|NO_DATA. days_of_month[{date_value_display, has_data, cycle_id, day_state}]; no full date; future days can show has_data"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/deep-dive/recovery",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_recovery",
      "whoop_day"
    ],
    "notes": "SCORE_GAUGE, STEPPER (calibration filled/total), CONTRIBUTORS_TILE_{HRV,RHR,RESPIRATORY_RATE,SLEEP_PERFORMANCE}"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/deep-dive/recovery/trends",
    "domain": "home",
    "verdict": "verified",
    "tools": [],
    "notes": "mini weekly GRAPHING_CARDs"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/deep-dive/sleep",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_sleep"
    ],
    "notes": "SLEEP_SCORE_GAUGE, contributors; no activity ids"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/deep-dive/sleep/last-night",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_sleep",
      "whoop_activity_edit"
    ],
    "notes": "date = cycle day the main sleep opens; header_section.destination ACTIVITY_EDIT {activity_id,start_time,end_time}; null if no main sleep; naps never here"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/deep-dive/sleep/trends",
    "domain": "home",
    "verdict": "verified",
    "tools": [],
    "notes": "GRAPHING_CARD_* tiles"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/deep-dive/strain",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_strain",
      "whoop_day"
    ],
    "notes": "ACTIVITY items CARDIO only (RECOVERY omitted), includes pending; contributors zones/strength/steps"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/deep-dive/strain/trends",
    "domain": "home",
    "verdict": "verified",
    "tools": [],
    "notes": "mini weekly GRAPHING_CARDs"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/home",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_day",
      "whoop_sleep",
      "whoop_workouts",
      "whoop_lift_sessions",
      "whoop_coach_history"
    ],
    "notes": "metadata.cycle_metadata (cycle_id unstable), gauges, KEY_STATISTIC by trend_key, ACTIVITY items {activity_v2_id, type CARDIO|RECOVERY|SLEEP, status, during}; sport_id always -1. Card lists the cycle's activities."
  },
  {
    "method": "GET",
    "path": "/home-service/v1/tilt-view",
    "domain": "home",
    "verdict": "verified",
    "tools": [],
    "notes": "full-day HR line plot; activity ids only as OVERLAY_PLOT labels"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/widget/overview",
    "domain": "home",
    "verdict": "verified",
    "tools": [
      "whoop_now"
    ],
    "notes": "~446 B score strings; cheapest scores read"
  },
  {
    "method": "GET",
    "path": "/home-service/v2/home",
    "domain": "home",
    "verdict": "not-found",
    "tools": [],
    "notes": "404; no v2 home"
  },
  {
    "method": "GET",
    "path": "/integrations-bff/v1/integrations/discovery",
    "domain": "integrations",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "11 integrations {id, reporting_key, connected}"
  },
  {
    "method": "GET",
    "path": "/integrations-bff/v1/integrations/{id}/details",
    "domain": "integrations",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "strava → 500, apple-health → 404. STRIP connection_url (live OAuth + state nonce)"
  },
  {
    "method": "GET",
    "path": "/integrations-bff/v2/integrations/{id}/details",
    "domain": "integrations",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "peloton and zwift only; connection_sections; strip cta_connection_url"
  },
  {
    "method": "GET",
    "path": "/social-service/v1/strava/bff/settings",
    "domain": "integrations",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "state; strip authorization URLs"
  },
  {
    "method": "GET",
    "path": "/activities-service/v1/journals/behaviors/user",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_preferences",
      "whoop_preferences_set"
    ],
    "notes": "same data + total_count"
  },
  {
    "method": "PUT",
    "path": "/activities-service/v1/journals/behaviors/user",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "Full tracked set (replace); untracking keeps old answers"
  },
  {
    "method": "GET",
    "path": "/activities-service/v1/journals/stats/user/{user_id}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_journal"
    ],
    "notes": "yes/no counts per behavior (own id)"
  },
  {
    "method": "GET",
    "path": "/ai-conversation-bff/v1/widget/journal/custom-behavior-proposal",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "proposal card (EDITABLE)"
  },
  {
    "method": "PUT",
    "path": "/ai-conversation-bff/v1/widget/journal/custom-behavior-proposal/commit/{proposalId}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "Creates a PERMANENT custom behavior (body {}; POST 405; no body 422). Not wrapped."
  },
  {
    "method": "PUT",
    "path": "/ai-conversation-bff/v1/widget/journal/custom-behavior-proposal/uncommit/{proposalId}",
    "domain": "journal",
    "verdict": "not-found",
    "tools": [],
    "notes": "404"
  },
  {
    "method": "GET",
    "path": "/autopop-service/v1/autopop/JOURNAL/{cycle_id}",
    "domain": "journal",
    "verdict": "not-found",
    "tools": [],
    "notes": "405"
  },
  {
    "method": "PUT",
    "path": "/autopop-service/v1/autopop/JOURNAL/{cycle_id}",
    "domain": "journal",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "204 with/without {} body; no visible effect; tool dropped"
  },
  {
    "method": "GET",
    "path": "/behavior-impact-service/v1/impact",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_behavior_impact"
    ],
    "notes": "new accounts nest member-average impact_cards under HEADER_ITEMS_CARD; walk recursively"
  },
  {
    "method": "GET",
    "path": "/behavior-impact-service/v1/impact/details/{uuid}",
    "domain": "journal",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "same 400"
  },
  {
    "method": "GET",
    "path": "/behavior-impact-service/v1/impact/journal-trends/{uuid}",
    "domain": "journal",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "500 for non-user uuid"
  },
  {
    "method": "GET",
    "path": "/behavior-impact-service/v1/impact/summary-card/{date}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_behavior_impact"
    ],
    "notes": "summary card"
  },
  {
    "method": "GET",
    "path": "/behavior-impact-service/v2/impact/details/{uuid}",
    "domain": "journal",
    "verdict": "exists-but-unclear",
    "tools": [
      "whoop_behavior_impact"
    ],
    "notes": "400 'Requested impact not found.' for member-average uuids; personal payload unverified live"
  },
  {
    "method": "POST",
    "path": "/journal-service/v1/journals/behaviors",
    "domain": "journal",
    "verdict": "service-only-401",
    "tools": [],
    "notes": "401"
  },
  {
    "method": "GET",
    "path": "/journal-service/v1/journals/behaviors/{id}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "single tracker; works for custom ids"
  },
  {
    "method": "POST",
    "path": "/journal-service/v1/journals/behaviors/{id}",
    "domain": "journal",
    "verdict": "not-found",
    "tools": [],
    "notes": "405 (DELETE too)"
  },
  {
    "method": "PUT",
    "path": "/journal-service/v1/journals/behaviors/{id}",
    "domain": "journal",
    "verdict": "service-only-401",
    "tools": [],
    "notes": "401 even with valid session (1f70f0ff)"
  },
  {
    "method": "GET",
    "path": "/journal-service/v1/journals/preferences",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_preferences"
    ],
    "notes": "{journal_enabled, journal_autopop_enabled, ai_autopop_enabled, …}"
  },
  {
    "method": "PUT",
    "path": "/journal-service/v1/journals/preferences",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "Merges keys; journal_enabled required (422 otherwise)"
  },
  {
    "method": "GET",
    "path": "/journal-service/v1/widget/talk-text/{date}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "journal-agent entry; isIntraday=false points at yesterday"
  },
  {
    "method": "PUT",
    "path": "/journal-service/v2/journal/entry/partial",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_journal_log"
    ],
    "notes": "Merge across rows, replace within row; bare row clears; notes ignored; multi-date; 400 'Cannot log menstruation and ovulation at the same time' when 43+79 yes in one request."
  },
  {
    "method": "GET",
    "path": "/journal-service/v2/journals/behaviors",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "308 records = totem bundle; excludes 171 and customs"
  },
  {
    "method": "GET",
    "path": "/journal-service/v2/journals/behaviors/user/{date}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop://catalog/behaviors",
      "whoop_journal",
      "whoop_journal_log"
    ],
    "notes": "309 incl. 171 + custom; full trackers with magnitude specs"
  },
  {
    "method": "PUT",
    "path": "/journal-service/v2/journals/entries/user/date/{date}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_journal_log"
    ],
    "notes": "Replace-all: unlisted rows deleted; omitted/'' notes → null. 400 text, atomic. One 204 didn't land during cycle reshuffle: read back."
  },
  {
    "method": "GET",
    "path": "/journal-service/v3/journals/behaviors",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "customize-journal BFF (toggles, custom flag, custom_behaviors_widget)"
  },
  {
    "method": "GET",
    "path": "/journal-service/v3/journals/date-picker/{date}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "per-day status + fill_ratio"
  },
  {
    "method": "GET",
    "path": "/journal-service/v3/journals/drafts/mobile/{date}",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_journal",
      "whoop_journal_log"
    ],
    "notes": "tracked_behaviors[{behavior_tracker, tracker_input}], notes (null when empty), cycle_id (may change), keyed by date"
  },
  {
    "method": "GET",
    "path": "/journal-service/v3/journals/home-tile",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "400 without date"
  },
  {
    "method": "POST",
    "path": "/journal-service/{v1,v3}/journals/behaviors/custom",
    "domain": "journal",
    "verdict": "not-found",
    "tools": [],
    "notes": "custom-behavior REST create/edit/delete: 12 guesses (405/404/401); none exist. Delete = untrack."
  },
  {
    "method": "GET",
    "path": "/context-hub-bff/v1/context-hub",
    "domain": "memory",
    "verdict": "verified",
    "tools": [],
    "notes": "landing LIST (talk-text widget, snapshot tiles, filtered list path)"
  },
  {
    "method": "DELETE",
    "path": "/context-hub-bff/v1/context-hub/context-detail/{id}",
    "domain": "memory",
    "verdict": "verified",
    "tools": [
      "whoop_memory_set"
    ],
    "notes": "204 permanent"
  },
  {
    "method": "GET",
    "path": "/context-hub-bff/v1/context-hub/context-detail/{id}",
    "domain": "memory",
    "verdict": "verified",
    "tools": [
      "whoop_memory"
    ],
    "notes": "MARKS ITEM SEEN (read receipt); deleted id → 500 HTML"
  },
  {
    "method": "PUT",
    "path": "/context-hub-bff/v1/context-hub/context-detail/{id}/status",
    "domain": "memory",
    "verdict": "verified",
    "tools": [
      "whoop_memory_set"
    ],
    "notes": "204"
  },
  {
    "method": "GET",
    "path": "/context-hub-bff/v1/context-hub/items",
    "domain": "memory",
    "verdict": "verified",
    "tools": [
      "whoop_memory"
    ],
    "notes": "CONTEXT_CARDs; dynamic categories; no pagination"
  },
  {
    "method": "GET",
    "path": "/achievements-service/v1/progression",
    "domain": "milestones",
    "verdict": "verified",
    "tools": [],
    "notes": "static 2021 level table, not user progress. Don't use."
  },
  {
    "method": "GET",
    "path": "/milestones-service/v1/bff/milestones/hub",
    "domain": "milestones",
    "verdict": "verified",
    "tools": [
      "whoop_milestones"
    ],
    "notes": "counts + tag grids (all, sleep, recovery, strain, healthspan, other, activities)"
  },
  {
    "method": "GET",
    "path": "/milestones-service/v1/bff/milestones/{type}/details",
    "domain": "milestones",
    "verdict": "verified",
    "tools": [
      "whoop_milestones"
    ],
    "notes": "progress card + earned grid; unknown type → 400 text"
  },
  {
    "method": "GET",
    "path": "/milestones-service/v1/bff/milestones/{type}/pill",
    "domain": "milestones",
    "verdict": "verified",
    "tools": [],
    "notes": "lottie pill + count"
  },
  {
    "method": "GET",
    "path": "/streaks-service/v1/bff/streaks/data-streak",
    "domain": "milestones",
    "verdict": "verified",
    "tools": [
      "whoop_milestones"
    ],
    "notes": "streak detail (started, max, week tracker)"
  },
  {
    "method": "GET",
    "path": "/streaks-service/v1/bff/streaks/data-streak/share",
    "domain": "milestones",
    "verdict": "verified",
    "tools": [],
    "notes": "share assets"
  },
  {
    "method": "GET",
    "path": "/streaks-service/v1/streaks/data-streak",
    "domain": "milestones",
    "verdict": "verified",
    "tools": [
      "whoop_milestones"
    ],
    "notes": "{streak_value, streak_state}"
  },
  {
    "method": "GET",
    "path": "/app-configuration-service/v1/config",
    "domain": "misc",
    "verdict": "verified",
    "tools": [],
    "notes": "tab config"
  },
  {
    "method": "GET",
    "path": "/glp-service/v1/onboarding",
    "domain": "misc",
    "verdict": "verified",
    "tools": [],
    "notes": "GLP-1 onboarding LIST"
  },
  {
    "method": "GET",
    "path": "/growth-content-service/v1/discover-more",
    "domain": "misc",
    "verdict": "verified",
    "tools": [],
    "notes": "marketing noise"
  },
  {
    "method": "GET",
    "path": "/privacy-service-bff/v1/community/privacy/activity-summary",
    "domain": "privacy",
    "verdict": "verified",
    "tools": [],
    "notes": "163 KB"
  },
  {
    "method": "GET",
    "path": "/privacy-service-bff/v1/screen/community",
    "domain": "privacy",
    "verdict": "verified",
    "tools": [],
    "notes": "230 KB BFF with PUT templates; too heavy"
  },
  {
    "method": "GET",
    "path": "/privacy-service/v1/community/privacy",
    "domain": "privacy",
    "verdict": "not-found",
    "tools": [],
    "notes": "404"
  },
  {
    "method": "GET",
    "path": "/privacy-service/v1/community/privacy/settings",
    "domain": "privacy",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "best read; sleep/recovery/strain composite strings (no_one, no_one_no_daily_stats, friends_no_daily_stats, friends_no_trends, friends_score_only)"
  },
  {
    "method": "PUT",
    "path": "/privacy-service/v1/community/privacy/settings/access_*",
    "domain": "privacy",
    "verdict": "blocked-by-policy",
    "tools": [],
    "notes": "consents; never wrap"
  },
  {
    "method": "PUT",
    "path": "/privacy-service/v1/community/privacy/settings/{setting}",
    "domain": "privacy",
    "verdict": "verified",
    "tools": [],
    "notes": "verified for sleep/recovery/searchable; not wrapped in v2.0 (D13); missing version → 422"
  },
  {
    "method": "GET",
    "path": "/privacy-service/v1/user_privacy_settings",
    "domain": "privacy",
    "verdict": "verified",
    "tools": [],
    "notes": "{searchable, mutual_community_sharing, allow_recommendation}; trailing slash optional"
  },
  {
    "method": "GET",
    "path": "/home-service/v2/home/dashboard/customize",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences"
    ],
    "notes": "gauge_metrics[4] (0 RECOVERY, 2 DAY_STRAIN fixed), pinned/unpinned sections"
  },
  {
    "method": "POST",
    "path": "/hr-zones-service/v1/bff/custom",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_hr_zones_set"
    ],
    "notes": "5 contiguous zones (gap/overlap → 400 'Invalid custom zones submitted'; 4 zones → 422); Z5 max clamped; reset = defaults + is_custom:false"
  },
  {
    "method": "GET",
    "path": "/hr-zones-service/v1/bff/settings",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_hr_zones",
      "whoop_hr_zones_set"
    ],
    "notes": "is_custom = manual_heart_rate_zones_form.toggle_value; zone_rows effective; default_hr_zones for reset"
  },
  {
    "method": "GET",
    "path": "/hr-zones-service/v1/bff/zones",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_hr_zones"
    ],
    "notes": "zones ZONE_0..5; NO is_custom"
  },
  {
    "method": "POST",
    "path": "/hr-zones-service/v1/maxhr",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_hr_zones_set"
    ],
    "notes": "200 zones (HRR); 100/221/230 → 400; keeps custom zones but response shows defaults"
  },
  {
    "method": "GET",
    "path": "/notification-service/v1/notifications/user-settings",
    "domain": "settings",
    "verdict": "not-found",
    "tools": [],
    "notes": "404 (block/namespace GET → 405)"
  },
  {
    "method": "GET",
    "path": "/notification-service/v1/notifications/user-settings/bff",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences"
    ],
    "notes": "settings[{push_namespace StressSummary|GPS|ConversationalCheckIn|CheckIn, active}]"
  },
  {
    "method": "PUT",
    "path": "/notification-service/v1/notifications/user-settings/block/namespace",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "block; idempotent; case-sensitive (unknown → 400 'Namespace does not exist')"
  },
  {
    "method": "DELETE",
    "path": "/notification-service/v1/notifications/user-settings/block/namespace/{ns}",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "unblock; unknown ns → 200 no-op"
  },
  {
    "method": "PUT",
    "path": "/profile-service/v1/profile",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_profile_update"
    ],
    "notes": "Full replace → true / false (rejected). Omit city clears; omit baseline keeps; state required for US; gender MALE|FEMALE|NON_BINARY|PREFER_NOT; birthday/country invalidate session."
  },
  {
    "method": "GET",
    "path": "/profile-service/v1/profile/bff/edit",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_profile",
      "whoop_profile_update"
    ],
    "notes": "MERGE SOURCE: every PUT field in PUT format + locked_fields, countries, UI bounds"
  },
  {
    "method": "PUT",
    "path": "/user-preferences-service/v1/home/dashboard/customize",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "204; exactly 2 gauges (omit → reset to HRV+SLEEP_PERFORMANCE); pinned full ordered replace"
  },
  {
    "method": "GET",
    "path": "/users-service/v1/hidden-metrics",
    "domain": "settings",
    "verdict": "not-found",
    "tools": [],
    "notes": "404"
  },
  {
    "method": "DELETE",
    "path": "/users-service/v1/hidden-metrics/{metric}",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "show; 204 idempotent"
  },
  {
    "method": "GET",
    "path": "/users-service/v1/hidden-metrics/{metric}",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "{is_hidden}; no server enum"
  },
  {
    "method": "POST",
    "path": "/users-service/v1/hidden-metrics/{metric}",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "hide; 204 idempotent; any string accepted → allow BODY_COMP|HEALTHSPAN only"
  },
  {
    "method": "GET",
    "path": "/users-service/v1/stealth-mode",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "bare JSON boolean"
  },
  {
    "method": "PUT",
    "path": "/users-service/v1/stealth-mode",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "{enabled:true} or bare false → bare boolean"
  },
  {
    "method": "GET",
    "path": "/users-service/v1/users/preferences/time",
    "domain": "settings",
    "verdict": "service-only-401",
    "tools": [],
    "notes": "401 even after refresh (499cba4b)"
  },
  {
    "method": "POST",
    "path": "/users-service/v1/users/preferences/time",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_preferences_set"
    ],
    "notes": "clock_format write; same values → existing row. Never change timezone."
  },
  {
    "method": "PUT",
    "path": "/users-service/v1/users/profile/offset",
    "domain": "settings",
    "verdict": "verified",
    "tools": [],
    "notes": "ZoneOffset parse; same-value write only; not for tools"
  },
  {
    "method": "GET",
    "path": "/users-service/v2/bootstrap",
    "domain": "settings",
    "verdict": "verified",
    "tools": [
      "whoop_profile",
      "(client: unit helper, init_timezone)"
    ],
    "notes": "physiological_baseline always null; gender display strings; profile.weight follows latest weight reading"
  },
  {
    "method": "GET",
    "path": "/users-service/v2/bootstrap/{account|user|membership}",
    "domain": "settings",
    "verdict": "verified",
    "tools": [],
    "notes": "sub-resources"
  },
  {
    "method": "GET",
    "path": "/coaching-service/v1/sleepneed/onboarding",
    "domain": "sleep",
    "verdict": "verified",
    "tools": [],
    "notes": "onboarding states TO_DO|COMPLETE"
  },
  {
    "method": "GET",
    "path": "/coaching-service/v2/sleepneed",
    "domain": "sleep",
    "verdict": "server-error-500",
    "tools": [
      "whoop_sleep",
      "whoop_day"
    ],
    "notes": "500 all run on test account (smart-alarm prefs damage). Capture shape: need_breakdown{baseline,debt,naps,strain,total} ms, recommended_time_in_bed_formatted. Degrade to null."
  },
  {
    "method": "DELETE",
    "path": "/core-details-bff/v2/sleep-details/{id}",
    "domain": "sleep",
    "verdict": "verified",
    "tools": [
      "whoop_activity_delete"
    ],
    "notes": "204; cycle structure not restored"
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v2/sleep-details/{id}",
    "domain": "sleep",
    "verdict": "verified",
    "tools": [
      "whoop_sleep",
      "whoop_activity_edit",
      "whoop_activity_log"
    ],
    "notes": "naps + main sleeps by id: labels, edit components (nap_to_sleep_available), sleep_metric_breakdowns (stages, efficiency, latency, RR, wake events), stage bars/hypnogram, HR graph; 404 text"
  },
  {
    "method": "PUT",
    "path": "/core-details-bff/v2/sleep-details/{id}",
    "domain": "sleep",
    "verdict": "verified",
    "tools": [
      "whoop_activity_edit"
    ],
    "notes": "Window edit. resolve_overlaps:true DELETES the overlapped activity. Type is server-derived (1/7 demoted to nap): read back. 409, 412, 422 (one bound)."
  },
  {
    "method": "PUT",
    "path": "/core-details-bff/v2/sleep-details/{id}/nap-to-sleep",
    "domain": "sleep",
    "verdict": "not-found",
    "tools": [],
    "notes": "404; use cardio-details PUT with activity_internal_name 'sleep'"
  },
  {
    "method": "GET",
    "path": "/sleep-service/v1/heart-rate/baseline",
    "domain": "sleep",
    "verdict": "verified",
    "tools": [
      "whoop_sleep"
    ],
    "notes": "bare JSON number (bpm)"
  },
  {
    "method": "POST",
    "path": "/vow-service/v1/coaching/vows/sleepcoach",
    "domain": "sleep",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "read-like; body = sleepneed object; 500 on test account; returns bedtime sentence when healthy"
  },
  {
    "method": "GET",
    "path": "/smart-alarm-bff/v1/preferences",
    "domain": "smart_alarm",
    "verdict": "not-found",
    "tools": [],
    "notes": "404 (PUT too)"
  },
  {
    "method": "POST",
    "path": "/smart-alarm-bff/v1/schedule",
    "domain": "smart_alarm",
    "verdict": "verified",
    "tools": [
      "whoop_smart_alarm_set"
    ],
    "notes": "Create; steals overlapping days; turns master switch on; returns rows ([0].schedule_id)"
  },
  {
    "method": "GET",
    "path": "/smart-alarm-bff/v1/schedule/all",
    "domain": "smart_alarm",
    "verdict": "server-error-500",
    "tools": [
      "whoop_smart_alarm"
    ],
    "notes": "Verified before damage; now 500. alarm_mode lossy (disabled → NO_ALARM), no sleep_goal, 12-h display time"
  },
  {
    "method": "GET",
    "path": "/smart-alarm-bff/v1/schedule/components",
    "domain": "smart_alarm",
    "verdict": "verified",
    "tools": [
      "whoop_smart_alarm_set"
    ],
    "notes": "enum source: alarm_mode_value, sleep_goal_value; wake_time says 'Alarm will vibrate between %s - %s' for IN_THE_GREEN and SLEEP_GOAL only"
  },
  {
    "method": "GET",
    "path": "/smart-alarm-bff/v1/schedule/components/populated/{id}",
    "domain": "smart_alarm",
    "verdict": "verified-quirky",
    "tools": [],
    "notes": "sleep_goal toggle_selected ALWAYS PEAK (PR #39 relies on it wrongly)"
  },
  {
    "method": "DELETE",
    "path": "/smart-alarm-bff/v1/schedule/{id}",
    "domain": "smart_alarm",
    "verdict": "not-found",
    "tools": [],
    "notes": "405"
  },
  {
    "method": "PUT",
    "path": "/smart-alarm-bff/v1/schedule/{id}",
    "domain": "smart_alarm",
    "verdict": "verified",
    "tools": [
      "whoop_smart_alarm_set"
    ],
    "notes": "In-place edit (upsert; [] days clears). On damaged account: saves rows then 500."
  },
  {
    "method": "GET",
    "path": "/smart-alarm-service/v1/alarm-schedule",
    "domain": "smart_alarm",
    "verdict": "verified",
    "tools": [
      "whoop_smart_alarm",
      "whoop_smart_alarm_set"
    ],
    "notes": "SOURCE OF TRUTH: rows {schedule_id, day_of_week, upper_time_bound HH:MM:SS, goal (incl. SLEEP_HEALTH_*), enabled, deleted}; works during damage"
  },
  {
    "method": "PUT",
    "path": "/smart-alarm-service/v1/alarm-schedule/disable",
    "domain": "smart_alarm",
    "verdict": "server-error-500",
    "tools": [
      "whoop_smart_alarm_set"
    ],
    "notes": "Verified 204 before damage (prefs schedule_enabled:false, enabled:false); now 500"
  },
  {
    "method": "PUT",
    "path": "/smart-alarm-service/v1/alarm-schedule/enable",
    "domain": "smart_alarm",
    "verdict": "server-error-500",
    "tools": [
      "whoop_smart_alarm_set"
    ],
    "notes": "Verified 204 before damage (re-derives prefs from next day); now 500"
  },
  {
    "method": "DELETE",
    "path": "/smart-alarm-service/v1/alarm-schedule/{id}",
    "domain": "smart_alarm",
    "verdict": "verified",
    "tools": [
      "whoop_smart_alarm_set"
    ],
    "notes": "204 idempotent"
  },
  {
    "method": "GET",
    "path": "/smart-alarm-service/v1/alarm-schedule/{id}",
    "domain": "smart_alarm",
    "verdict": "verified",
    "tools": [
      "whoop_smart_alarm_set"
    ],
    "notes": "rows for one schedule; [] if unknown/empty"
  },
  {
    "method": "GET",
    "path": "/smart-alarm-service/v1/smartalarm/preferences",
    "domain": "smart_alarm",
    "verdict": "server-error-500",
    "tools": [
      "whoop_smart_alarm"
    ],
    "notes": "Verified before damage (next-alarm object); 500 since 02:40:33Z"
  },
  {
    "method": "POST",
    "path": "/smart-alarm-service/v1/smartalarm/preferences",
    "domain": "smart_alarm",
    "verdict": "not-found",
    "tools": [],
    "notes": "405 (DELETE too)"
  },
  {
    "method": "PUT",
    "path": "/smart-alarm-service/v1/smartalarm/preferences",
    "domain": "smart_alarm",
    "verdict": "server-error-500",
    "tools": [
      "whoop_smart_alarm_set"
    ],
    "notes": "Verified for 7 safe goals before damage; ALARM_OFF_PEAK / EXACT_TIME_WEEKLY_PLAN / EXACT_TIME_SLEEP_HOURS broke the account. SAFE GOALS ONLY; never weekly_plan_goal/default."
  },
  {
    "method": "POST",
    "path": "/smart-alarm-service/v1/smartalarm/wbl",
    "domain": "smart_alarm",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "BLE alarm telemetry; only [] sent; don't wrap"
  },
  {
    "method": "GET",
    "path": "/smart-alarm-service/v1/strap-status",
    "domain": "smart_alarm",
    "verdict": "not-found",
    "tools": [],
    "notes": "405"
  },
  {
    "method": "PUT",
    "path": "/smart-alarm-service/v1/strap-status",
    "domain": "smart_alarm",
    "verdict": "blocked-by-policy",
    "tools": [],
    "notes": "App pushes alarm time to strap here; blocked; totem can't send it → alarms sync only via the app"
  },
  {
    "method": "GET",
    "path": "/progression-service/v3/exercise/{id}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise"
    ],
    "notes": "AVG VOLUME LOAD segments"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v1/exercise/{id}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise",
      "whoop_lift_log"
    ],
    "notes": "alive: catalog ids, custom uuids, deleted customs (deleted:true); row usable verbatim as exercise_details"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v1/link-workout",
    "domain": "strength",
    "verdict": "verified",
    "tools": [],
    "notes": "link screen (templates, AI auto-link)"
  },
  {
    "method": "POST",
    "path": "/weightlifting-service/v2/custom-exercise",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise_set"
    ],
    "notes": "Create and edit (upsert by exercise_id). linked_exercise makes it trackable. laterality/exercise_type ignored. Bare 422."
  },
  {
    "method": "DELETE",
    "path": "/weightlifting-service/v2/custom-exercise/{uuid}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise_set"
    ],
    "notes": "204 idempotent soft delete; v1/exercise still returns deleted:true; v3/prs tile remains"
  },
  {
    "method": "PUT",
    "path": "/weightlifting-service/v2/custom-exercise/{uuid}",
    "domain": "strength",
    "verdict": "not-found",
    "tools": [],
    "notes": "405 (also on collection)"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v2/exercise",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop://catalog/exercises",
      "whoop_lift_log"
    ],
    "notes": "371 base rows + customs + filter_options"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v2/exercise/{id}",
    "domain": "strength",
    "verdict": "not-found",
    "tools": [],
    "notes": "404"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v2/prebuilt-workout-template/{id}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_library"
    ],
    "notes": "WHOOP prebuilt workout detail"
  },
  {
    "method": "POST",
    "path": "/weightlifting-service/v2/weightlifting-workout/activity",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_log"
    ],
    "notes": "Bare 422 on any schema error; 409 text on overlap (nothing deleted). weight in profile display unit. Saved window = union(during, set durings). Set without during = not performed. 0-rep weighted set wins a PR."
  },
  {
    "method": "POST",
    "path": "/weightlifting-service/v2/weightlifting-workout/link-cardio-workout",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_log"
    ],
    "notes": "Attach sets to an existing activity. template_id:-1 works (no template). 422 without template_id; 409 already linked; no unlink. Works while link_workout_option_enabled is false."
  },
  {
    "method": "DELETE",
    "path": "/weightlifting-service/v2/workout-template/{key}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_template"
    ],
    "notes": "204 idempotent"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v2/workout-template/{key}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_library",
      "whoop_lift_template"
    ],
    "notes": "user templates and AI drafts (is_draft); 404 HTML for deleted/prebuilt"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v3/exercise/{id}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [],
    "notes": "UI BFF; don't parse"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v3/exercise/{id}/exercise_history",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise",
      "whoop_lift_sessions"
    ],
    "notes": "one card per workout; sets without during excluded"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v3/exercise/{id}/personal_records",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise"
    ],
    "notes": "cards per medal"
  },
  {
    "method": "DELETE",
    "path": "/weightlifting-service/v3/one-rep-max/manual-entry/{entry_id}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise_set"
    ],
    "notes": "204; estimate reverts; re-delete 404 'No manual one rep max entry'"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v3/one-rep-max/{exercise_id}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise"
    ],
    "notes": "value + Estimated/Manual; limits 1–999, 6 months back"
  },
  {
    "method": "PUT",
    "path": "/weightlifting-service/v3/one-rep-max/{exercise_id}",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise_set"
    ],
    "notes": "204. Create; with id = edit; same date w/o id = replace. Value in display unit. 400s: 1–999, >6 months back, future. e1rm_eligible not enforced."
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v3/one-rep-max/{exercise_id}/history",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise",
      "whoop_lift_exercise_set"
    ],
    "notes": "MEASUREMENT_ENTRY_ITEMs; manual entry uuid only inside generic_interaction"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v3/prs",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_exercise"
    ],
    "notes": "tiles (no record_date/medal); stale tiles survive deletion; deleted customs flagged; dedupe by exercise_id"
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v3/workout-library",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_library"
    ],
    "notes": "my_workouts_list[{workout_template_key, name, source, created_at,…}], whoop_workouts_list[{id (string), title, paragraph, tag}]; no pagination; drafts not listed"
  },
  {
    "method": "POST",
    "path": "/weightlifting-service/v3/workout-template",
    "domain": "strength",
    "verdict": "verified",
    "tools": [
      "whoop_lift_template"
    ],
    "notes": "Create (no key or -1); edit in place with existing key (±source); unknown key silently creates new. Sets {number_of_reps, weight?, time_in_seconds?}."
  },
  {
    "method": "GET",
    "path": "/weightlifting-service/v3/workout-template/{key}",
    "domain": "strength",
    "verdict": "not-found",
    "tools": [],
    "notes": "404 (DELETE too)"
  },
  {
    "method": "POST",
    "path": "/weightlifting-service/v3/workout-template/{key}/duplicate",
    "domain": "strength",
    "verdict": "not-found",
    "tools": [],
    "notes": "404 (v2 too); copy = GET + POST without key"
  },
  {
    "method": "GET",
    "path": "/coaching-service/v1/performance-assessment/{reportType}/data/{ts}",
    "domain": "trends",
    "verdict": "verified",
    "tools": [
      "whoop_performance_assessment"
    ],
    "notes": "{is_assessment_needed, has_assessment, total_recoveries, required_recoveries, expected/next_assessment_during}"
  },
  {
    "method": "GET",
    "path": "/progression-service/v3/trends/BODY_COMPOSITION/readings",
    "domain": "trends",
    "verdict": "verified",
    "tools": [],
    "notes": "alias of WEIGHT/readings (POST and DELETE {id} also verified; PUT untried); other graph keys → 400 'Unsupported graph key'"
  },
  {
    "method": "GET",
    "path": "/progression-service/v3/trends/WEIGHT/readings",
    "domain": "trends",
    "verdict": "verified",
    "tools": [
      "whoop_weight"
    ],
    "notes": "sections.records[].measurements[MEASUREMENT_BOX{id, weight (display), weight_details_screen{timestamp, weight_kg, body_fat_percent (fraction), lean_body_mass_kg, save_title}}], sections.next_token; query params ignored; "
  },
  {
    "method": "POST",
    "path": "/progression-service/v3/trends/WEIGHT/readings",
    "domain": "trends",
    "verdict": "verified",
    "tools": [
      "whoop_weight_log"
    ],
    "notes": "204 no id (re-list). Same-day POST adds. 0<kg≤275; body_fat fraction (>1 → 422). Latest-timestamp reading sets profile weight."
  },
  {
    "method": "GET",
    "path": "/progression-service/v3/trends/WEIGHT/readings/paginated",
    "domain": "trends",
    "verdict": "exists-but-unclear",
    "tools": [
      "whoop_weight"
    ],
    "notes": "page 2+; made-up tokens 400; real token unverified (first page = 100 on main)"
  },
  {
    "method": "DELETE",
    "path": "/progression-service/v3/trends/WEIGHT/readings/{id}",
    "domain": "trends",
    "verdict": "verified",
    "tools": [
      "whoop_weight_log"
    ],
    "notes": "204 always (idempotent); does NOT revert profile weight"
  },
  {
    "method": "GET",
    "path": "/progression-service/v3/trends/WEIGHT/readings/{id}",
    "domain": "trends",
    "verdict": "not-found",
    "tools": [],
    "notes": "405"
  },
  {
    "method": "PUT",
    "path": "/progression-service/v3/trends/WEIGHT/readings/{id}",
    "domain": "trends",
    "verdict": "verified",
    "tools": [
      "whoop_weight_log"
    ],
    "notes": "Full replace (omitted optional → null; timestamp required) → 200 stored record; 404 deleted id"
  },
  {
    "method": "GET",
    "path": "/progression-service/v3/trends/{metric}",
    "domain": "trends",
    "verdict": "verified",
    "tools": [
      "whoop_trend"
    ],
    "notes": "Always week/month/six_month; no year, no range param. Add HR_ZONES_ALL, RESTORATIVE_SLEEP_PERCENT; TOTAL_VOLUME_LOAD and SAGE 500; VO2_MAX week hidden; derive window dates from endDate."
  },
  {
    "method": "GET",
    "path": "/progression-service/v{2,4}/trends/{metric}",
    "domain": "trends",
    "verdict": "not-found",
    "tools": [],
    "notes": "404"
  },
  {
    "method": "GET",
    "path": "/progression-service/v1/weekly-plan",
    "domain": "weekly_plan",
    "verdict": "verified",
    "tools": [
      "whoop_weekly_plan"
    ],
    "notes": "Mon–Sun; no plan → locked PLAN_TILEs; plan → CURRENT_PLAN_TILE{plan_id}, goal_section[{id TargetGoalType}]"
  },
  {
    "method": "GET",
    "path": "/progression-service/v1/weekly-plan/presets",
    "domain": "weekly_plan",
    "verdict": "verified",
    "tools": [
      "whoop_weekly_plan"
    ],
    "notes": "plan tiles + cancel copy"
  },
  {
    "method": "GET",
    "path": "/progression-service/v2/weekly-plan/home-tile/{date}",
    "domain": "weekly_plan",
    "verdict": "verified",
    "tools": [
      "whoop_weekly_plan"
    ],
    "notes": "WEEKLY_PLAN_HOME_TILE (plan) or TEXT_WITH_ILLUSTRATION (none)"
  },
  {
    "method": "GET",
    "path": "/progression-service/v2/weekly-plan/setup",
    "domain": "weekly_plan",
    "verdict": "verified",
    "tools": [
      "whoop_weekly_plan_set"
    ],
    "notes": "{plan_id, screens[]}; plan_id random per call until a plan record exists; ?screens= one of STRAIN, SLEEP_PERFORMANCE, SLEEP_CONSISTENCY, ACTIVITIES, BEHAVIORS, WEIGHT, STEPS, HR_ZONES_ONE_TO_THREE, HR_ZONES_FOUR_TO_FIVE, STRENGTH_TRAINING_TIME, SLEEP_HOURS"
  },
  {
    "method": "GET",
    "path": "/progression-service/v2/weekly-plan/setup/overview/{plan}",
    "domain": "weekly_plan",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "500 (Cloudflare HTML) on test account; 200 on main"
  },
  {
    "method": "PUT",
    "path": "/progression-service/v2/weekly-plan/{plan_id}",
    "domain": "weekly_plan",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "PutPlanRequest; every body 422. Don't call."
  },
  {
    "method": "PUT",
    "path": "/progression-service/v2/weekly-plan/{plan_id}/goal/target",
    "domain": "weekly_plan",
    "verdict": "verified",
    "tools": [
      "whoop_weekly_plan_set"
    ],
    "notes": "204. Creates Custom plan / edits / adds a goal. Verified STEPS, STRENGTH_TRAINING_TIME only. {} → 422."
  },
  {
    "method": "DELETE",
    "path": "/progression-service/v2/weekly-plan/{plan_id}/goal/target/{type}",
    "domain": "weekly_plan",
    "verdict": "verified",
    "tools": [
      "whoop_weekly_plan_set"
    ],
    "notes": "204; removing the last goal ends the plan in the UI (empty record persists)"
  },
  {
    "method": "DELETE",
    "path": "/progression-service/v{1,2}/weekly-plan/{plan_id}",
    "domain": "weekly_plan",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "always 500. Don't call."
  },
  {
    "method": "POST",
    "path": "/health-service/v1/hormonal-insights/settings/hormonal-goals",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "204 replace; not wrapped (D13)"
  },
  {
    "method": "DELETE",
    "path": "/health-service/v1/hormonal-insights/settings/mci",
    "domain": "womens_health",
    "verdict": "not-exercised",
    "tools": [],
    "notes": "disables HI; can't be restored"
  },
  {
    "method": "POST",
    "path": "/health-service/v1/hormonal-insights/settings/mci",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "every call appends a contraception history row; not wrapped"
  },
  {
    "method": "PUT",
    "path": "/health-service/v1/hormonal-insights/settings/mci/overlay",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "Not wrapped (D13)"
  },
  {
    "method": "PUT",
    "path": "/health-service/v1/hormonal-insights/settings/mci/survey",
    "domain": "womens_health",
    "verdict": "not-exercised",
    "tools": [],
    "notes": "onboarding; rewrites period history"
  },
  {
    "method": "GET",
    "path": "/health-service/v1/pregnancy/onboarding/welcome",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "due-date window"
  },
  {
    "method": "PUT",
    "path": "/health-service/v1/pregnancy/settings",
    "domain": "womens_health",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "only a 400 probe; real call creates a pregnancy and switches mode"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/hormonal-insights/calendar",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "current month only; date ignored"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/hormonal-insights/cycle-log-polling",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "internal post-log poll"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/hormonal-insights/onboarding",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "survey enum source"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/hormonal-insights/overview",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [
      "whoop_cycle"
    ],
    "notes": "HEADER_TILE, HORMONAL_INSIGHTS_CALENDAR_DAY days, SECTIONs (journal, trends & patterns); 400 before onboarding"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/hormonal-insights/settings",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [
      "whoop_cycle"
    ],
    "notes": "drawers: mode MENSTRUATING|PREGNANCY, contraception (8), goals; overlay toggle; previous pregnancies"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/menstrual-cycle-insights",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [
      "whoop_cycle"
    ],
    "notes": "OLD screen, still alive; TYPICAL_CYCLE_TILE/CYCLE_PHASE_COACHING nested in MCI_TILE_SECTION (fallback source)"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/menstrual-cycle-insights/cycles",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [
      "whoop_cycle"
    ],
    "notes": "cycles list; hide/unhide write path not exposed"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/menstrual-cycle-insights/cycles/edit",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "read-only edit view"
  },
  {
    "method": "PUT",
    "path": "/womens-health-service/v1/menstrual-cycle-insights/log",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [
      "whoop_cycle_log"
    ],
    "notes": "200. Several entries per call; both period+ovulation same day → 400; period on empty date creates a sticky cycle; writes journal 43/79."
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/menstrual-cycle-insights/symptoms",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [
      "whoop_cycle"
    ],
    "notes": "symptom tick rows per cycle segment"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/pregnancy/edit",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "enum source"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/pregnancy/screen",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "404 text 'Pregnancy Settings turned off for user' when none active"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/pregnancy/{id}",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "postpartum summary; method/weight not in read"
  },
  {
    "method": "PUT",
    "path": "/womens-health-service/v1/pregnancy/{id}",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "204; NO enum validation (BOGUS accepted); not wrapped"
  },
  {
    "method": "POST",
    "path": "/womens-health-service/v1/symptom-insights/log/symptoms",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [
      "whoop_cycle_log"
    ],
    "notes": "tracker_inputs merge; menstruation & cervical_mucus REPLACE (omit = clear); flow logs a period day; invalid enum → 422"
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/symptom-insights/log/symptoms/screen",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [
      "whoop_cycle",
      "whoop_cycle_log"
    ],
    "notes": "current day selections + live enums (menstruation, cervical_mucus, symptom ids)"
  },
  {
    "method": "GET",
    "path": "/metrics-service/v1/metrics/user/{user_id}",
    "domain": "health",
    "verdict": "verified",
    "tools": [
      "whoop_day",
      "whoop_now"
    ],
    "notes": "continuous heart rate {values:[{time ms, data bpm}]}, sparse (holes, no padding); step must be 6, 60 or 600 (else 400); any window; another user's id → 403"
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v0/cycles/details",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop_day"
    ],
    "notes": "bulk history {records:[{cycle, recovery, sleeps[], workouts[], v2_activities[]}]}, newest first, every cycle overlapping the window; window ≤200 days (else 400); recovery and sleeps not seen live (account never slept): hrv_rmssd is seconds, sleep durations ms"
  },
  {
    "method": "GET",
    "path": "/sleep-service/v1/sleep-events",
    "domain": "sleep",
    "verdict": "not-exercised",
    "tools": [],
    "notes": "hypnogram {during, type LIGHT/REM/SWS/DISTURBANCES} per other open-source clients; not called live (no sleep on the test account); whoop_sleep reads stages from sleep-details instead"
  },
  {
    "method": "GET",
    "path": "/home-service/v1/home/activities/multi-modifications",
    "domain": "activities",
    "verdict": "verified",
    "tools": [],
    "notes": "Android route (@Acetone1). ?date=. The Edit Activities drawer: ACTIVITY_TILE_SELECTION items (activity_v2_id, during, selectable_state), footer Delete and Merge, limit callouts."
  },
  {
    "method": "PATCH",
    "path": "/core-details-bff/v1/activities/merge",
    "domain": "activities",
    "verdict": "verified",
    "tools": [
      "whoop_activity_edit"
    ],
    "notes": "Android route (@Acetone1). ?startTime&endTime, body [ids]. 200: the earliest activity (id, type) now spans the bounds; the others are deleted, in any id order. 422 while an activity inside the bounds is pending."
  },
  {
    "method": "DELETE",
    "path": "/core-details-bff/v1/activities/merge",
    "domain": "activities",
    "verdict": "not-found",
    "tools": [],
    "notes": "Android route (@Acetone1). ?id=. 405 Method Not Allowed, so a merge can't be undone."
  },
  {
    "method": "PUT",
    "path": "/core-details-bff/v2/sleep-details/nap-to-sleep/{activity_id}",
    "domain": "sleep",
    "verdict": "not-exercised",
    "tools": [],
    "notes": "Android route (@Acetone1). Not sent: whoop_activity_edit already turns a nap into a main sleep through cardio-details."
  },
  {
    "method": "GET",
    "path": "/core-details-bff/v1/strength-workout/exercises",
    "domain": "strength",
    "verdict": "not-found",
    "tools": [],
    "notes": "Android route (@Acetone1). 404 with totem's iOS identity, as are /exercises/{id}, /history and /suggested (catalog ids like BENCHPRESS_BARBELL)."
  },
  {
    "method": "GET",
    "path": "/journal-service/v2/journals/{date}/calendar",
    "domain": "journal",
    "verdict": "verified",
    "tools": [
      "whoop_calendar"
    ],
    "notes": "Android route (@Acetone1). days_of_month[{date_value_display, cycle_id, day_state HAS_JOURNAL_ENTRY | NO_DATA, has_data}] for the date's month."
  },
  {
    "method": "GET",
    "path": "/journal-service/v1/journals/stats/user/{cycle_id}",
    "domain": "journal",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "Android route (@Acetone1). records[{behavior_tracker_id, yes_count, no_count, last_value}] for ~310 trackers. Counts are neither lifetime nor as-of (an older cycle gave a higher count), so unused."
  },
  {
    "method": "GET",
    "path": "/journal-service/v1/journals/behaviors/user",
    "domain": "journal",
    "verdict": "verified",
    "tools": [],
    "notes": "Android route (@Acetone1). The v1 tracker catalog (~309 rows with title, category, question_text). totem reads v3 behaviors instead."
  },
  {
    "method": "GET",
    "path": "/smart-alarm-service/v1/user-info/default-wake-window",
    "domain": "smart_alarm",
    "verdict": "verified",
    "tools": [
      "whoop_smart_alarm"
    ],
    "notes": "Android route (@Acetone1). {default_wake_window_minutes} (60). IN_THE_GREEN and SLEEP_GOAL buzz between the latest wake time minus this and the latest wake time."
  },
  {
    "method": "GET",
    "path": "/smart-alarm-service/v1/smartalarm/poll",
    "domain": "smart_alarm",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "Android route (@Acetone1). 500 on the test account, whose alarm preferences 500 too."
  },
  {
    "method": "PATCH",
    "path": "/smart-alarm-service/v1/smartalarm/preferences/timezone",
    "domain": "smart_alarm",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "Android route (@Acetone1). {time_zone_offset: profile offset} answered 500 on the test account (preferences already broken); stopped there. Untested on a healthy account."
  },
  {
    "method": "PUT",
    "path": "/smart-alarm-service/v1/smartalarm/override",
    "domain": "smart_alarm",
    "verdict": "not-exercised",
    "tools": [],
    "notes": "Android route (@Acetone1). Not sent: the test account's alarm preferences 500, so there was no value to restore."
  },
  {
    "method": "GET",
    "path": "/progression-service/v3/{measurement_type}/manual/readings",
    "domain": "trends",
    "verdict": "verified",
    "tools": [],
    "notes": "Android route (@Acetone1). measurement_type vo2max (VO2_MAX, VO2MAX, vo2_max: 404). Records list plus the Add Manual Value sheet: timestamp, vo2_max_value, mL/kg/min, sources MANUAL_LAB_TEST, MANUAL_WEARABLE, MANUAL_OTHER."
  },
  {
    "method": "POST",
    "path": "/vo2max-service/v2/{measurement_type}/manual",
    "domain": "trends",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "Android route (@Acetone1). vo2max: 422 with an empty body for six shapes built from the sheet's fields (VO2_MAX: 404). Body unknown; nothing was created."
  },
  {
    "method": "PUT",
    "path": "/progression-service/v2/weekly-plan/{plan_id}/goal/activity",
    "domain": "weekly_plan",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "Android route (@Acetone1). 204 for every body tried ({}, and goals/activities/goal_settings lists of tile ids like ANY_STRAIN), with and without a plan; nothing changed. Tiles: setup?screens=ACTIVITIES."
  },
  {
    "method": "PUT",
    "path": "/progression-service/v2/weekly-plan/{plan_id}/goal/behavior",
    "domain": "weekly_plan",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "Android route (@Acetone1). 204 for {}; nothing changed. Tiles come from setup?screens=BEHAVIORS (behavior tracker ids, AVOID options)."
  },
  {
    "method": "DELETE",
    "path": "/progression-service/v2/weekly-plan/{plan_id}/goal/activity",
    "domain": "weekly_plan",
    "verdict": "exists-but-unclear",
    "tools": [],
    "notes": "Android route (@Acetone1). 204 (and the same for goal/behavior); the test plan had no such goals to remove."
  },
  {
    "method": "GET",
    "path": "/progression-service/v2/weekly-plan/setup/overview",
    "domain": "weekly_plan",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "Android route (@Acetone1). 500 on the test account."
  },
  {
    "method": "GET",
    "path": "/healthspan-service/v1/healthspan/bff",
    "domain": "health",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "Android route (@Acetone1). ?date=. {unlocked_content, locked_content}; locked on the test account ('21 SLEEPS TO UNLOCK'). The unlocked shape is unseen, so whoop_profile passes it through marked unverified."
  },
  {
    "method": "GET",
    "path": "/healthspan-service/v1/widget",
    "domain": "health",
    "verdict": "verified",
    "tools": [],
    "notes": "Android route (@Acetone1). {amoeba, locked_content}; locked on the test account."
  },
  {
    "method": "GET",
    "path": "/sage-service/v1/sage/bff",
    "domain": "health",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "Android route (@Acetone1). ?date=. Blood Pressure Insights, same locked/unlocked shape; locked ('UPGRADE FOR ACCESS', WHOOP Life)."
  },
  {
    "method": "GET",
    "path": "/sage-service/v1/sage/manual/input",
    "domain": "health",
    "verdict": "verified",
    "tools": [],
    "notes": "Android route (@Acetone1). Manual blood pressure screens (guidelines, reading input)."
  },
  {
    "method": "GET",
    "path": "/advanced-labs-service/v1/advanced-labs/biomarkers/summary",
    "domain": "health",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "Android route (@Acetone1). Pie chart plus SEARCHABLE_BIOMARKERS_LIST biomarkers[{id, title, value, unit, status_type}]: 100 rows, all '--' and UNAVAILABLE without results (46 KB)."
  },
  {
    "method": "GET",
    "path": "/advanced-labs-service/v1/advanced-labs/tests/history",
    "domain": "health",
    "verdict": "verified",
    "tools": [],
    "notes": "Android route (@Acetone1). Lab History; one empty-tile section without tests."
  },
  {
    "method": "GET",
    "path": "/arrhythmia-service/v2/afibhistory/screen",
    "domain": "health",
    "verdict": "verified",
    "tools": [
      "whoop_profile"
    ],
    "notes": "Android route (@Acetone1). 404 'No anf user found' until irregular rhythm notifications are set up (also /v2/settings)."
  },
  {
    "method": "GET",
    "path": "/arrhythmia-service/v1/about",
    "domain": "health",
    "verdict": "verified",
    "tools": [],
    "notes": "Android route (@Acetone1). Static regulatory page, as is /ecg-service/v1/ecg/about. The Android list has no read route for ECG readings."
  },
  {
    "method": "GET",
    "path": "/womens-health-service/v1/menstrual-cycle-insights/deep-dives",
    "domain": "womens_health",
    "verdict": "verified",
    "tools": [],
    "notes": "Android route (@Acetone1). Static phase guidance for the four phases (45 KB)."
  },
  {
    "method": "GET",
    "path": "/widget-service/v1/statistics/{statistic}",
    "domain": "home",
    "verdict": "server-error-500",
    "tools": [],
    "notes": "Android route (@Acetone1). 500 for RECOVERY and for composite?statistics=… on the test account."
  },
  {
    "method": "GET",
    "path": "/user-journey-service/v1/user-journey/first-week-in-review",
    "domain": "misc",
    "verdict": "not-found",
    "tools": [],
    "notes": "Android route (@Acetone1). 404 'currently unavailable', as is the v2 year-in-review (seasonal)."
  }
];
