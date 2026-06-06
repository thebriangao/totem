# The 48 tools

> Full reference for every tool exposed by [totem](README.md). Each entry has the input shape, source endpoint(s), and output shape. Catalog tools (`whoop_sports_catalog`, `whoop_lift_catalog`, `whoop_journal_catalog`) unlock their gated counterparts — see [README → Bundled catalogs](README.md#bundled-catalogs).


Below is every tool with its signature, source endpoints, and notes. Inputs are the zod schema; outputs are described as TypeScript-ish for brevity (full schemas in `src/schemas/`).

### Snapshots & profile (4)

#### `whoop_today`
Composite snapshot of today: recovery score + state, sleep performance + stages, day strain so far, current activity state, workouts count.

- **Input:** `{}`
- **Source endpoints (3 parallel):** `GET /home-service/v1/home?date=today`, `GET /developer/v2/activity/sleep?limit=5` (light ~1 KB sleep summary — the full per-minute hypnogram is `whoop_sleep`'s job, not the snapshot's), `GET /activities-service/v1/user-state`
- **Output:** `{date, recovery: {score, state, hrv_ms, rhr_bpm}, sleep: {performance_pct, total_sleep_ms, time_in_bed_ms, efficiency_pct, stages: {rem_ms, light_ms, sws_ms, wake_ms}, started_at, ended_at}, strain: {score, calories, avg_hr_bpm, max_hr_bpm, workouts_count}, current_state: {state, sport_name, started_at}}`

#### `whoop_day`
Same composite as `whoop_today` but for any past date. Drops the live state (not relevant for historical days).

- **Input:** `{date: string}` (required, YYYY-MM-DD)
- **Source:** Same as `whoop_today` minus the user-state fetch
- **Output:** Same as `whoop_today`, with `current_state.*` set to null

#### `whoop_profile`
Identity + body measurements + privacy state.

- **Input:** `{}`
- **Source endpoints (4 parallel):** `/users-service/v2/bootstrap`, `/users-service/v1/hidden-metrics/BODY_COMP`, `/users-service/v1/hidden-metrics/HEALTHSPAN`, `/users-service/v1/stealth-mode`
- **Output:** `{user_id, account_id, email, username, first_name, last_name, birthday, gender, height: {m, cm, ft}, weight: {kg, lb}, city, country, timezone_offset, bio_data: {max_hr_bpm, resting_hr_bpm, min_hr_bpm}, fitness_level, membership: {status, in_effect}, privacy: {stealth_mode, body_comp_hidden, healthspan_hidden}}`

#### `whoop_calendar`
Per-day recovery / sleep / strain scores for a month.

- **Input:** `{date?: string}` (any day in the target month; default today)
- **Source endpoints (2 parallel):** `/home-service/v1/calendar/overview?date=`, `/home-service/v1/calendar/recovery?date=`
- **Output:** `{month: "YYYY-MM", days: [{date, recovery_score, recovery_state, sleep_score, day_strain}]}`

### Deep dives (3)

#### `whoop_recovery`
Recovery score + HRV (with baseline) + RHR (with baseline) + respiratory rate + SpO2 + skin temp + sleep performance.

- **Input:** `{date?: string}`
- **Source:** `GET /home-service/v1/deep-dive/recovery?date=`
- **Output:** `{date, score, state, hrv:{ms,baseline_ms,delta_pct}, rhr:{bpm,baseline_bpm,delta_pct}, respiratory_rate, spo2_pct, skin_temp_c, sleep_performance_pct, contributors:[{name,direction,detail}], calibration_state}`. Full schema in `src/schemas/recovery.ts`. (In the current SCORE_GAUGE/CONTRIBUTORS_TILE shape, `contributors` returns `[]` and `calibration_state` returns `null` — the per-metric data lives in the typed `hrv`/`rhr`/`respiratory_rate`/`spo2_pct`/`skin_temp_c`/`sleep_performance_pct` fields above.)
- **Walk shape (new):** `SCORE_GAUGE { id: "RECOVERY_SCORE_GAUGE" }.content.score_display` for the score, `CONTRIBUTORS_TILE { id: "RECOVERY_CONTRIBUTORS_TILE" }.content.metrics[]` for each contributor. Each metric carries `status` (today's value) and `status_subtitle` (baseline — API-provided, not computed). Whoop migrated from `GRAPHING_CARD` tiles to this shape in May 2026; the projection was rewritten on 2026-05-26.
- **Baseline:** unlike the old projection (which computed a 6-day rolling mean), baselines now come straight from the API in `status_subtitle`. Same field on the wire, no client-side math.
- **SpO2 / skin_temp:** populated only on 4.0+ straps. The new contributors tile includes `CONTRIBUTORS_TILE_SPO2` and `CONTRIBUTORS_TILE_SKIN_TEMPERATURE` when present.

#### `whoop_sleep`
Sleep duration, time in bed, efficiency, performance, consistency, all 4 stages (REM / LIGHT / SWS / AWAKE) with ms + percent, the full hypnogram (per-stage timeline), in-sleep heart rate (avg/min), disturbances.

- **Input:** `{date?: string}`
- **Source:** `GET /home-service/v1/deep-dive/sleep/last-night?date=`
- **Output:** `{date, started_at, ended_at, total_sleep_ms, time_in_bed_ms, efficiency_pct, performance_pct, consistency_pct, debt_ms, latency_ms, stages: {rem_ms, rem_pct, light_ms, light_pct, sws_ms, sws_pct, wake_ms, wake_pct}, hypnogram: [{started_at, ended_at, stage}], disturbances, sleep_hr: {avg_bpm, min_bpm}, sleep_hrv_ms, respiratory_rate}`

Note: the underlying endpoint is 848 KB. The projection extracts ~500 chars.

**Partially populated** — `sleep_hrv_ms`, `respiratory_rate`, `debt_ms`, `latency_ms` aren't exposed by this endpoint and return `null`. Everything else **is** populated: the per-stage durations + percentages (REM/light/SWS/wake), the **`hypnogram`** (reconstructed from the per-stage HR-curve points — timed off their clock labels, anchored to the sleep window), and **`sleep_hr`** (avg/min).

#### `whoop_strain`
Day strain + HR zone time buckets + steps + strength activity time + workouts count.

- **Input:** `{date?: string}`
- **Source:** `GET /home-service/v1/deep-dive/strain?date=`
- **Output:** `{date, score, target: {value, optimal_lower, optimal_upper}, calories, avg_hr_bpm, max_hr_bpm, zone_durations: {zone_0_ms..zone_5_ms}, workouts_count, steps, strength_activity_time_ms}`
- **Strain target:** `target.value` is Whoop's recovery-calibrated daily strain target; `optimal_lower`/`optimal_upper` bound the green zone. The deep-dive response stores these as 0–1 fractions of max strain (21); the projection multiplies by 21 so they're emitted as strain values, not fractions. Lets the AI answer "should I work out today?" with a number.
- **Walk shape (new):** `SCORE_GAUGE { id: "STRAIN_SCORE_GAUGE" }.content.score_display` for the day strain, `CONTRIBUTORS_TILE { id: "STRAIN_CONTRIBUTORS_TILE" }.content.metrics[]` for time-bucket / step / strength-time contributors. `ACTIVITY` items in the same response represent the day's workouts (count = number of these items). Whoop migrated from `GRAPHING_CARD` tiles in May 2026; rewritten 2026-05-26.
- **Removed fields:** `calories`, `avg_hr_bpm`, `max_hr_bpm`, and per-zone (zone_0/2/3/5) granularity are no longer in this deep-dive endpoint. They live per-workout — use `whoop_workout` for HR zone breakdown of a specific activity. The schema fields are kept (returning null) so the shape stays compatible if Whoop adds them back.
- **HR zones:** Whoop now reports only `HR_ZONES_1_3` (low+mid intensity) and `HR_ZONES_4_5` (high intensity) at the day level. We store the 1-3 aggregate in `zone_1_ms` and the 4-5 aggregate in `zone_4_ms`; zones 0/2/3/5 stay null.

### Trends (2)

#### `whoop_trend`
Trend data for any of 25 metrics across up to four windows (week / month / six_month / year). Most metrics return 3 segments; a few (e.g. VO2_MAX) return 2.

- **Input:** `{metric: "HRV" | "RHR" | "RECOVERY" | "DAY_STRAIN" | "CALORIES" | "STEPS" | "AVERAGE_HR" | "HOURS_V_NEED" | "HOURS_V_NEEDED_PERCENT" | "TIME_IN_BED" | "SLEEP_PERFORMANCE" | "SLEEP_EFFICIENCY" | "SLEEP_CONSISTENCY" | "SLEEP_DEBT_POST" | "RESTORATIVE_SLEEP" | "HR_ZONES_1_3" | "HR_ZONES_4_5" | "RESPIRATORY_RATE" | "STRENGTH_ACTIVITY_TIME" | "STRESS" | "STRESS_DURING_SLEEP" | "STRESS_DURING_NON_STRAIN" | "VO2_MAX" | "BODY_COMPOSITION" | "WEIGHT", end_date?: string}`
- **Source:** `GET /progression-service/v3/trends/{metric}?endDate=`
- **Output:** `{metric, end_date, segments: [{label: "week"|"month"|"six_month"|"year", start_date, end_date, avg, min, max, delta_pct, unit, points: [{date, value, value_display}]}], cardio_fitness_level}`

Heads up: this is one of the larger tools by output size because it returns per-day data points across multiple windows. Use `whoop_compare` if you only need aggregate numbers.

#### `whoop_compare`
Side-by-side comparison of two date windows across recovery / sleep performance / day strain / HRV / RHR.

- **Input:** `{window?: "week" | "month", end_a?: string, end_b?: string, metrics?: string[]}`
- **Source:** 2× `whoop_trend` for each metric in the array
- **Output:** `{window, a: {start_date, end_date}, b: {start_date, end_date}, metrics: [{metric, a_avg, b_avg, delta_abs, delta_pct, unit}]}`

### Stress + sleep coach (2)

#### `whoop_stress`
Stress for a day: current level (0–3 scale, from the gauge), peak/min, and a downsampled intraday timeline. (`stress_state` on the wire is a string like `"RELAXED"`, not a timeline — the data lives in `gauge` + `stress_graph.graph`.)

- **Input:** `{date?: string}`
- **Source:** `GET /health-service/v2/stress-bff/{date}`
- **Output:** `{date, current_level, baseline_level, peak_level, min_level, calibration_state, timeline: [{started_at, ended_at, level}]}` — the raw graph has ~700 intraday samples; the timeline is evenly downsampled to ≤48 points (timestamps reconstructed from each sample's local clock label).

#### `whoop_sleep_need`
Recommended bedtime + sleep need breakdown (baseline + debt + strain + nap credit) + smart-alarm eligibility.

- **Input:** `{}`
- **Source:** `GET /coaching-service/v2/sleepneed`
- **Output:** `{recommended_time_in_bed, recommended_time_in_bed_minutes, need_breakdown: {baseline_minutes, debt_minutes, strain_minutes, nap_credit_minutes}, next_schedule_day, smart_alarm_eligible, schedule_state}`

### Live (3)

#### `whoop_live_hr`
Current heart rate from the strap (if recording).

- **Input:** `{}`
- **Source:** `GET /health-tab-bff/v1/health-tab` (extracts the LIVE_HR section)
- **Output:** `{current_bpm, hr_zone, is_recording, last_updated_at, show_live_hr}`
- **Caveat:** `is_recording` is false when the strap isn't streaming. `current_bpm` may be null or stale.

#### `whoop_live_state`
What you're currently doing — workout, sleep, idle, recovery.

- **Input:** `{}`
- **Source:** `GET /activities-service/v1/user-state`
- **Output:** `{state: "workout"|"sleep"|"idle"|"recovery"|"unknown", sport_name, sport_id, activity_id, started_at, duration_so_far_ms, tracked_sleep, latest_metrics_at}`

#### `whoop_live_stress`
Current stress level (cheaper than `whoop_stress` if you don't need the timeline).

- **Input:** `{}`
- **Source:** `GET /health-service/v2/stress-bff/{today}` (last point only)
- **Output:** `{current_level, baseline_level, calibration_state, last_updated_at}`

### Activities (2 read + 2 write + 1 catalog)

#### `whoop_workouts`
List of recent activities with sport, start, end, duration, strain, HR, calories.

- **Input:** `{start?: string, end?: string, sport?: string, limit?: number}`
- **Source:** `GET /developer/v2/activity/workout` (yes, this uses the public-API endpoint — Whoop's iOS app does too)
- **Output:** `Array<{id, sport_name, start, end, duration_ms, strain, avg_hr_bpm, max_hr_bpm, calories, distance_m}>`

#### `whoop_workout`
Full detail of one activity: HR curve, HR zone durations, calories, distance. Strength workouts include MSK summary (volume + intensity).

- **Input:** `{activity_id: string}`
- **Source:** `GET /core-details-bff/v1/cardio-details?activityId=` (300 KB response)
- **Output:** `{id, sport_name, start, end, duration_ms, strain, calories, distance_m, avg_hr_bpm, max_hr_bpm, zone_durations: HrZoneDurations, hr_curve: [{at, bpm}], msk: {total_volume_kg, intensity_pct, strain_score, is_strength_workout}}` (`distance_m` is currently always `null` — not extracted from `/cardio-details`)
- **`hr_curve`:** reconstructed from the graph points — bpm from each point's `value_display`, timestamps from `position_x` × the workout window — then evenly downsampled to ≤120 points.
- **Caveat:** a just-created/logged activity stays `score_state: "pending"` until Whoop scores it, and this endpoint returns 400 (`"Cannot view details for a pending activity"`) until then — so don't read details of a workout you just logged for a while.

#### `whoop_activity_create` ⚠️ WRITE (gated by `whoop_sports_catalog`)
Create a generic activity (manual entry — for when you did something without wearing the strap, or want to add a record after the fact).

- **Input:** `{sport_id: number, start: string, end: string, gps_enabled?: boolean, confirm?: boolean}`
- **Source:** `POST /core-details-bff/v0/create-activity`
- **Output (confirm=false):** `{preview: true, will_execute: {...}, set_confirm_true_to_run: true}`
- **Output (confirm=true):** `{created: true, activity_id, cycle_id, start, end, sport_id}`
- **Gate:** rejects until `whoop_sports_catalog` has been called once in the session (token-saving lazy-load — see [Bundled catalogs](#bundled-catalogs)). The tool also rejects unknown `sport_id` values before hitting the API.
- **Caveat:** Whoop rejects activities with < 1 minute duration (422). Common `sport_id` values verified live: `0=Running, 1=Cycling, 17=Basketball, 33=Swimming, 45=Weightlifting, 48=Functional Fitness, 52=Hiking, 63=Walking, 123=Strength Trainer, -1=Activity` (generic). Use `whoop_sports_catalog` to look up the rest of the 203.

#### `whoop_activity_delete` ⚠️ WRITE (DESTRUCTIVE)
Delete a workout / activity. Cannot be undone — the activity is removed from Whoop's system.

- **Input:** `{activity_id: string, confirm?: boolean}`
- **Source:** `DELETE /core-details-bff/v1/cardio-details?activityId=`
- **Output:** `{deleted: true, activity_id}` (or preview)

#### `whoop_sports_catalog`
Local lookup over the bundled 203-sport catalog (numeric `sport_id` ↔ display name). Zero network calls. Calling this once unlocks the catalog gate that protects `whoop_activity_create` for the rest of the session.

- **Input:** `{search?: string, limit?: number}`
- **Source:** Bundled `src/data/sports.ts` (203-entry catalog generated from `/activities-service/v1/sports/history?countryCode=US`)
- **Output:** `{total_in_catalog: 203, matched, truncated, sports: [{id, name}]}`

### Strength reads (6)

#### `whoop_lift_prs`
All Strength Trainer personal records across every exercise, with medals.

- **Input:** `{}`
- **Source:** `GET /weightlifting-service/v3/prs`
- **Output:** `Array<{exercise_id, name, muscle_groups, equipment, pr_value, pr_units, pr_date, medal: "GOLD"|"SILVER"|"BRONZE"|null, custom_exercise}>`

#### `whoop_lift_exercise` (gated by `whoop_lift_catalog`)
Single exercise composite: metadata + recent sessions (every set with reps/weight/medal) + your PRs for that exercise.

- **Input:** `{exercise_id: string}` (use `whoop_lift_catalog` to find IDs)
- **Gate:** rejects until `whoop_lift_catalog` has been called once in the session.
- **Source (3 parallel):** `/v1/exercise/{id}`, `/v3/exercise/{id}/exercise_history`, `/v3/exercise/{id}/personal_records`
- **Output:** `{exercise: {id, name, muscle_groups, equipment, movement_pattern, laterality, custom, volume_input_format, instructions, video_url}, recent_sessions: LiftSession[], personal_records: LiftSession[]}`

#### `whoop_lift_progression` (gated by `whoop_lift_catalog`)
Volume trend for a single exercise across week / month / 6-month / year windows.

- **Input:** `{exercise_id: string, end_date?: string}`
- **Gate:** rejects until `whoop_lift_catalog` has been called once in the session.
- **Source:** `GET /progression-service/v3/exercise/{id}?endDate=`
- **Output:** `{exercise_id, end_date, segments: [{label, start_date, end_date, avg_volume, delta_pct, unit, points: [{date, volume, reps, top_weight}]}]}` (per-point `reps` and `top_weight` are currently always `null` — the progression graph only exposes volume)

#### `whoop_lift_history`
Recent Strength Trainer workouts with **per-exercise aggregates** (set count, total reps, tonnage, medals). Distinct from `whoop_workouts` which gives a generic activity list with no exercise breakdown.

- **Input:** `{limit?: number, end_date?: string}`
- **Source:** Filtered `/developer/v2/activity/workout` + parallel `/cardio-details` for each strength workout
- **Output:** `Array<{activity_id, date, name, duration_ms, strain, msk_total_volume_kg, msk_intensity_pct, exercise_count, set_count, exercises: [{exercise_id, name, set_count, total_reps, tonnage, tonnage_units, achievements, sets: LiftSet[]}]}>`
- **Filter:** matches sport_name against `/weight|strength|powerlift/i` to catch `weightlifting_msk` (Strength Trainer), `weightlifting`, and `powerlifting`. The older `/strength/i` regex matched none of these — fixed 2026-05-26.
- **Walk shape:** `cardio-details.weightlifting_cardio_details.weightlifting_exercises.exercise_summary_carousel.items[]`. First item is the workout aggregate row (skip it via `exercise_id === null`), each subsequent item is one exercise.
- **Per-set detail (set 1: 10 reps @ 200lbs, set 2: ...) is NOT available** in `/cardio-details` — Whoop only exposes exercise-level aggregates here. For per-set numbers across all your workouts, use `whoop_lift_exercise` which hits `/v3/exercise/{id}/exercise_history`. The `sets` array in this response always returns empty `[]`.

#### `whoop_lift_library`
Your saved templates. Returns the list or a single template detail.

- **Input:** `{template_id?: number}` (omit for list, pass for single)
- **Source:** `/v3/workout-library` (list) OR `/v2/workout-template/{id}` (single)
- **Output (list):** `{mode: "list", my_workouts: [...], whoop_workouts: [...]}`
- **Output (single):** `{mode: "single", template_id, name, exercises: [...]}`

#### `whoop_lift_catalog`
Local lookup over the bundled 372-exercise catalog. Zero network calls.

- **Input:** `{search?: string, muscle?: string, equipment?: string, movement_pattern?: string, laterality?: "BILATERAL"|"LEFT"|"RIGHT"|"ALTERNATING", limit?: number}`
- **Source:** Bundled `src/data/exercises.ts`
- **Output:** `{total_in_catalog: 372, matched, truncated, exercises: [{exercise_id, name, muscle_groups, primary_muscle, equipment, movement_pattern, laterality}]}`

### Strength writes (3)

#### `whoop_lift_log` ⚠️ WRITE (gated by `whoop_lift_catalog`)
Log a finished strength workout. Builds Whoop's full nested `workout_groups → workout_exercises → sets` body shape, denormalizing each exercise from the bundled catalog. Validates that every `exercise_id` exists in `EXERCISES_BY_ID` and fails early with a clear error if not.

- **Input:** `{name?: string, start?: string, end?: string, exercises: [{exercise_id, sets: [{reps, weight?, time_seconds?, strap_location?}]}], confirm?: boolean}`
- **Source:** `POST /weightlifting-service/v2/weightlifting-workout/activity`
- **Output:** `{logged: true, activity_id, exercise_count, set_count, total_volume_kg}` (or preview)
- **Quirks:** Whoop's POST validates `exercise_details.created_at` and `exercise_details.updated_at` as non-empty ISO timestamps. The MCP populates them automatically. Overlapping time windows return 409. Default duration is 30 minutes ending now if `start`/`end` not passed.

#### `whoop_lift_template_save` ⚠️ WRITE (gated by `whoop_lift_catalog`)
Create or save-as a workout template (e.g. "Push Day", "Heavy Legs").

- **Input:** `{name: string, base_template_key?: number, exercises: [{exercise_id, sets: [{reps, weight, time_seconds}]}], confirm?: boolean}`
- **Source:** `POST /weightlifting-service/v3/workout-template`
- **Output:** `{created: true, template_id, name, exercise_count}` (or preview)
- **Note:** No delete-template endpoint is wrapped (Whoop's iOS app doesn't expose one either via this URL). Created templates persist.

#### `whoop_lift_custom_exercise` ⚠️ WRITE (gated by `whoop_lift_catalog`)
Create a custom exercise based on an existing official one. Use this when you want to log a variant Whoop doesn't have (e.g. "Spoto Press" based on "Bench Press").

- **Input:** `{name: string, push_core_name: string, muscle_groups: enum[], equipment?: enum, movement_pattern?: enum, laterality?: enum, volume_input_format?: "REPS"|"TIME", exercise_type?: "STRENGTH"|"POWER", instructions?: string[], trackable?: boolean, confirm?: boolean}`
- **Source:** `POST /weightlifting-service/v2/custom-exercise`
- **Output:** `{created: true, exercise_id, name}` (or preview)
- **Enum constraints verified live:** `muscle_groups` must be from `{ARMS, BACK, CHEST, CORE, FULL_BODY, LEGS, OTHER, SHOULDERS}` (no GLUTES/HAMSTRINGS/QUADS/BICEPS/TRICEPS/FOREARMS — API rejects those). `movement_pattern` from `{SQUAT, HINGE, HORIZONTAL_PRESS, VERTICAL_PRESS, HORIZONTAL_PULL, VERTICAL_PULL, LUNGE, JUMP, OTHER}` (no OLYMPIC_LIFT/ROTATION/GAIT/CARRY — API rejects those). `equipment` from `{MACHINE, DUMBBELL, BARBELL, BODY, OTHER, KETTLEBELL}`.
- **Note:** The MCP generates the new UUID client-side via `randomUUID().toUpperCase()`. The `push_core_name` parameter MUST be an existing exercise_id in the bundled catalog — Whoop links the custom to its canonical "what kind of movement is this" classifier.

### Journal (3 read + 2 write)

#### `whoop_journal`
Your journal entry for a date — every tracked behavior with its value, magnitude, and resolved title (from the bundled catalog so Claude doesn't have to make a second lookup).

- **Input:** `{date?: string}`
- **Source:** `GET /journal-service/v3/journals/drafts/mobile/{date}` (NOT the misleadingly-named v2 endpoint, which returns the catalog of *enabled* behaviors instead of the day's entries)
- **Output:** `{date, cycle_id, journal_entry_id, notes, behaviors: [{behavior_tracker_id, title, category, internal_name, answered_yes, magnitude_value, magnitude_label, recorded_at}]}`

#### `whoop_journal_catalog`
Local lookup over the bundled 308-behavior catalog. Filter by category, magnitude type, or substring search.

- **Input:** `{category?: enum, search?: string, magnitude_type?: "bare"|"boolean"|"magnitude", limit?: number}`
- **Source:** Bundled `src/data/behaviors.ts`
- **Output:** `{total_in_catalog: 308, matched, truncated, behaviors: [{behavior_tracker_id, title, question, internal_name, category, magnitude, status}]}`
- **Categories:** Drugs & Medication, Health & Symptoms, Hormonal Health, Lifestyle, Mental Wellbeing, Nutrition, Recovery, Sleep & Circadian Health, Supplements

#### `whoop_behavior_impact`
Per-behavior impact analysis — how each tracked behavior has historically moved your recovery / HRV / sleep. Self-discovering: call with **no argument** to list every behavior with its `impact_uuid`, then call again with that UUID for the full breakdown. (The impact UUIDs aren't exposed by any other tool, so the list mode is what makes the detail mode reachable — the numeric `behavior_tracker_id` from the journal catalog is **not** the same id.)

- **Input:** `{behavior_id?: string}` — omit for the list; pass an `impact_uuid` from that list for the detail.
- **Source:** `GET /behavior-impact-service/v1/impact` (list) OR `GET /behavior-impact-service/v2/impact/details/{impact_uuid}` (detail)
- **Output (list):** `{behaviors: [{impact_uuid, behavior_name, direction: "positive"|"negative"|"neutral"|"insufficient", impact_display, has_sufficient_data}]}`
- **Output (detail):** `{behavior_id, behavior_name, metrics: [{metric, delta_avg, delta_unit, sample_size, direction}], insight}`
- **Caveat:** needs journal history — accounts with little/no logged data return an empty list (every behavior `has_sufficient_data: false`). The `impact_uuid` is per-fetch, so always read it from the live list rather than hardcoding.

#### `whoop_journal_log` ⚠️ WRITE (gated by `whoop_journal_catalog`)
Save a full journal entry. **Replaces** the existing entry for that date with the new set of behaviors — so read `whoop_journal` first and resend the day's existing entries along with your additions, or they'll be wiped. Use empty `behaviors: []` to clear the entry.

- **Input:** `{date?: string, behaviors: [{behavior_tracker_id, answered_yes?, magnitude_value?, magnitude_label?}], notes?: string, confirm?: boolean}`
- **Source:** `PUT /journal-service/v2/journals/entries/user/date/{date}`
- **Output:** `{logged: true, date, behaviors_count}` (or preview)
- **Gate:** rejects until `whoop_journal_catalog` has been called once in the session.
- **Validation:** All `behavior_tracker_id` values are also validated against `BEHAVIORS_BY_ID` before the request fires. Unknown IDs fail early.

#### `whoop_journal_autopop` ⚠️ WRITE (irreversible)
Trigger Whoop's auto-populate engine — it reads your HealthKit data and workout patterns and suggests journal entries for the day.

- **Input:** `{cycle_id: number, confirm?: boolean}` (cycle_id from `whoop_journal` or `whoop_today`)
- **Source:** `PUT /autopop-service/v1/autopop/JOURNAL/{cycle_id}`
- **Output:** `{triggered: true, cycle_id}` (or preview)

### Women's health (1 read + 2 write)

#### `whoop_cycle`
Current menstrual cycle status — phase, cycle day, typical cycle length, and predicted next-period / ovulation dates.

- **Input:** `{date?: string}`
- **Source:** `GET /womens-health-service/v1/menstrual-cycle-insights?date=` (a `tiles[]` BFF — `phase`/`cycle_day` from the `HEADER_TILE`, `cycle_length` from the `TYPICAL_CYCLE_TILE` stats, predictions derived from the `CALENDAR_TILE` first-day-of-phase markers)
- **Output:** `{date, phase, cycle_day, cycle_length, next_period_predicted_date, ovulation_predicted_date, hormonal_mode, contraception_type, is_pregnant}`
- **Caveats:** requires women's-health tracking enabled on the account — when it isn't, the endpoint still returns 200 and the projection degrades to all-null. `hormonal_mode` / `contraception_type` / `is_pregnant` are account settings this BFF doesn't carry, so they're always null here; `cycle_length` is null until there's enough history; predictions are null when the predicted day falls outside the returned month. **Pass the `date` param** — querying the endpoint without it 404s.

#### `whoop_cycle_log` ⚠️ WRITE
Log a period start or ovulation event for a date.

- **Input:** `{date: string, period?: boolean, period_flow?: number, ovulation?: boolean, confirm?: boolean}`
- **Source:** `PUT /womens-health-service/v1/menstrual-cycle-insights/log`
- **Wire format:** Date encoded as `[YYYY, MM, DD]` integer array (this is Whoop's specific quirk).
- **Output:** `{logged: true, date}` (or preview)

#### `whoop_symptom_log` ⚠️ WRITE (gated by `whoop_journal_catalog` when `symptoms` is non-empty)
Log women's-health symptoms — cervical mucus, menstruation flow, and additional tracker symptoms.

- **Input:** `{date: string, menstruation?: enum, cervical_mucus?: enum, symptoms?: [{behavior_tracker_id, answered_yes?}], confirm?: boolean}`
- **Source:** `POST /womens-health-service/v1/symptom-insights/log/symptoms?requestDate=`
- **Enums (live-verified):**
  - `menstruation`: `none, spotting, light_flow, medium_flow, heavy_flow` (all 5 accepted)
  - `cervical_mucus`: `vaginal-discharge---egg-white, vaginal-discharge---creamy, vaginal-discharge---sticky, vaginal-discharge---watery, vaginal-discharge---grey` (the triple-hyphen is the actual key format; API rejects `"none"` with 422 — omit the field entirely to clear)
- **Output:** `{logged: true, date, symptoms_count}` (or preview)
- **Gate:** when `symptoms` is empty (you're only logging menstruation/cervical_mucus), no gate; otherwise requires `whoop_journal_catalog` once per session because `symptoms[].behavior_tracker_id` references the behaviors catalog.

### Coach + performance (2)

#### `whoop_coach_ask` ⚠️ WRITE (creates artifact)
Ask Whoop Coach a question. Polls up to 30 seconds for the response.

- **Input:** `{message: string, context?: "HOME"|"RECOVERY"|"STRAIN"|"SLEEP"|"STRESS"|"CARDIO_DETAILS"|"WAKE_UP_REPORT", confirm?: boolean}`
- **Source flow:** POST `/ai-conversation-bff/v1/conversation` (create) → POST `/{conv}/turn` (send) → GET `/{conv}/turn/{turn}` (poll)
- **Output:** `{conversation_id, turn_id, response_text, turn_status, polled_iterations, timed_out}` (or preview)
- **Note:** Every ask creates a persistent conversation artifact on your Whoop account. The MCP requires `confirm: true` because of this.

#### `whoop_performance_assessment`
Whoop's coaching evaluation for a period: total recoveries, required recoveries, expected next assessment.

- **Input:** `{period?: "WEEK"|"MONTH"}` (default MONTH)
- **Source:** `GET /coaching-service/v1/performance-assessment/{period}/data/{iso_timestamp}`
- **Output:** `{period, is_assessment_needed, has_assessment, total_recoveries, required_recoveries, recoveries_before_recent_cutoff, expected_assessment_during, next_assessment_during}`
- **Caveat:** The iOS app sends `YEAR` in some discovery captures, but the API rejects it with `400 "path param reportType must be one of [WEEK, MONTH]"` — so YEAR is documented in the spec but not implemented server-side. We removed it from the enum.

### Smart alarm (1 read + 1 write)

#### `whoop_smart_alarm`
Current Smart Alarm state: schedules array + preferences (lower/upper bounds, goal mode, enabled).

- **Input:** `{}`
- **Source (2 parallel):** `/smart-alarm-bff/v1/schedule/all`, `/smart-alarm-service/v1/smartalarm/preferences`
- **Output:** `{enabled, preferences: {lower_time_bound, upper_time_bound, goal, weekly_plan_goal_minutes, last_triggered_at}, schedules: [{schedule_id, enabled, days_of_week, latest_wake_time, alarm_mode, sleep_goal, timezone_offset}]}`
- **Quirk:** The `upper_time_bound` and `goal` are nested inside `alarm_bounds` on the preferences endpoint, NOT at top level. The MCP handles this.

#### `whoop_smart_alarm_set` ⚠️ WRITE
Update one schedule, the global preferences, or the master enable/disable.

- **Input:** `{mode: "schedule"|"preferences"|"master_enable"|"master_disable", schedule_id?: string, schedule?: {...}, preferences?: {...}, confirm?: boolean}`
- **Source (mode-dispatched):**
  - `schedule` → `PUT /smart-alarm-bff/v1/schedule/{schedule_id}`
  - `preferences` → `PUT /smart-alarm-service/v1/smartalarm/preferences`
  - `master_enable` → `PUT /smart-alarm-service/v1/alarm-schedule/enable`
  - `master_disable` → `PUT /smart-alarm-service/v1/alarm-schedule/disable`
- **Output:** `{updated: true, mode}` (or preview)
- **To change the wake time, use `mode=schedule`** (`schedule_id` + `latest_wake_time`) — that's the setting that actually controls when the alarm fires. `mode=preferences` sets the global goal + enable flags, but its `lower/upper_time_bound` are ignored by the server whenever an explicit schedule exists (the PUT returns 200 but the bounds don't change). Read `whoop_smart_alarm` first for the `schedule_id` + current values; schedule/preferences **replace**, they don't merge.

### Social (2)

#### `whoop_leaderboard`
Community leaderboard + your position. Auto-discovers your first community if `community_id` omitted.

- **Input:** `{community_id?: number, date?: string, window?: "day"|"week"|"month", metric?: "recovery"|"sleep"|"strain"}`
- **Source (2-3 parallel):** memberships (if auto-discovery), board, your row
- **Output:** `{community_id, community_name, window, metric, date_label, average, total_compliant, total_empty, records: [{rank, user_id, first_name, last_name, value, secondary_value}], your_position: {rank, value, in_window}}`
- **Note:** 404 on your row is handled gracefully — `in_window: false` instead of throwing.

#### `whoop_communities`
The communities you're a member of (teams, friend groups), each with member count and — optionally — your rank in it. Complements `whoop_leaderboard`: use this to discover community IDs, then drill into one with `whoop_leaderboard`.

- **Input:** `{team_type?: "ALL"|"COMMUNITY"|"TEAM"|"BUSINESS", metric?: "strain"|"sleep"|"recovery", period?: "day"|"week"|"month", include_rank?: boolean, limit?: number, offset?: number}` (defaults: `team_type=ALL`, `metric=strain`, `period=week`, `include_rank=true`, `limit=50`, `offset=0`)
- **Source:** `GET /community-service/v1/communities/memberships` (the same endpoint `whoop_leaderboard` uses for auto-discovery)
- **Output:** `{total_count, offset, team_type_filter, leaderboard_metric, period, communities: [{id, name, avatar_url, banner_url, about, private, member_count, owner_id, team_type, membership: {member_type, notification_setting, unread_count, online, joined_at, last_online}, rank: {rank, score, metric, period} | null}]}`
- **Schema status:** permissive at the record level — the per-record field set hasn't been captured against a live account yet, so most fields are nullable. A `WhoopProjectionError` from this tool is the signal that Whoop's actual shape differs from the inferred one and the projection needs tightening.

### Settings (1 read + 3 write)

#### `whoop_hr_zones`
Current HR zones + max HR + last updated.

- **Input:** `{}`
- **Source (2 parallel):** `/hr-zones-service/v1/bff/zones`, `/hr-zones-service/v1/bff/settings`
- **Output:** `{max_hr, is_custom, effective_timestamp, zones: [{id: "ZONE_1".."ZONE_5", min, max}]}`

#### `whoop_hr_zones_set` ⚠️ WRITE
Set max HR (auto-computes 5 zones) OR set custom 5-zone ranges.

- **Input:**
  - Max HR mode: `{mode: "max_hr", max_hr: number, confirm?}`
  - Custom mode: `{mode: "custom", zones: [{id, min, max}] (5 entries), confirm?}`
- **Source:**
  - max_hr → `POST /hr-zones-service/v1/maxhr`
  - custom → `POST /hr-zones-service/v1/bff/custom`
- **Output:** `{updated: true, mode}` (or preview)

#### `whoop_profile_update` ⚠️ WRITE
Update profile: name, email, birthday, gender, weight, height, country/state, city.

- **Input:** `{first_name?, last_name?, email?, birthday?, gender?: "MALE"|"FEMALE"|"NON_BINARY", physiological_baseline?: "MALE"|"FEMALE", weight_kg?, height_m?, city?, state?, country?, unit_system?: "imperial"|"metric", confirm?}`
- **Source:** `PUT /profile-service/v1/profile`
- **Output:** `{updated: true, fields_updated: string[]}` (or preview)
- **Live-verified quirks:** Whoop's PUT is NOT a partial update — sending too few fields returns 422. Birthday accepts either `YYYY-MM-DD` or ISO datetime (the MCP auto-trims the time component). Gender enums must be UPPERCASE; `UNSPECIFIED`/`OTHER`/`PREFER_NOT_TO_SAY` are rejected (only `MALE`/`FEMALE`/`NON_BINARY` work). If `country=US`, the API requires `state` to be set too — otherwise 400 `"AdminDivision (state) must be set for US"`.

#### `whoop_hidden_metric` ⚠️ WRITE
Show or hide BODY_COMP / HEALTHSPAN on your dashboard.

- **Input:** `{metric: "BODY_COMP"|"HEALTHSPAN", action: "hide"|"show", confirm?}`
- **Source:** `POST /users-service/v1/hidden-metrics/{metric}` (hide) OR `DELETE /users-service/v1/hidden-metrics/{metric}` (show)
- **Output:** `{updated: true, metric, is_hidden}` (or preview)

### Escape hatch (2)

#### `whoop_raw`
Call any Whoop endpoint directly. The escape hatch for endpoints not yet wrapped.

- **Input:** `{path: string, method?: "GET"|"POST"|"PUT"|"DELETE", query?: Record, body?: unknown, confirm?: boolean}` (confirm required for mutating methods)
- **Source:** Whatever path you pass
- **Output:** `{path, method, status, response}` (or preview for mutations)
- **Pairs with `whoop_endpoints`** — call that first to discover paths, then use `whoop_raw` to hit them.

#### `whoop_endpoints`
Search the bundled catalog of 311 deduped endpoint paths.

- **Input:** `{filter?: string, method?: "GET"|"POST"|"PUT"|"DELETE", limit?: number}`
- **Source:** Bundled `src/data/endpoints.ts`
- **Output:** `{total_in_catalog, matched, truncated, endpoints: string[]}` (lines like `GET 200 /home-service/v1/home`)

