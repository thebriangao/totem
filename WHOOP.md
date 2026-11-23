# WHOOP's app API

What totem knows about the API the WHOOP app uses, as of November 2026. The tables below are written from totem's own endpoint catalog (`src/data/endpoint_catalog.ts`) by `npx tsx scripts/whoop-md.ts`, so they match what the code was built against.

This is an unofficial description of a private API. WHOOP can change it at any time, and does.

## How it was mapped

- **Captures.** The WHOOP iOS app (5.78.0) was run through mitmproxy on two accounts, and every request was recorded.
- **A live probe.** 267 of the 290 endpoints below were then called on a test account through a proxy that paced requests to a person's speed and kept a record of every call. Writes were made, read back, and undone. The rest were left alone on purpose, or (like the social endpoints, which the probe skipped) are known from the captures alone; their verdict says which.
- **The heart-rate series and the bulk day history** were checked live the same day, including that another person's user id is refused.
- **Android routes.** [@Acetone1](https://github.com/Acetone1) shared the routes in WHOOP's Android app ([issue #5](https://github.com/thebriangao/totem/issues/5)). The ones that fit totem were called on the test account on 2026-11-22 and are marked "Android route" below.

No real person's data appears in totem's tests or this page.

## Basics

- **Host:** `https://api.prod.whoop.com`. Every service sits under a path prefix (`/home-service/`, `/core-details-bff/`, `/weightlifting-service/` and so on).
- **Auth:** a Cognito access token as a bearer token (about 24 hours). The token from a web login (app.whoop.com) works on the app API.
- **Refresh:** `POST /auth-service/v3/whoop/` with the Cognito `InitiateAuth` call (`REFRESH_TOKEN_AUTH`, the web client's id). **WHOOP returns a new refresh token every time, and the old one stops working.** Save the new one before using the new access token, and never let two processes refresh the same login.
- **Logging in** with a password now needs a device fingerprint from WHOOP's fraud check, which is why totem logs in through a real browser window instead.
- **Headers:** the app's identity headers (platform, app version and build, bundle name), a stable per-install `x-whoop-installation-identifier`, `x-whoop-time-zone` (an IANA name) and `x-whoop-clock-format`. totem sends the same set the app does, minus telemetry.
- **Errors worth knowing:** `401` means refresh and try once more; `412` ("cycle is concurrently being updated") on a write means wait and retry (totem waits 2 s, then 10 s); a `409` on an activity write means the time window overlaps another activity.
- **Days are cycles.** A WHOOP day runs from falling asleep to falling asleep. Day endpoints take a calendar date and answer with the cycle that date belongs to, in the user's time zone.
- **Units:** HRV comes in seconds from some endpoints and milliseconds from others; sleep durations in the bulk history are milliseconds. totem converts everything to ms, minutes, hours and °C/°F as its tools document.

## Verdicts

| Verdict | Meaning |
|---|---|
| `verified` | Worked live; writes were read back. |
| `verified-quirky` | Works, with a catch described in the notes. |
| `decided` | A design decision rather than a probe result (see the notes). |
| `exists-but-unclear` | Answers, but no request shape that does something useful was found. |
| `not-exercised` | Seen in the app but deliberately not called. |
| `not-probed` | Known but not called in this run. |
| `blocked-by-policy` | Left alone on purpose (it would change something that can't be undone). |
| `service-only-401` | Answers 401 to an app token: for WHOOP's own services. |
| `server-error-500` | Answers 500 whatever is sent. |
| `not-found` | Answers 404: gone, or never existed at that path. |

## Endpoints by area

`Used by` names the totem tools (or `whoop://catalog/...` resources) that call the endpoint. Paths are templated: `{user_id}`, `{date}` and the like stand for real values.

### Home, deep dives and calendar

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/activities-service/v1/user-state` | verified | whoop_now, whoop_day | {latestMetricsProcessed, source, startAt, state idle\|workout, activity, trackedSleep} |
| GET | `/coaching-service/v1/health/bff/monitor` | verified | whoop_recovery | KEY_METRIC_TILE ids RESPIRATORY_RATE\|BLOOD_OXYGEN\|RHR\|HRV\|SKIN_TEMPERATURE_FAHRENHEIT; analytics{ranges}; today only; skin temp is °F deviation |
| GET | `/core-details-bff/v1/start-activity/strain` | verified | – | cycle strain + optimal strain mapping for Start Activity screen |
| GET | `/entitlement-service/v1/entitlements` | verified | whoop_profile | entitlements{feature:{entitled, reasons[]}}, context{current_membership_tier}; explains 'feature unavailable' |
| GET | `/health-service/v2/stress-bff/{date}` | verified | whoop_stress, whoop_now | ~145 KB; stress_state, gauge, graphs, sessions, trend_list |
| GET | `/health-tab-bff/v1/health-tab` | verified | – | healthspan hero (locked), monitor tile, stress card, menstrual tile; no live-HR tile (live HR is BLE) → whoop_live_hr dropped |
| GET | `/home-service/v1/calendar/overview` | verified | whoop_calendar, whoop_workouts, whoop_lift_sessions | byte-identical to recovery; use has_data to prune per-day walks. days_of_month[{date_value_display, has_data, cycle_id, day_state}]; no full date; future days can show has_data |
| GET | `/home-service/v1/calendar/recovery` | verified | whoop_calendar | states LOW/MEDIUM/HIGH_RECOVERY\|NO_DATA. days_of_month[{date_value_display, has_data, cycle_id, day_state}]; no full date; future days can show has_data |
| GET | `/home-service/v1/calendar/sleep` | verified | whoop_calendar | HIGH_SLEEP\|NO_DATA observed; LOW_SLEEP inferred. days_of_month[{date_value_display, has_data, cycle_id, day_state}]; no full date; future days can show has_data |
| GET | `/home-service/v1/calendar/strain` | verified | whoop_calendar | states LOW_STRAIN\|HIGH_STRAIN\|NO_DATA. days_of_month[{date_value_display, has_data, cycle_id, day_state}]; no full date; future days can show has_data |
| GET | `/home-service/v1/deep-dive/recovery` | verified | whoop_recovery, whoop_day | SCORE_GAUGE, STEPPER (calibration filled/total), CONTRIBUTORS_TILE_{HRV,RHR,RESPIRATORY_RATE,SLEEP_PERFORMANCE} |
| GET | `/home-service/v1/deep-dive/recovery/trends` | verified | – | mini weekly GRAPHING_CARDs |
| GET | `/home-service/v1/deep-dive/sleep` | verified | whoop_sleep | SLEEP_SCORE_GAUGE, contributors; no activity ids |
| GET | `/home-service/v1/deep-dive/sleep/last-night` | verified | whoop_sleep, whoop_activity_edit | date = cycle day the main sleep opens; header_section.destination ACTIVITY_EDIT {activity_id,start_time,end_time}; null if no main sleep; naps never here |
| GET | `/home-service/v1/deep-dive/sleep/trends` | verified | – | GRAPHING_CARD_* tiles |
| GET | `/home-service/v1/deep-dive/strain` | verified | whoop_strain, whoop_day | ACTIVITY items CARDIO only (RECOVERY omitted), includes pending; contributors zones/strength/steps |
| GET | `/home-service/v1/deep-dive/strain/trends` | verified | – | mini weekly GRAPHING_CARDs |
| GET | `/home-service/v1/home` | verified | whoop_day, whoop_sleep, whoop_workouts, whoop_lift_sessions, whoop_coach_history | metadata.cycle_metadata (cycle_id unstable), gauges, KEY_STATISTIC by trend_key, ACTIVITY items {activity_v2_id, type CARDIO\|RECOVERY\|SLEEP, status, during}; sport_id always -1. Card lists the cycle's activities. |
| GET | `/home-service/v1/tilt-view` | verified | – | full-day HR line plot; activity ids only as OVERLAY_PLOT labels |
| GET | `/home-service/v1/widget/overview` | verified | whoop_now | ~446 B score strings; cheapest scores read |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/health-service/v2/stress-bff/{date}/calendar` | server-error-500 | 500 on test account (200 in May capture); account-specific or global unknown |
| GET | `/home-service/v2/home` | not-found | 404; no v2 home |
| GET | `/widget-service/v1/statistics/{statistic}` | server-error-500 | Android route (@Acetone1). 500 for RECOVERY and for composite?statistics=… on the test account. |

### Activities and cycles

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/activities-service/v1/sports` | verified | whoop://catalog/sports | 205 current sports {id=sport_id, name, activity_type_internal_name, is_current}; new 336–346 |
| GET | `/activities-service/v1/sports/history` | verified | whoop://catalog/sports | 214 incl. non-current -1,50,54,58,67,68,69,72,116 (rejected by create) |
| POST | `/activities-service/v2/activities` | verified | – | Any type; 409 plain text 'Overlapping activity found for user'; not needed |
| GET | `/activities-service/v2/activities/{id}` | verified | whoop_activity_edit, whoop_activity_log | Raw record; only place with live score_state (incomplete/complete); version, during, type |
| GET | `/activities-service/v2/activity-types` | verified | whoop://catalog/sports, whoop_activity_log, whoop_activity_edit | 208 types {internal_name, display_name, category, score_type, has_gps, msk_linkable}; no sport_id; 'cheeerleading ' typo (don't trim) |
| POST | `/core-details-bff/v0/create-activity` | verified | – | Legacy live Start/Stop (today's totem body). Non-current sport_id → 400; unknown sport_id → HTML 500. Superseded by v2 create. |
| GET | `/core-details-bff/v1/activity-score-type` | verified-quirky | – | RECOVERY → {score_type:RECOVERY}; CARDIO/SLEEP → 400; deleted/nonexistent → {score_type:CARDIO}. Don't use. |
| DELETE | `/core-details-bff/v1/cardio-details` | verified | whoop_activity_delete | 204 for every CARDIO/RECOVERY type and create path; re-delete → 404 text; not tried on SLEEP |
| GET | `/core-details-bff/v1/cardio-details` | verified | whoop_workouts, whoop_lift_sessions, whoop_activity_edit, whoop_activity_delete | 200 for CARDIO/RECOVERY in any state ('---' while unscored); 400 'Cannot view activity details for a pending activity' for pending SLEEP; details_edit_components, link_workout_option_enabled, weightlifting_cardio_details |
| DELETE | `/core-details-bff/v1/recovery-details` | verified | – | 204 on RECOVERY and CARDIO; redundant |
| PUT | `/core-details-bff/v1/recovery-details` | verified | – | Same effect as v2 cardio-details PUT, flat record; works on RECOVERY and CARDIO; redundant |
| GET | `/core-details-bff/v2/activity-type/user-created` | verified | – | recently used types; optional |
| PUT | `/core-details-bff/v2/cardio-details` | verified | whoop_activity_edit | Edit times/type for any type incl. CARDIO↔RECOVERY and nap→sleep; sleep→nap silently refused. 400 bounds; 404; 409 empty list; 412 retry; unknown type → 500 empty. |
| POST | `/core-details-bff/v2/create-activity` | verified | whoop_activity_log | Any v2 type incl. RECOVERY and nap/sleep. 400 unknown name / bad window / no-ms timestamp; 409 structured overlap list; 422 missing field (empty). Future times accepted (→ undeletable cycle). Main sleep re-cycles the day |
| GET | `/core-details-bff/v2/recovery-details` | verified | whoop_workouts | RECOVERY detail (MINUTES, MIN/AVG HR); CARDIO id → 400 'not a recovery activity' |
| GET | `/strap-location-service/v1/garment` | verified | whoop://catalog/garments | garment ids 1,2,3,6,7,9,10,11,12–15 (12–15 GEN_4 only); garment_id is optional and unvalidated on writes |
| GET | `/core-details-bff/v0/cycles/details` | verified | whoop_day | bulk history {records:[{cycle, recovery, sleeps[], workouts[], v2_activities[]}]}, newest first, every cycle overlapping the window; window ≤200 days (else 400); recovery and sleeps not seen live (account never slept): hrv_rmssd is seconds, sleep durations ms |
| GET | `/home-service/v1/home/activities/multi-modifications` | verified | – | Android route (@Acetone1). ?date=. The Edit Activities drawer: ACTIVITY_TILE_SELECTION items (activity_v2_id, during, selectable_state), footer Delete and Merge, limit callouts. |
| PATCH | `/core-details-bff/v1/activities/merge` | verified | whoop_activity_edit | Android route (@Acetone1). ?startTime&endTime, body [ids]. 200: the earliest activity (id, type) now spans the bounds; the others are deleted, in any id order. 422 while an activity inside the bounds is pending. |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/activities-service/v1/activity-types` | not-found | 404 |
| GET | `/activities-service/v1/cycles/aggregate/range/{user_id}` | not-found | legacy list gone |
| GET | `/activities-service/v2/activities` | not-found | ?start&end → 404; no collection GET |
| DELETE | `/activities-service/v2/activities/{id}` | service-only-401 | 401 'Authorization was not valid' even after refresh (2ebbff38); activity untouched |
| GET | `/core-details-bff/v1/recovery-details` | not-found | 405 |
| GET | `/core-details-bff/v2/cardio-details` | not-found | 405 |
| DELETE | `/core-details-bff/v1/activities/merge` | not-found | Android route (@Acetone1). ?id=. 405 Method Not Allowed, so a merge can't be undone. |

### Sleep

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/coaching-service/v1/sleepneed/onboarding` | verified | – | onboarding states TO_DO\|COMPLETE |
| DELETE | `/core-details-bff/v2/sleep-details/{id}` | verified | whoop_activity_delete | 204; cycle structure not restored |
| GET | `/core-details-bff/v2/sleep-details/{id}` | verified | whoop_sleep, whoop_activity_edit, whoop_activity_log | naps + main sleeps by id: labels, edit components (nap_to_sleep_available), sleep_metric_breakdowns (stages, efficiency, latency, RR, wake events), stage bars/hypnogram, HR graph; 404 text |
| PUT | `/core-details-bff/v2/sleep-details/{id}` | verified | whoop_activity_edit | Window edit. resolve_overlaps:true DELETES the overlapped activity. Type is server-derived (1/7 demoted to nap): read back. 409, 412, 422 (one bound). |
| GET | `/sleep-service/v1/heart-rate/baseline` | verified | whoop_sleep | bare JSON number (bpm) |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/coaching-service/v2/sleepneed` | server-error-500 | 500 all run on test account (smart-alarm prefs damage). Capture shape: need_breakdown{baseline,debt,naps,strain,total} ms, recommended_time_in_bed_formatted. Degrade to null. |
| PUT | `/core-details-bff/v2/sleep-details/{id}/nap-to-sleep` | not-found | 404; use cardio-details PUT with activity_internal_name 'sleep' |
| POST | `/vow-service/v1/coaching/vows/sleepcoach` | server-error-500 | read-like; body = sleepneed object; 500 on test account; returns bedtime sentence when healthy |
| GET | `/sleep-service/v1/sleep-events` | not-exercised | hypnogram {during, type LIGHT/REM/SWS/DISTURBANCES} per other open-source clients; not called live (no sleep on the test account); whoop_sleep reads stages from sleep-details instead |
| PUT | `/core-details-bff/v2/sleep-details/nap-to-sleep/{activity_id}` | not-exercised | Android route (@Acetone1). Not sent: whoop_activity_edit already turns a nap into a main sleep through cardio-details. |

### Trends and heart rate

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/coaching-service/v1/performance-assessment/{reportType}/data/{ts}` | verified | whoop_recovery | {is_assessment_needed, has_assessment, total_recoveries, required_recoveries, expected/next_assessment_during} |
| GET | `/progression-service/v3/trends/BODY_COMPOSITION/readings` | verified | – | alias of WEIGHT/readings (POST and DELETE {id} also verified; PUT untried); other graph keys → 400 'Unsupported graph key' |
| GET | `/progression-service/v3/trends/WEIGHT/readings` | verified | whoop_weight | sections.records[].measurements[MEASUREMENT_BOX{id, weight (display), weight_details_screen{timestamp, weight_kg, body_fat_percent (fraction), lean_body_mass_kg, save_title}}], sections.next_token; query params ignored;  |
| POST | `/progression-service/v3/trends/WEIGHT/readings` | verified | whoop_weight_log | 204 no id (re-list). Same-day POST adds. 0<kg≤275; body_fat fraction (>1 → 422). Latest-timestamp reading sets profile weight. |
| DELETE | `/progression-service/v3/trends/WEIGHT/readings/{id}` | verified | whoop_weight_log | 204 always (idempotent); does NOT revert profile weight |
| PUT | `/progression-service/v3/trends/WEIGHT/readings/{id}` | verified | whoop_weight_log | Full replace (omitted optional → null; timestamp required) → 200 stored record; 404 deleted id |
| GET | `/progression-service/v3/trends/{metric}` | verified | whoop_trend | Always week/month/six_month; no year, no range param. Add HR_ZONES_ALL, RESTORATIVE_SLEEP_PERCENT; TOTAL_VOLUME_LOAD and SAGE 500; VO2_MAX week hidden; derive window dates from endDate. |
| GET | `/progression-service/v3/{measurement_type}/manual/readings` | verified | – | Android route (@Acetone1). measurement_type vo2max (VO2_MAX, VO2MAX, vo2_max: 404). Records list plus the Add Manual Value sheet: timestamp, vo2_max_value, mL/kg/min, sources MANUAL_LAB_TEST, MANUAL_WEARABLE, MANUAL_OTHER. |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/progression-service/v3/trends/WEIGHT/readings/paginated` | exists-but-unclear | page 2+; made-up tokens 400; real token unverified (first page = 100 on main) |
| GET | `/progression-service/v3/trends/WEIGHT/readings/{id}` | not-found | 405 |
| GET | `/progression-service/v{2,4}/trends/{metric}` | not-found | 404 |
| POST | `/vo2max-service/v2/{measurement_type}/manual` | exists-but-unclear | Android route (@Acetone1). vo2max: 422 with an empty body for six shapes built from the sheet's fields (VO2_MAX: 404). Body unknown; nothing was created. |

### Strength Trainer

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/progression-service/v3/exercise/{id}` | verified | whoop_lift_exercise | AVG VOLUME LOAD segments |
| GET | `/weightlifting-service/v1/exercise/{id}` | verified | whoop_lift_exercise, whoop_lift_log, whoop_lift_exercise_set | alive: catalog ids, custom uuids, deleted customs (deleted:true); row usable verbatim as exercise_details |
| GET | `/weightlifting-service/v1/link-workout` | verified | – | link screen (templates, AI auto-link) |
| POST | `/weightlifting-service/v2/custom-exercise` | verified | whoop_lift_exercise_set | Create and edit (upsert by exercise_id). linked_exercise makes it trackable. laterality/exercise_type ignored. Bare 422. |
| DELETE | `/weightlifting-service/v2/custom-exercise/{uuid}` | verified | whoop_lift_exercise_set | 204 idempotent soft delete; v1/exercise still returns deleted:true; v3/prs tile remains |
| GET | `/weightlifting-service/v2/exercise` | verified | whoop://catalog/exercises, whoop_lift_log | 371 base rows + customs + filter_options |
| GET | `/weightlifting-service/v2/prebuilt-workout-template/{id}` | verified | whoop_lift_library, whoop_lift_template | WHOOP prebuilt workout detail |
| POST | `/weightlifting-service/v2/weightlifting-workout/activity` | verified | whoop_lift_log | Bare 422 on any schema error; 409 text on overlap (nothing deleted). weight in profile display unit. Saved window = union(during, set durings). Set without during = not performed. 0-rep weighted set wins a PR. |
| POST | `/weightlifting-service/v2/weightlifting-workout/link-cardio-workout` | verified | whoop_lift_log | Attach sets to an existing activity. template_id:-1 works (no template). 422 without template_id; 409 already linked; no unlink. Works while link_workout_option_enabled is false. |
| DELETE | `/weightlifting-service/v2/workout-template/{key}` | verified | whoop_lift_template | 204 idempotent |
| GET | `/weightlifting-service/v2/workout-template/{key}` | verified | whoop_lift_library, whoop_lift_template | user templates and AI drafts (is_draft); 404 HTML for deleted/prebuilt |
| GET | `/weightlifting-service/v3/exercise/{id}` | verified | whoop_lift_exercise | UI BFF; don't parse |
| GET | `/weightlifting-service/v3/exercise/{id}/exercise_history` | verified | whoop_lift_exercise, whoop_lift_sessions | one card per workout; sets without during excluded |
| GET | `/weightlifting-service/v3/exercise/{id}/personal_records` | verified | whoop_lift_exercise | cards per medal |
| DELETE | `/weightlifting-service/v3/one-rep-max/manual-entry/{entry_id}` | verified | whoop_lift_exercise_set | 204; estimate reverts; re-delete 404 'No manual one rep max entry' |
| GET | `/weightlifting-service/v3/one-rep-max/{exercise_id}` | verified | whoop_lift_exercise | value + Estimated/Manual; limits 1–999, 6 months back |
| PUT | `/weightlifting-service/v3/one-rep-max/{exercise_id}` | verified | whoop_lift_exercise_set | 204. Create; with id = edit; same date w/o id = replace. Value in display unit. 400s: 1–999, >6 months back, future. e1rm_eligible not enforced. |
| GET | `/weightlifting-service/v3/one-rep-max/{exercise_id}/history` | verified | whoop_lift_exercise, whoop_lift_exercise_set | MEASUREMENT_ENTRY_ITEMs; manual entry uuid only inside generic_interaction |
| GET | `/weightlifting-service/v3/prs` | verified | whoop_lift_exercise, whoop_lift_sessions | tiles (no record_date/medal); stale tiles survive deletion; deleted customs flagged; dedupe by exercise_id |
| GET | `/weightlifting-service/v3/workout-library` | verified | whoop_lift_library | my_workouts_list[{workout_template_key, name, source, created_at,…}], whoop_workouts_list[{id (string), title, paragraph, tag}]; no pagination; drafts not listed |
| POST | `/weightlifting-service/v3/workout-template` | verified | whoop_lift_template | Create (no key or -1); edit in place with existing key (±source); unknown key silently creates new. Sets {number_of_reps, weight?, time_in_seconds?}. |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| PUT | `/weightlifting-service/v2/custom-exercise/{uuid}` | not-found | 405 (also on collection) |
| GET | `/weightlifting-service/v2/exercise/{id}` | not-found | 404 |
| GET | `/weightlifting-service/v3/workout-template/{key}` | not-found | 404 (DELETE too) |
| POST | `/weightlifting-service/v3/workout-template/{key}/duplicate` | not-found | 404 (v2 too); copy = GET + POST without key |
| GET | `/core-details-bff/v1/strength-workout/exercises` | not-found | Android route (@Acetone1). 404 with totem's iOS identity, as are /exercises/{id}, /history and /suggested (catalog ids like BENCHPRESS_BARBELL). |

### Journal

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/activities-service/v1/journals/behaviors/user` | verified | whoop_preferences, whoop_preferences_set | same data + total_count |
| PUT | `/activities-service/v1/journals/behaviors/user` | verified | whoop_preferences_set | Full tracked set (replace); untracking keeps old answers |
| GET | `/activities-service/v1/journals/stats/user/{user_id}` | verified | whoop_journal | yes/no counts per behavior (own id) |
| GET | `/ai-conversation-bff/v1/widget/journal/custom-behavior-proposal` | verified | – | proposal card (EDITABLE) |
| PUT | `/ai-conversation-bff/v1/widget/journal/custom-behavior-proposal/commit/{proposalId}` | verified | – | Creates a PERMANENT custom behavior (body {}; POST 405; no body 422). Not wrapped. |
| GET | `/behavior-impact-service/v1/impact` | verified | whoop_journal | new accounts nest member-average impact_cards under HEADER_ITEMS_CARD; walk recursively |
| GET | `/behavior-impact-service/v1/impact/summary-card/{date}` | verified | – | summary card |
| GET | `/journal-service/v1/journals/behaviors/{id}` | verified | – | single tracker; works for custom ids |
| GET | `/journal-service/v1/journals/preferences` | verified | whoop_preferences | {journal_enabled, journal_autopop_enabled, ai_autopop_enabled, …} |
| PUT | `/journal-service/v1/journals/preferences` | verified | whoop_preferences_set | Merges keys; journal_enabled required (422 otherwise) |
| GET | `/journal-service/v1/widget/talk-text/{date}` | verified | – | journal-agent entry; isIntraday=false points at yesterday |
| PUT | `/journal-service/v2/journal/entry/partial` | verified | whoop_journal_log | Merge across rows, replace within row; bare row clears; notes ignored; multi-date; 400 'Cannot log menstruation and ovulation at the same time' when 43+79 yes in one request. |
| GET | `/journal-service/v2/journals/behaviors` | verified | – | 308 records = totem bundle; excludes 171 and customs |
| GET | `/journal-service/v2/journals/behaviors/user/{date}` | verified | whoop://catalog/behaviors, whoop_journal, whoop_journal_log | 309 incl. 171 + custom; full trackers with magnitude specs |
| PUT | `/journal-service/v2/journals/entries/user/date/{date}` | verified | whoop_journal_log | Replace-all: unlisted rows deleted; omitted/'' notes → null. 400 text, atomic. One 204 didn't land during cycle reshuffle: read back. |
| GET | `/journal-service/v3/journals/behaviors` | verified | whoop_journal_log, whoop_preferences, whoop_preferences_set | customize-journal BFF (toggles, custom flag, custom_behaviors_widget) |
| GET | `/journal-service/v3/journals/date-picker/{date}` | verified | – | per-day status + fill_ratio |
| GET | `/journal-service/v3/journals/drafts/mobile/{date}` | verified | whoop_journal, whoop_journal_log | tracked_behaviors[{behavior_tracker, tracker_input}], notes (null when empty), cycle_id (may change), keyed by date |
| GET | `/journal-service/v3/journals/home-tile` | verified | – | 400 without date |
| GET | `/journal-service/v2/journals/{date}/calendar` | verified | whoop_calendar | Android route (@Acetone1). days_of_month[{date_value_display, cycle_id, day_state HAS_JOURNAL_ENTRY \| NO_DATA, has_data}] for the date's month. |
| GET | `/journal-service/v1/journals/behaviors/user` | verified | – | Android route (@Acetone1). The v1 tracker catalog (~309 rows with title, category, question_text). totem reads v3 behaviors instead. |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| PUT | `/ai-conversation-bff/v1/widget/journal/custom-behavior-proposal/uncommit/{proposalId}` | not-found | 404 |
| GET | `/autopop-service/v1/autopop/JOURNAL/{cycle_id}` | not-found | 405 |
| PUT | `/autopop-service/v1/autopop/JOURNAL/{cycle_id}` | exists-but-unclear | 204 with/without {} body; no visible effect; tool dropped |
| GET | `/behavior-impact-service/v1/impact/details/{uuid}` | exists-but-unclear | same 400 |
| GET | `/behavior-impact-service/v1/impact/journal-trends/{uuid}` | server-error-500 | 500 for non-user uuid |
| GET | `/behavior-impact-service/v2/impact/details/{uuid}` | exists-but-unclear | 400 'Requested impact not found.' for member-average uuids; personal payload unverified live |
| POST | `/journal-service/v1/journals/behaviors` | service-only-401 | 401 |
| POST | `/journal-service/v1/journals/behaviors/{id}` | not-found | 405 (DELETE too) |
| PUT | `/journal-service/v1/journals/behaviors/{id}` | service-only-401 | 401 even with valid session (1f70f0ff) |
| POST | `/journal-service/{v1,v3}/journals/behaviors/custom` | not-found | custom-behavior REST create/edit/delete: 12 guesses (405/404/401); none exist. Delete = untrack. |
| GET | `/journal-service/v1/journals/stats/user/{cycle_id}` | exists-but-unclear | Android route (@Acetone1). records[{behavior_tracker_id, yes_count, no_count, last_value}] for ~310 trackers. Counts are neither lifetime nor as-of (an older cycle gave a higher count), so unused. |

### WHOOP Coach

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| POST | `/ai-conversation-bff/v1/conversation` | verified | whoop_coach_ask, whoop_coach_history | Create/reopen keyed by fingerprint. Reopen of listed fp: no side effects. Unlisted fp: creates; daily-outlook___cycle___{id}/day-in-review___cycle___{id} GENERATES. |
| DELETE | `/ai-conversation-bff/v1/conversation/{fingerprint}` | verified | – | 204; UUID alias entry needs own DELETE; not wrapped in v2.0 |
| GET | `/ai-conversation-bff/v1/conversation/{fingerprint}/suggestions` | verified | whoop_coach_ask | {suggestions[]} |
| POST | `/ai-conversation-bff/v1/conversation/{fingerprint}/turn` | verified | whoop_coach_ask | Address by fingerprint (UUID works but creates phantom list entry). 409 while a turn is ACTIVE. |
| GET | `/ai-conversation-bff/v1/conversation/{fingerprint}/turn/{turnId}` | verified | whoop_coach_ask, whoop_coach_history | ONLY by fingerprint (UUID/list id → HTML 404). Poll until COMPLETE; join all MARKDOWN_CHAT_TEXT across assistant messages. |
| POST | `/ai-conversation-bff/v1/conversation/{fingerprint}/turn/{turnId}/seen` | verified | – | read receipt; never send (also /end-seen, /{fp}/last-viewed-turn) |
| GET | `/ai-conversation-bff/v1/conversations` | verified | whoop_coach_history | grouped by day; entry id ≠ metadata.id; only conversations with a user turn + outlooks |
| POST | `/ai-conversation-bff/v1/files` | verified | whoop_coach_ask | → {file_id:'<uuid>.png', size}; attach via turn file_ids |
| DELETE | `/ai-conversation-bff/v1/files/{file_id}` | verified | whoop_coach_ask | 204; deleted id silently dropped if re-attached |
| GET | `/ai-conversation-bff/v1/recommendation-widget` | verified | – | RECOMMENDATION_TILEs; deferred |
| POST | `/ai-conversation-bff/v1/recommendations/{id}/commit` | verified | – | no body; COMMITTED; no visible side effect; deferred |
| POST | `/ai-conversation-bff/v1/recommendations/{id}/uncommit` | verified | – | no body; UNCOMMITTED; deferred |
| GET | `/ai-conversation-service/v1/settings` | verified | whoop_preferences | WHOOP_COACH, _DATA, _CONCISE, _MEMORY |
| PUT | `/ai-conversation-service/v1/settings` | verified | whoop_memory_set | memory off → coach still claims to remember but stores nothing |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/ai-conversation-bff/v1/files/{file_id}` | not-found | 405 |
| POST | `/ai-conversation-bff/v1/recommendations/generate-alternatives` | exists-but-unclear | seen in widget; not called |

### Coach memory

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/context-hub-bff/v1/context-hub` | verified | – | landing LIST (talk-text widget, snapshot tiles, filtered list path) |
| DELETE | `/context-hub-bff/v1/context-hub/context-detail/{id}` | verified | whoop_memory_set | 204 permanent |
| GET | `/context-hub-bff/v1/context-hub/context-detail/{id}` | verified | whoop_memory | MARKS ITEM SEEN (read receipt); deleted id → 500 HTML |
| PUT | `/context-hub-bff/v1/context-hub/context-detail/{id}/status` | verified | whoop_memory_set | 204 |
| GET | `/context-hub-bff/v1/context-hub/items` | verified | whoop_memory | CONTEXT_CARDs; dynamic categories; no pagination |

### Cycle tracking (Hormonal Insights)

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| POST | `/health-service/v1/hormonal-insights/settings/hormonal-goals` | verified | – | 204 replace; not wrapped (D13) |
| POST | `/health-service/v1/hormonal-insights/settings/mci` | verified | – | every call appends a contraception history row; not wrapped |
| PUT | `/health-service/v1/hormonal-insights/settings/mci/overlay` | verified | – | Not wrapped (D13) |
| GET | `/health-service/v1/pregnancy/onboarding/welcome` | verified | – | due-date window |
| GET | `/womens-health-service/v1/hormonal-insights/calendar` | verified | – | current month only; date ignored |
| GET | `/womens-health-service/v1/hormonal-insights/cycle-log-polling` | verified | – | internal post-log poll |
| GET | `/womens-health-service/v1/hormonal-insights/onboarding` | verified | – | survey enum source |
| GET | `/womens-health-service/v1/hormonal-insights/overview` | verified | whoop_cycle | HEADER_TILE, HORMONAL_INSIGHTS_CALENDAR_DAY days, SECTIONs (journal, trends & patterns); 400 before onboarding |
| GET | `/womens-health-service/v1/hormonal-insights/settings` | verified | whoop_cycle | drawers: mode MENSTRUATING\|PREGNANCY, contraception (8), goals; overlay toggle; previous pregnancies |
| GET | `/womens-health-service/v1/menstrual-cycle-insights` | verified | whoop_cycle | OLD screen, still alive; TYPICAL_CYCLE_TILE/CYCLE_PHASE_COACHING nested in MCI_TILE_SECTION (fallback source) |
| GET | `/womens-health-service/v1/menstrual-cycle-insights/cycles` | verified | whoop_cycle | cycles list; hide/unhide write path not exposed |
| GET | `/womens-health-service/v1/menstrual-cycle-insights/cycles/edit` | verified | – | read-only edit view |
| PUT | `/womens-health-service/v1/menstrual-cycle-insights/log` | verified | whoop_cycle_log | 200. Several entries per call; both period+ovulation same day → 400; period on empty date creates a sticky cycle; writes journal 43/79. |
| GET | `/womens-health-service/v1/menstrual-cycle-insights/symptoms` | verified | whoop_cycle | symptom tick rows per cycle segment |
| GET | `/womens-health-service/v1/pregnancy/edit` | verified | – | enum source |
| GET | `/womens-health-service/v1/pregnancy/screen` | verified | – | 404 text 'Pregnancy Settings turned off for user' when none active |
| GET | `/womens-health-service/v1/pregnancy/{id}` | verified | – | postpartum summary; method/weight not in read |
| PUT | `/womens-health-service/v1/pregnancy/{id}` | verified | – | 204; NO enum validation (BOGUS accepted); not wrapped |
| POST | `/womens-health-service/v1/symptom-insights/log/symptoms` | verified | whoop_cycle_log | tracker_inputs merge; menstruation & cervical_mucus REPLACE (omit = clear); flow logs a period day; invalid enum → 422 |
| GET | `/womens-health-service/v1/symptom-insights/log/symptoms/screen` | verified | whoop_cycle, whoop_cycle_log | current day selections + live enums (menstruation, cervical_mucus, symptom ids) |
| GET | `/womens-health-service/v1/menstrual-cycle-insights/deep-dives` | verified | – | Android route (@Acetone1). Static phase guidance for the four phases (45 KB). |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| DELETE | `/health-service/v1/hormonal-insights/settings/mci` | not-exercised | disables HI; can't be restored |
| PUT | `/health-service/v1/hormonal-insights/settings/mci/survey` | not-exercised | onboarding; rewrites period history |
| PUT | `/health-service/v1/pregnancy/settings` | exists-but-unclear | only a 400 probe; real call creates a pregnancy and switches mode |

### Weekly Plan

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/progression-service/v1/weekly-plan` | verified | whoop_weekly_plan | Mon–Sun; no plan → locked PLAN_TILEs; plan → CURRENT_PLAN_TILE{plan_id}, goal_section[{id TargetGoalType}] |
| GET | `/progression-service/v1/weekly-plan/presets` | verified | whoop_weekly_plan | plan tiles + cancel copy |
| GET | `/progression-service/v2/weekly-plan/home-tile/{date}` | verified | whoop_weekly_plan | WEEKLY_PLAN_HOME_TILE (plan) or TEXT_WITH_ILLUSTRATION (none) |
| GET | `/progression-service/v2/weekly-plan/setup` | verified | whoop_weekly_plan_set | {plan_id, screens[]}; plan_id random per call until a plan record exists; ?screens= one of STRAIN, SLEEP_PERFORMANCE, SLEEP_CONSISTENCY, ACTIVITIES, BEHAVIORS, WEIGHT, STEPS, HR_ZONES_ONE_TO_THREE, HR_ZONES_FOUR_TO_FIVE, STRENGTH_TRAINING_TIME, SLEEP_HOURS |
| PUT | `/progression-service/v2/weekly-plan/{plan_id}/goal/target` | verified | whoop_weekly_plan_set | 204. Creates Custom plan / edits / adds a goal. Verified STEPS, STRENGTH_TRAINING_TIME only. {} → 422. |
| DELETE | `/progression-service/v2/weekly-plan/{plan_id}/goal/target/{type}` | verified | whoop_weekly_plan_set | 204; removing the last goal ends the plan in the UI (empty record persists) |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/progression-service/v2/weekly-plan/setup/overview/{plan}` | server-error-500 | 500 (Cloudflare HTML) on test account; 200 on main |
| PUT | `/progression-service/v2/weekly-plan/{plan_id}` | exists-but-unclear | PutPlanRequest; every body 422. Don't call. |
| DELETE | `/progression-service/v{1,2}/weekly-plan/{plan_id}` | server-error-500 | always 500. Don't call. |
| PUT | `/progression-service/v2/weekly-plan/{plan_id}/goal/activity` | exists-but-unclear | Android route (@Acetone1). 204 for every body tried ({}, and goals/activities/goal_settings lists of tile ids like ANY_STRAIN), with and without a plan; nothing changed. Tiles: setup?screens=ACTIVITIES. |
| PUT | `/progression-service/v2/weekly-plan/{plan_id}/goal/behavior` | exists-but-unclear | Android route (@Acetone1). 204 for {}; nothing changed. Tiles come from setup?screens=BEHAVIORS (behavior tracker ids, AVOID options). |
| DELETE | `/progression-service/v2/weekly-plan/{plan_id}/goal/activity` | exists-but-unclear | Android route (@Acetone1). 204 (and the same for goal/behavior); the test plan had no such goals to remove. |
| GET | `/progression-service/v2/weekly-plan/setup/overview` | server-error-500 | Android route (@Acetone1). 500 on the test account. |

### Smart Alarm

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| POST | `/smart-alarm-bff/v1/schedule` | verified | whoop_smart_alarm_set | Create; steals overlapping days; turns master switch on; returns rows ([0].schedule_id) |
| GET | `/smart-alarm-bff/v1/schedule/components` | verified | whoop_smart_alarm_set | enum source: alarm_mode_value, sleep_goal_value; wake_time says 'Alarm will vibrate between %s - %s' for IN_THE_GREEN and SLEEP_GOAL only |
| GET | `/smart-alarm-bff/v1/schedule/components/populated/{id}` | verified-quirky | – | sleep_goal toggle_selected ALWAYS PEAK (PR #39 relies on it wrongly) |
| PUT | `/smart-alarm-bff/v1/schedule/{id}` | verified | whoop_smart_alarm_set | In-place edit (upsert; [] days clears). On damaged account: saves rows then 500. |
| GET | `/smart-alarm-service/v1/alarm-schedule` | verified | whoop_smart_alarm, whoop_smart_alarm_set | SOURCE OF TRUTH: rows {schedule_id, day_of_week, upper_time_bound HH:MM:SS, goal (incl. SLEEP_HEALTH_*), enabled, deleted}; works during damage |
| DELETE | `/smart-alarm-service/v1/alarm-schedule/{id}` | verified | whoop_smart_alarm_set | 204 idempotent |
| GET | `/smart-alarm-service/v1/alarm-schedule/{id}` | verified | whoop_smart_alarm_set | rows for one schedule; [] if unknown/empty |
| GET | `/smart-alarm-service/v1/user-info/default-wake-window` | verified | whoop_smart_alarm | Android route (@Acetone1). {default_wake_window_minutes} (60). IN_THE_GREEN and SLEEP_GOAL buzz between the latest wake time minus this and the latest wake time. |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/smart-alarm-bff/v1/preferences` | not-found | 404 (PUT too) |
| GET | `/smart-alarm-bff/v1/schedule/all` | server-error-500 | Verified before damage; now 500. alarm_mode lossy (disabled → NO_ALARM), no sleep_goal, 12-h display time |
| DELETE | `/smart-alarm-bff/v1/schedule/{id}` | not-found | 405 |
| PUT | `/smart-alarm-service/v1/alarm-schedule/disable` | server-error-500 | Verified 204 before damage (prefs schedule_enabled:false, enabled:false); now 500 |
| PUT | `/smart-alarm-service/v1/alarm-schedule/enable` | server-error-500 | Verified 204 before damage (re-derives prefs from next day); now 500 |
| GET | `/smart-alarm-service/v1/smartalarm/preferences` | server-error-500 | Verified before damage (next-alarm object); 500 since 02:40:33Z |
| POST | `/smart-alarm-service/v1/smartalarm/preferences` | not-found | 405 (DELETE too) |
| PUT | `/smart-alarm-service/v1/smartalarm/preferences` | server-error-500 | Verified for 7 safe goals before damage; ALARM_OFF_PEAK / EXACT_TIME_WEEKLY_PLAN / EXACT_TIME_SLEEP_HOURS broke the account. SAFE GOALS ONLY; never weekly_plan_goal/default. |
| POST | `/smart-alarm-service/v1/smartalarm/wbl` | exists-but-unclear | BLE alarm telemetry; only [] sent; don't wrap |
| GET | `/smart-alarm-service/v1/strap-status` | not-found | 405 |
| PUT | `/smart-alarm-service/v1/strap-status` | blocked-by-policy | App pushes alarm time to strap here; blocked; totem can't send it → alarms sync only via the app |
| GET | `/smart-alarm-service/v1/smartalarm/poll` | server-error-500 | Android route (@Acetone1). 500 on the test account, whose alarm preferences 500 too. |
| PATCH | `/smart-alarm-service/v1/smartalarm/preferences/timezone` | server-error-500 | Android route (@Acetone1). {time_zone_offset: profile offset} answered 500 on the test account (preferences already broken); stopped there. Untested on a healthy account. |
| PUT | `/smart-alarm-service/v1/smartalarm/override` | not-exercised | Android route (@Acetone1). Not sent: the test account's alarm preferences 500, so there was no value to restore. |

### Milestones and streaks

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/achievements-service/v1/progression` | verified | – | static 2021 level table, not user progress. Don't use. |
| GET | `/milestones-service/v1/bff/milestones/hub` | verified | whoop_milestones | counts + tag grids (all, sleep, recovery, strain, healthspan, other, activities) |
| GET | `/milestones-service/v1/bff/milestones/{type}/details` | verified | whoop_milestones | progress card + earned grid; unknown type → 400 text |
| GET | `/milestones-service/v1/bff/milestones/{type}/pill` | verified | – | lottie pill + count |
| GET | `/streaks-service/v1/bff/streaks/data-streak` | verified | whoop_milestones | streak detail (started, max, week tracker) |
| GET | `/streaks-service/v1/bff/streaks/data-streak/share` | verified | – | share assets |
| GET | `/streaks-service/v1/streaks/data-streak` | verified | whoop_milestones | {streak_value, streak_state} |

### Profile and settings

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/home-service/v2/home/dashboard/customize` | verified | whoop_preferences, whoop_preferences_set | gauge_metrics[4] (0 RECOVERY, 2 DAY_STRAIN fixed), pinned/unpinned sections |
| POST | `/hr-zones-service/v1/bff/custom` | verified | whoop_hr_zones_set | 5 contiguous zones (gap/overlap → 400 'Invalid custom zones submitted'; 4 zones → 422); Z5 max clamped; reset = defaults + is_custom:false |
| GET | `/hr-zones-service/v1/bff/settings` | verified | whoop_profile, whoop_hr_zones_set | is_custom = manual_heart_rate_zones_form.toggle_value; zone_rows effective; default_hr_zones for reset |
| GET | `/hr-zones-service/v1/bff/zones` | verified | whoop_profile, whoop_hr_zones_set | zones ZONE_0..5; NO is_custom |
| POST | `/hr-zones-service/v1/maxhr` | verified | whoop_hr_zones_set | 200 zones (HRR); 100/221/230 → 400; keeps custom zones but response shows defaults |
| GET | `/notification-service/v1/notifications/user-settings/bff` | verified | whoop_preferences, whoop_preferences_set | settings[{push_namespace StressSummary\|GPS\|ConversationalCheckIn\|CheckIn, active}] |
| PUT | `/notification-service/v1/notifications/user-settings/block/namespace` | verified | whoop_preferences_set | block; idempotent; case-sensitive (unknown → 400 'Namespace does not exist') |
| DELETE | `/notification-service/v1/notifications/user-settings/block/namespace/{ns}` | verified | whoop_preferences_set | unblock; unknown ns → 200 no-op |
| PUT | `/profile-service/v1/profile` | verified | whoop_profile_update | Full replace → true / false (rejected). Omit city clears; omit baseline keeps; state required for US; gender MALE\|FEMALE\|NON_BINARY\|PREFER_NOT; birthday/country invalidate session. |
| GET | `/profile-service/v1/profile/bff/edit` | verified | whoop_profile, whoop_profile_update | MERGE SOURCE: every PUT field in PUT format + locked_fields, countries, UI bounds |
| PUT | `/user-preferences-service/v1/home/dashboard/customize` | verified | whoop_preferences_set | 204; exactly 2 gauges (omit → reset to HRV+SLEEP_PERFORMANCE); pinned full ordered replace |
| DELETE | `/users-service/v1/hidden-metrics/{metric}` | verified | whoop_preferences_set | show; 204 idempotent |
| GET | `/users-service/v1/hidden-metrics/{metric}` | verified | whoop_profile | {is_hidden}; no server enum |
| POST | `/users-service/v1/hidden-metrics/{metric}` | verified | whoop_preferences_set | hide; 204 idempotent; any string accepted → allow BODY_COMP\|HEALTHSPAN only |
| GET | `/users-service/v1/stealth-mode` | verified | whoop_profile | bare JSON boolean |
| PUT | `/users-service/v1/stealth-mode` | verified | whoop_preferences_set | {enabled:true} or bare false → bare boolean |
| POST | `/users-service/v1/users/preferences/time` | verified | whoop_preferences_set | clock_format write; same values → existing row. Never change timezone. |
| PUT | `/users-service/v1/users/profile/offset` | verified | – | ZoneOffset parse; same-value write only; not for tools |
| GET | `/users-service/v2/bootstrap` | verified | whoop_profile, (client: unit helper, init_timezone), whoop_community, whoop_preferences_set, whoop_weight_log | physiological_baseline always null; gender display strings; profile.weight follows latest weight reading |
| GET | `/users-service/v2/bootstrap/{account\|user\|membership}` | verified | – | sub-resources |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/notification-service/v1/notifications/user-settings` | not-found | 404 (block/namespace GET → 405) |
| GET | `/users-service/v1/hidden-metrics` | not-found | 404 |
| GET | `/users-service/v1/users/preferences/time` | service-only-401 | 401 even after refresh (499cba4b) |

### Privacy

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/privacy-service-bff/v1/community/privacy/activity-summary` | verified | – | 163 KB |
| GET | `/privacy-service-bff/v1/screen/community` | verified | – | 230 KB BFF with PUT templates; too heavy |
| GET | `/privacy-service/v1/community/privacy/settings` | verified | whoop_profile | best read; sleep/recovery/strain composite strings (no_one, no_one_no_daily_stats, friends_no_daily_stats, friends_no_trends, friends_score_only) |
| PUT | `/privacy-service/v1/community/privacy/settings/{setting}` | verified | – | verified for sleep/recovery/searchable; not wrapped in v2.0 (D13); missing version → 422 |
| GET | `/privacy-service/v1/user_privacy_settings` | verified | – | {searchable, mutual_community_sharing, allow_recommendation}; trailing slash optional |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/privacy-service/v1/community/privacy` | not-found | 404 |
| PUT | `/privacy-service/v1/community/privacy/settings/access_*` | blocked-by-policy | consents; never wrap |

### Integrations

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/integrations-bff/v1/integrations/discovery` | verified | whoop_profile | 11 integrations {id, reporting_key, connected} |
| GET | `/integrations-bff/v1/integrations/{id}/details` | verified | whoop_profile | strava → 500, apple-health → 404. STRIP connection_url (live OAuth + state nonce) |
| GET | `/integrations-bff/v2/integrations/{id}/details` | verified | whoop_profile | peloton and zwift only; connection_sections; strip cta_connection_url |
| GET | `/social-service/v1/strava/bff/settings` | verified | whoop_profile | state; strip authorization URLs |

### Community

Seen working in the captures (the probe skipped these):

| Method | Path | Used by | Notes |
|---|---|---|---|
| GET | `/community-service/v1/communities/memberships` | whoop_community | Probes excluded social; capture says works. Own memberships only (D9). |
| GET | `/community-service/v1/leaderboards/communities/{communityId}/{window}/{metric}/{kind}` | whoop_community | Probes excluded social; capture 200×109 (404×89: no data in the window). A community's full ranking, paged by offset and limit; window is a date or average/week\|month (averages add startDate, endDate, includeCompliance, complianceCutoff). Other people's names and scores: read live, never cached (D9). |
| GET | `/community-service/v1/leaderboards/communities/{communityId}/{window}/{metric}/{kind}/user/{own_user_id}` | whoop_community | Your own row on that board (404 when you have no data in the window); whoop_community shows it beside the full ranking. |
| GET | `/followers-service/v1/badging` | – | Probes excluded social; capture 200×10. {show_community_badge}. |
| GET | `/followers-service/v1/followers-home/following` | whoop_community | Probes excluded social; capture 200×3. The people you follow, with the scores each shares with you: read live, never cached (D9). |
| GET | `/followers-service/v1/followers-home/manage/FOLLOWING` | – | Probes excluded social; capture 200×10. The manage-following screen's list. |
| POST | `/followers-service/v1/following/{user_id}` | – | Probes excluded social; capture 200×53. Follow someone. A social write: whoop_raw only (D9). |
| GET | `/followers-service/v1/moments/preview` | – | Probes excluded social; capture 200×3. An activity's share preview. |
| GET | `/followers-service/v1/onboarding` | – | Probes excluded social; capture 200×2. The follow-onboarding screen. |
| PUT | `/followers-service/v1/onboarding` | – | Probes excluded social; capture 200×1. Who can follow you. A social write: whoop_raw only (D9). |
| GET | `/followers-service/v1/snapshots/daily/{user_id}` | whoop_community | Probes excluded social; capture 200×14 (404×81: they share nothing with you). One person's daily scores: read live, never cached (D9). |
| GET | `/followers-service/v1/snapshots/{snapshot_id}/comments` | whoop_community | Probes excluded social; capture 200×10. Comments on a snapshot: read live, never cached (D9). |

### Health Monitor and the paid health features

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/advanced-labs-service/v1/advanced-labs` | verified | – | upsell-only BFF without results; no whoop_labs in v2.0 |
| GET | `/metrics-service/v1/metrics/user/{user_id}` | verified | whoop_day, whoop_now | continuous heart rate {values:[{time ms, data bpm}]}, sparse (holes, no padding); step must be 6, 60 or 600 (else 400); any window; another user's id → 403 |
| GET | `/healthspan-service/v1/healthspan/bff` | verified | whoop_health | Android route (@Acetone1). ?date=. {unlocked_content, locked_content}; locked on the test account ('21 SLEEPS TO UNLOCK'). Unlocked shape seen on a second real account (2026-11-22): whoop_age_amoeba / previous_whoop_age_amoeba (age, years vs actual age, pace of aging), date_picker range, and TILE_SECTION > CONTRIBUTORS_CONTAINER contributors (6 month avg, 30 day avg, impact in years). whoop_health projects those. |
| GET | `/healthspan-service/v1/widget` | verified | – | Android route (@Acetone1). {amoeba, locked_content}; locked on the test account. |
| GET | `/sage-service/v1/sage/bff` | verified | whoop_health | Android route (@Acetone1). ?date=. Blood Pressure Insights, same locked/unlocked shape; locked ('UPGRADE FOR ACCESS', WHOOP Life). |
| GET | `/sage-service/v1/sage/manual/input` | verified | – | Android route (@Acetone1). Manual blood pressure screens (guidelines, reading input). |
| GET | `/advanced-labs-service/v1/advanced-labs/biomarkers/summary` | verified | whoop_health | Android route (@Acetone1). Pie chart plus SEARCHABLE_BIOMARKERS_LIST biomarkers[{id, title, value, unit, status_type}]: 100 rows, all '--' and UNAVAILABLE without results (46 KB). |
| GET | `/advanced-labs-service/v1/advanced-labs/tests/history` | verified | whoop_health | Android route (@Acetone1). Lab History; one empty-tile section without tests. |
| GET | `/arrhythmia-service/v2/afibhistory/screen` | verified | whoop_health | Android route (@Acetone1). 404 'No anf user found' until irregular rhythm notifications are set up (also /v2/settings). |
| GET | `/arrhythmia-service/v1/about` | verified | – | Android route (@Acetone1). Static regulatory page. The Android list has no read route for ECG readings. |
| GET | `/advanced-labs-service/v1/advanced-labs/biomarkers/{biomarker_id}` | verified | whoop_health | Android route (@Acetone1). ?next_token=. {navigation_title, header{title, subtitle, pills}, sections, status}; without results status UNAVAILABLE with an Add Lab Results tile (seen live); an unknown id is 404. Filled-in shape unseen. |
| GET | `/ecg-service/v1/ecg/about` | verified | – | Android route (@Acetone1). {page_title, information_items[{info_label, info_value}]}: the ECG feature's regulatory facts. The Android list has no route that reads ECG recordings. |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/arrhythmia-service/v2/afibhistory/paginated` | not-exercised | Android route (@Acetone1). ?next_token=. The next page of AFib history. Used by whoop_health (experimental); never seen filled in: no test account has the feature. |
| GET | `/arrhythmia-service/v1/history/bff` | not-exercised | Android route (@Acetone1). ?historyDate=. One day of AFib history. Used by whoop_health (experimental); never seen filled in: no test account has the feature. |
| GET | `/advanced-labs-service/v1/advanced-labs/tests/{test_id}` | not-exercised | Android route (@Acetone1). One lab test's results; an unknown id is 404. Used by whoop_health (experimental); never seen filled in: no test account has the feature. |
| GET | `/advanced-labs-service/v1/advanced-labs/insights` | not-exercised | Android route (@Acetone1). ?testId=. Insights for one lab test. Used by whoop_health (experimental); never seen filled in: no test account has the feature. |

### Developer API (the public API's v2 paths, readable with an app token)

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/developer/v2/activity/sleep` | verified | – | 200 records:[] (only scored records; account has none); shape unverified live |
| GET | `/developer/v2/activity/workout` | verified | – | Works with web token but OMITS pending/incomplete cardio; RECOVERY as SCORED score:null; app never calls it. Off by default (D1). |
| GET | `/developer/v2/cycle` | verified | – | cycle records incl. undocumented step_count |
| GET | `/developer/v2/recovery` | verified | – | 200 records:[]; shape unverified live |
| GET | `/developer/v2/user/measurement/body` | verified | – | {height_meter, weight_kilogram, max_heart_rate} |
| GET | `/developer/v2/user/profile/basic` | verified | – | {user_id, email, first_name, last_name} |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/developer/v2/activity/workout/{id}` | not-found | 404 |

### Sign-in

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| POST | `/auth-service/v3/whoop/` | decided | (client: token_manager) | Cognito proxy. x-amz-target AWSCognitoIdentityProviderService.InitiateAuth, AuthFlow REFRESH_TOKEN_AUTH, ClientId 37365lrcda1js3fapqfe2n40eh. Refresh token rotates every call: persist before use. USER_PASSWORD_AUTH needs |

### Other

| Method | Path | Verdict | Used by | Notes |
|---|---|---|---|---|
| GET | `/app-configuration-service/v1/config` | verified | – | tab config |
| GET | `/glp-service/v1/onboarding` | verified | – | GLP-1 onboarding LIST |
| GET | `/growth-content-service/v1/discover-more` | verified | – | marketing noise |

Don't use:

| Method | Path | Verdict | Notes |
|---|---|---|---|
| GET | `/user-journey-service/v1/user-journey/first-week-in-review` | not-found | Android route (@Acetone1). 404 'currently unavailable', as is the v2 year-in-review (seasonal). |
