# The 40 tools

What totem gives an AI app: 23 tools that read your WHOOP data and 17 that change it.
This page is written from the tool registry (`npx tsx scripts/tools-md.ts`), so it says exactly what an app sees.

- **Changes need a yes.** A tool that writes returns a preview of what it would send, and does nothing until it is called again with `confirm: true`. Your app shows you the preview first.
- **Small by default.** A call with only its required inputs answers in about 1.5 KB. The heavy parts (a hypnogram, every set of every lift, a heart-rate series) come with `include`.
- **Your time zone.** Times come back in your WHOOP time zone. A time you give without an offset (`2026-11-20T08:00`) is read on your clock too.

- [Today and any day](#today-and-any-day)
- [Trends](#trends)
- [Activities](#activities)
- [Strength Trainer](#strength-trainer)
- [Journal](#journal)
- [WHOOP Coach](#whoop-coach)
- [Body](#body)
- [Plans and alarms](#plans-and-alarms)
- [Profile, settings and community](#profile-settings-and-community)
- [Anything else](#anything-else)

## Today and any day

Scores, sleep, strain, stress and heart rate for a day, or a table of many days.

### `whoop_now`

Live snapshot: activity state (idle, workout, sleep…) with sport and minutes so far, when WHOOP last processed strap data and the heart rate at that moment, current stress, and today's recovery, sleep, strain, calories and HRV. Never cached.

No inputs.

### `whoop_day`

One cycle day (default today): scores, main sleep, strain, calories, steps, activities and, today, the live state. sleep_plan is today only. hr: heart rate every 10 min, or a window via hr_from/hr_to (1-min steps up to 5 h, 6 s up to 30 min). end_date: a table of daily recovery, HRV, RHR, sleep, strain, calories and HR instead. Scores are null while calibrating. Never reuse the cycle id: sleep edits change it.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |
| `end_date` | string | Table from date: default 30 days, max 180 |
| `include` | list of `scores`, `sleep`, `strain`, `activities`, `sleep_plan`, `key_stats`, `hr` | Default scores, sleep, strain, activities |
| `hr_from` | string | With hr_to, max 48 h |
| `hr_to` | string |  |

### `whoop_recovery`

Recovery for a cycle day (default today): score, state and contributors (HRV, RHR, respiratory rate, sleep performance) vs baseline. Today only: Health Monitor (SpO2, skin temperature as a °F deviation from baseline, RR, RHR, HRV). include assessment adds the weekly and monthly performance assessment.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |
| `include` | list of `assessment` |  |

### `whoop_sleep`

Sleep for a cycle day (default today = last night's main sleep) or one sleep or nap by activity_id: window, minutes asleep and in bed, efficiency, stages, disturbances, HR and performance, plus the day's naps (with ids) and tonight's sleep need (today only). Unscored sleeps have no metrics.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |
| `activity_id` | string |  |
| `include` | list of `hypnogram`, `need`, `naps` | Default naps, need |

### `whoop_strain`

Day strain for a cycle day (default today): score (0–21), target (null while calibrating), contributors vs your 30-day baseline (zone minutes, strength minutes, steps) and the day's CARDIO activities. RECOVERY activities (sauna, meditation) don't count toward strain; see whoop_day.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |

### `whoop_stress`

Stress Monitor for a day (default today): state, current level (0–3) and label, min and peak, and minutes in low/medium/high stress. Today's graph covers the last 24 hours. include timeline adds the mean level per 30 minutes.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |
| `include` | list of `timeline` |  |

## Trends

Averages and changes over weeks and months, and the calendar of scores.

### `whoop_trend`

Trends for 1–5 metrics over a window ending end_date (default today; week = 7 days, month 30, six_month 180): average, previous-window average, change % and direction. HR-zone and strength-time rows are weekly totals. compare_end_date adds a second window and the deltas.

| Input | Type | Notes |
|---|---|---|
| `metrics` (required) | list of `RECOVERY`, `HRV`, `RHR`, `RESPIRATORY_RATE`, `DAY_STRAIN`, `CALORIES`, `STEPS`, `AVERAGE_HR`, `HR_ZONES_1_3`, `HR_ZONES_4_5`, `HR_ZONES_ALL`, `STRENGTH_ACTIVITY_TIME`, `VO2_MAX`, `SLEEP_PERFORMANCE`, `TIME_IN_BED`, `HOURS_V_NEED`, `HOURS_V_NEEDED_PERCENT`, `SLEEP_CONSISTENCY`, `SLEEP_EFFICIENCY`, `RESTORATIVE_SLEEP`, `RESTORATIVE_SLEEP_PERCENT`, `SLEEP_DEBT_POST`, `STRESS`, `STRESS_DURING_SLEEP`, `STRESS_DURING_NON_STRAIN`, `BODY_COMPOSITION`, `WEIGHT` |  |
| `window` | `week`, `month`, `six_month` |  |
| `end_date` | string |  |
| `compare_end_date` | string |  |
| `include_points` | boolean | One value per day or week |

### `whoop_calendar`

Month grid for one pillar. days has one character per day of the month (days[0] = the 1st): H/M/L = high/medium/low, '-' = data but no score, '.' = no data. States only, no numbers; use whoop_day for a day's scores.

| Input | Type | Notes |
|---|---|---|
| `date` | string | Any day in the month |
| `pillar` | `recovery`, `strain`, `sleep` |  |

## Activities

Workouts, naps and sleeps: read them, log new ones, fix or remove them.

### `whoop_workouts`

Activities as the app lists them. List: one cycle day (date) or start_date–end_date (≤31 days; default the last 7), pending and unscored included, as rows of id, type, sport, start, minutes, status and CARDIO strain. With activity_id: strain, calories, HR, zones, distance and MSK summary. Sleeps and naps: whoop_sleep.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |
| `start_date` | string |  |
| `end_date` | string |  |
| `activity_id` | string |  |
| `include` | list of `hr` | Detail only |
| `types` | list of `CARDIO`, `RECOVERY`, `SLEEP` | Default CARDIO, RECOVERY |
| `sport` | string | Substring of the sport's name |
| `limit` | integer |  |

### `whoop_activity_log` (changes data)

Log a past activity, nap or main sleep over start–end (≥1 min, not in the future); WHOOP scores it from strap data. type is an internal_name ("sauna", "nap", "sleep"), display name or sport_id; a miss returns the closest. Overlaps are refused. A main sleep permanently re-cuts the day's cycles. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `type` | string |  |
| `sport_id` | integer | Instead of type |
| `start` (required) | string |  |
| `end` (required) | string |  |
| `gps_enabled` | boolean |  |
| `garment_id` | integer | Strap location id; a miss lists them |

Add `confirm: true` to make the change.

### `whoop_activity_edit` (changes data)

Change an activity's start/end or type (CARDIO↔RECOVERY, nap→main sleep), or a sleep or nap's window, by activity_id or sleep_date (that day's main sleep). Omitted bounds keep their value. A sleep window that overlaps others needs delete_overlapping = exactly the ids the preview lists; WHOOP then DELETES them. Nap→main sleep permanently re-cuts the day's cycles. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `activity_id` | string |  |
| `sleep_date` | string |  |
| `start` | string |  |
| `end` | string |  |
| `type` | string | internal_name, display name or sport_id |
| `garment_id` | integer | Activities only |
| `delete_overlapping` | list of string | Overlapping ids from the preview; WHOOP deletes them |

Add `confirm: true` to make the change.

### `whoop_activity_delete` (changes data)

Delete one activity, nap or sleep by activity_id (from whoop_workouts or whoop_sleep) and confirm it's gone. Deleting a main sleep doesn't restore the day's cycles. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `activity_id` (required) | string |  |

Add `confirm: true` to make the change.

## Strength Trainer

Lifting sessions, exercise history and records, the exercise library, logging lifts and templates.

### `whoop_lift_sessions`

Strength sessions, newest first (default last 14 days, max 60): any activity with Strength Trainer sets. Exercises are rows in exercise_cols order: id, set scheme, top set [weight, reps], volume, medal. Unscored sessions list without exercises: include unscored (or activity_id) reads their sets from exercise history, which is slow. Weights are in unit.

| Input | Type | Notes |
|---|---|---|
| `start_date` | string |  |
| `end_date` | string |  |
| `activity_id` | string |  |
| `limit` | integer |  |
| `include` | list of `sets`, `unscored` |  |

### `whoop_lift_exercise`

One exercise by exercise_id or name: metadata, workout history, medal records and 1RM (manual entries carry the entry_id whoop_lift_exercise_set takes). With neither: your PR list. Weights are in unit. cursor takes a returned next.

| Input | Type | Notes |
|---|---|---|
| `exercise_id` | string | e.g. BENCHPRESS_BARBELL |
| `name` | string | Exact name |
| `include` | list of `history`, `records`, `one_rep_max`, `progression`, `instructions` | Default history, records, one_rep_max |
| `cursor` | string |  |
| `end_date` | string | For progression |

### `whoop_lift_library`

Strength Trainer library. No arguments: your templates as [template_key, name] and WHOOP's workouts as [prebuilt_id, title, minutes]. With one of those ids: that workout's exercises, a template's sets as [weight, reps] ([weight, seconds] if timed). search: up to 10 exercises by name, muscle or equipment (custom ones included), with the ids whoop_lift_log and whoop_lift_exercise take.

| Input | Type | Notes |
|---|---|---|
| `template_key` | integer |  |
| `prebuilt_id` | string |  |
| `search` | string | e.g. "bench barbell" |

### `whoop_lift_log` (changes data)

Log a finished strength workout as a new Strength Trainer activity, or attach the sets to an existing activity (attach_to_activity_id; permanent, WHOOP has no unlink). Weights need unit. Refused: a window overlapping another activity, and weighted sets with 0 reps (WHOOP would award a permanent PR). Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `exercises` (required) | list of object |  |
| `unit` | `kg`, `lb` |  |
| `start` | string | Default end minus 30 min |
| `end` | string | Default now |
| `name` | string |  |
| `rpe` | integer |  |
| `attach_to_activity_id` | string |  |

Add `confirm: true` to make the change.

### `whoop_lift_template` (changes data)

Manage your Strength Trainer templates. create: name and exercises. edit: template_key with a new name and/or exercises (the whole list is replaced). copy: copy_from (your template_key or a WHOOP prebuilt_id) into a new template. delete: template_key. Weights need unit. Keys: whoop_lift_library. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `action` (required) | `create`, `edit`, `copy`, `delete` |  |
| `template_key` | integer |  |
| `copy_from` | integer or string |  |
| `name` | string |  |
| `exercises` | list of object |  |
| `unit` | `kg`, `lb` |  |

Add `confirm: true` to make the change.

### `whoop_lift_exercise_set` (changes data)

Custom exercises and manual 1RM entries. create_custom / edit_custom take custom; without a linked_exercise it stays untracked (no e1RM, no muscle load). delete_custom is soft: its PR tile stays. set_1rm: value with unit, dated today or up to 6 months back; entry_id (from whoop_lift_exercise) edits an entry. delete_1rm: entry_id or date. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `action` (required) | `create_custom`, `edit_custom`, `delete_custom`, `set_1rm`, `delete_1rm` |  |
| `exercise_id` | string |  |
| `exercise` | string | Or the exact name |
| `custom` | object | edit_custom keeps omitted fields |
| `value` | number |  |
| `date` | string |  |
| `entry_id` | string |  |
| `unit` | `kg`, `lb` |  |

Add `confirm: true` to make the change.

## Journal

Daily journal answers and what they do to your recovery.

### `whoop_journal`

Journal for a date (default today): answered behaviours (yes/no, value, time) and notes. include: unanswered; catalog (your behaviour ids and names, custom ones too; filter with search or category); magnitudes (ranges and step choices on catalog rows); impact (how behaviours move your recovery). impact_id: one personal impact's detail.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |
| `include` | list of `unanswered`, `catalog`, `magnitudes`, `impact` |  |
| `search` | string |  |
| `category` | string | e.g. Supplements |
| `impact_id` | string |  |

### `whoop_journal_log` (changes data)

Log journal answers. Default is a merge: only the listed behaviours change, and a yes row keeps its stored magnitude and time unless you pass new ones (null clears). notes or replace_day:true rewrite the whole day (one date only), keeping current notes and answers unless replaced. Behaviours go by id or name, custom ones included. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `date` | string | Default today |
| `dates` | list of string | Several dates; merge writes only |
| `behaviors` | list of object |  |
| `unset` | list of integer or string | Ids or names whose answer to clear |
| `notes` | string | Replaces the day's notes; "" clears them |
| `replace_day` | boolean | Drops every answer not listed here |

Add `confirm: true` to make the change.

## WHOOP Coach

Ask WHOOP's own Coach, read past conversations and the outlook, manage what it remembers.

### `whoop_coach_ask` (changes data)

Ask WHOOP Coach (AI) and wait for the reply (up to ~50 s). One thread per agent per day; thread continues one from whoop_coach_history. Agents daily_outlook and day_in_review generate or open the current cycle's report and take no message. The coach can really create, edit and delete activities when asked (listed in actions); a saved memory shows only in the reply text. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `message` | string |  |
| `agent` | `coach`, `sleep`, `recovery`, `strain`, `stress`, `activity`, `daily_outlook`, `day_in_review` | activity needs activity_id |
| `activity_id` | string |  |
| `thread` | string | From whoop_coach_history |
| `new_thread` | boolean |  |
| `image_base64` | string | PNG or JPEG, ≤5 MB |

Add `confirm: true` to make the change.

### `whoop_coach_history`

Read WHOOP Coach history. list: conversations (fingerprint, title, agent, day), newest first. transcript: a listed thread's turns, with the actions the coach took. outlook: a day's Daily Outlook or Day in Review, only if it already exists (whoop_coach_ask generates one). To reply, pass a fingerprint to whoop_coach_ask as thread.

| Input | Type | Notes |
|---|---|---|
| `view` | `list`, `transcript`, `outlook` |  |
| `limit` | integer | Default 10 rows, or the 5 newest turns |
| `cursor` | string |  |
| `fingerprint` | string | transcript: from view list |
| `kind` | `daily_outlook`, `day_in_review` |  |
| `date` | string | outlook only |

### `whoop_memory`

What WHOOP Coach remembers about you: memories with id, title, summary and ACTIVE/INACTIVE status, plus the categories that have items. memory_id opens one memory's detail and marks it seen in the app, so only open it when asked. Memories can't be created here; the coach saves them from chats.

| Input | Type | Notes |
|---|---|---|
| `category` | string | timeline = all, or a key from categories |
| `limit` | integer |  |
| `memory_id` | string |  |

### `whoop_memory_set` (changes data)

Change what WHOOP Coach remembers: activate or deactivate a memory (inactive ones stop shaping coaching), delete one permanently, or enable_memory / disable_memory for the whole account. With memory off nothing is stored, whatever the coach says. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `action` (required) | `activate`, `deactivate`, `delete`, `enable_memory`, `disable_memory` |  |
| `memory_id` | string | From whoop_memory |

Add `confirm: true` to make the change.

## Body

Weight and body composition, and cycle tracking.

### `whoop_weight`

Weight and body-composition readings, newest first, in kg (display_unit is the account's unit). The newest reading is the profile weight. cursor takes a returned next_cursor. Ids feed whoop_weight_log.

| Input | Type | Notes |
|---|---|---|
| `limit` | integer |  |
| `cursor` | string |  |

### `whoop_weight_log` (changes data)

Add, edit or delete a weight or body-composition reading. weight and lean_mass need unit. add ALWAYS creates a new reading, even on a day that has one; to replace, edit by reading_id (from whoop_weight). The latest reading becomes the profile weight, and deleting a reading never reverts it. No future times. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `action` (required) | `add`, `edit`, `delete` |  |
| `reading_id` | string | For edit and delete |
| `weight` | number | Required for add |
| `unit` | `kg`, `lb` |  |
| `body_fat_pct` | number or null | Percent, e.g. 18.5; on edit null clears body composition |
| `lean_mass` | number |  |
| `at` | string | Default now; edit keeps it |

Add `confirm: true` to make the change.

### `whoop_cycle`

Menstrual cycle / Hormonal Insights for a date (default today): cycle or period day, phase and next-period window. include adds calendar (the date's month), settings, cycles (past cycles), symptoms (patterns) and day_log (the date's flow, mucus and symptoms, with ids). available:false when Hormonal Insights isn't set up.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |
| `include` | list of `calendar`, `settings`, `cycles`, `symptoms`, `day_log` |  |

### `whoop_cycle_log` (changes data)

Log or undo (yes:false) a date's period (flow 0 light, 1 medium, 2 heavy) or ovulation, and/or its menstruation flow, cervical mucus and symptoms. Not period and ovulation on one date; no future dates. Any menstruation but none also logs a period day; to remove a period fully, also pass menstruation:null. A period on a fresh date creates a cycle that undo won't remove. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `date` (required) | string |  |
| `period` | object |  |
| `ovulation` | object |  |
| `menstruation` | `none`, `light_flow`, `medium_flow`, `heavy_flow`, `spotting` or null | null clears it |
| `cervical_mucus` | `vaginal-dryness`, `vaginal-discharge---egg-white`, `vaginal-discharge---sticky`, `vaginal-discharge---creamy`, `vaginal-discharge---watery`, `cervical_mucus_pink_brown_or_tan`, `vaginal-discharge---grey` or null | null clears it |
| `symptoms` | list of object |  |

Add `confirm: true` to make the change.

## Plans and alarms

The weekly plan and Smart Alarm.

### `whoop_weekly_plan`

The Weekly Plan for the Monday–Sunday week containing a date (default today): plan name, days left, % accomplished and each goal's target (steps/day or minutes/week), days met and running total. Change goals with whoop_weekly_plan_set.

| Input | Type | Notes |
|---|---|---|
| `date` | string |  |

### `whoop_weekly_plan_set` (changes data)

Change Weekly Plan goals. set_goal adds or edits a goal (starting a Custom plan if there is none): STEPS target in steps/day, STRENGTH_TRAINING_TIME in minutes/week, within WHOOP's slider. remove_goal drops one, and removing the last ends the plan. end_plan removes every goal. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `action` (required) | `set_goal`, `remove_goal`, `end_plan` |  |
| `type` | `STEPS`, `STRENGTH_TRAINING_TIME` |  |
| `target` | integer |  |

Add `confirm: true` to make the change.

### `whoop_smart_alarm`

Smart Alarm: recurring schedules (id, days, mode, sleep goal, latest wake time, enabled), unscheduled days, the master switch and the next alarm WHOOP will set. Server state only: it doesn't prove the strap has synced.

No inputs.

### `whoop_smart_alarm_set` (changes data)

Change Smart Alarm. create/edit a recurring schedule (edit merges; mode NO_ALARM is off); a day belongs to one schedule, so claiming it moves it off another. enable/disable flip the master switch; disable also turns the next alarm off. single_alarm sets only the next alarm and turns recurring schedules off. Changes reach the strap only after the WHOOP app syncs. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `action` (required) | `create`, `edit`, `delete`, `enable`, `disable`, `single_alarm` |  |
| `schedule_id` | string | For edit and delete |
| `days` | list of `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, `SUN` |  |
| `mode` | `EXACT_TIME`, `SLEEP_GOAL`, `IN_THE_GREEN`, `NO_ALARM` |  |
| `sleep_goal` | `PEAK`, `PERFORM`, `GET_BY` | Only with mode SLEEP_GOAL |
| `wake_time` | string | Latest wake time, 24h, e.g. 06:45 |
| `enabled` | boolean | The schedule's own on/off flag |
| `goal` | `EXACT_TIME_PERFORM`, `EXACT_TIME_PEAK`, `EXACT_TIME_OPTIMIZE_SLEEP`, `IN_THE_GREEN`, `SLEEP_HEALTH_PEAK`, `SLEEP_HEALTH_PERFORM`, `SLEEP_HEALTH_GET_BY` | single_alarm only; default EXACT_TIME_PERFORM |

Add `confirm: true` to make the change.

## Profile, settings and community

Your profile, heart-rate zones, app settings, milestones and teams.

### `whoop_profile`

Your profile: name, email, birthday, gender, physiological baseline, height (m), weight (kg), unit system, location, max and resting HR, membership, hidden metrics and stealth mode. include adds hr_zones (bpm), entitlements (features that are off, and why), integrations and community privacy.

| Input | Type | Notes |
|---|---|---|
| `include` | list of `hr_zones`, `entitlements`, `integrations`, `privacy` |  |

### `whoop_profile_update` (changes data)

Change profile fields; pass only what changes and the rest is kept. Weight is kg or lb (24–272 kg), height m, cm or in (0.91–2.72 m). Changing birthday or country makes WHOOP end the session; totem refreshes the token on the next call. Email can't be changed here. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `first_name` | string |  |
| `last_name` | string |  |
| `birthday` | string |  |
| `gender` | `MALE`, `FEMALE`, `NON_BINARY`, `PREFER_NOT` |  |
| `physiological_baseline` | `MALE`, `FEMALE` | Sex used for physiology baselines |
| `weight` | number |  |
| `weight_unit` | `kg`, `lb` | Default kg |
| `height` | number |  |
| `height_unit` | `m`, `cm`, `in` | Default m |
| `city` | string |  |
| `state` | string | Region code, e.g. CA; required for US |
| `country` | string |  |
| `unit_system` | `metric`, `imperial` | Display units; also how WHOOP reads lift weights |

Add `confirm: true` to make the change.

### `whoop_hr_zones_set` (changes data)

Set heart-rate zones. max_hr: set max_heart_rate (WHOOP recomputes its default zones; custom zones stay in force). custom: zones as 5 [min, max] bpm pairs Z1..Z5, contiguous (each min = previous max + 1), Z5 max at most your max HR. reset: back to WHOOP's defaults. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `action` (required) | `max_hr`, `custom`, `reset` |  |
| `max_heart_rate` | integer |  |
| `zones` | list of list of any |  |

Add `confirm: true` to make the change.

### `whoop_preferences`

Account preferences: journal flags, notification namespaces (false = blocked), AI coach settings, the home dashboard (2 focus gauges and pinned metrics) and how many journal behaviours you track. Change them with whoop_preferences_set.

| Input | Type | Notes |
|---|---|---|
| `include` | list of `journal`, `notifications`, `ai`, `dashboard`, `tracked_behaviors` | Default all |

### `whoop_preferences_set` (changes data)

Change one account setting, picked by setting: hidden_metric (metric, hidden), stealth (enabled), dashboard (gauges and/or pinned; an omitted one is kept), notification (namespace, enabled), journal_prefs (its three flags), tracked_behaviors (track, untrack; untracking only hides a behaviour, its answers stay), clock_format. Previews unless confirm:true.

| Input | Type | Notes |
|---|---|---|
| `setting` (required) | `hidden_metric`, `stealth`, `dashboard`, `notification`, `journal_prefs`, `tracked_behaviors`, `clock_format` |  |
| `metric` | `BODY_COMP`, `HEALTHSPAN` |  |
| `hidden` | boolean |  |
| `enabled` | boolean | notification: false blocks the namespace |
| `namespace` | `StressSummary`, `GPS`, `ConversationalCheckIn`, `CheckIn` |  |
| `gauges` | list of string | 2 of pinned's values; not RECOVERY or DAY_STRAIN |
| `pinned` | list of `REM_SLEEP_DURATION`, `CALORIES`, `STEPS`, `SLEEP_PERFORMANCE`, `IN_SLEEP_EFFICIENCY`, `AVERAGE_HR`, `TOTAL_VOLUME_LOAD`, `RECOVERY`, `DAY_STRAIN`, `RHR`, `HR_ZONES_4_5`, `VO2_MAX`, `PREGNANCY_WEEK`, `STRAIN_AND_RECOVERY`, `CGM`, `RESTORATIVE_SLEEP_PERCENT`, `MENSTRUAL_CYCLE_INSIGHTS`, `STRESS_MONITOR`, `SLEEP_CONSISTENCY`, `HR_ZONES_ALL`, `WEIGHT`, `TIME_IN_BED`, `STRENGTH_ACTIVITY_TIME`, `HRV`, `RESPIRATORY_RATE`, `HR_ZONES_1_3`, `SLEEP_NEED`, `SLEEP_HOURS`, `SLEEP_NEED_FROM_SLEEP_DEBT_POST`, `BODY_COMPOSITION_LEAN` | In order; replaces the whole list |
| `journal_enabled` | boolean |  |
| `journal_autopop_enabled` | boolean |  |
| `ai_autopop_enabled` | boolean |  |
| `track` | list of integer or string | Behaviour ids or names |
| `untrack` | list of integer or string |  |
| `clock_format` | `TWELVE_HOUR_FORMAT`, `TWENTY_FOUR_HOUR_FORMAT` |  |

Add `confirm: true` to make the change.

### `whoop_milestones`

Milestone badges and the wear streak: totals, the data streak, top earned badges and the closest unearned ones. include badges lists every badge with its type. milestone_type returns one badge's detail: count, progress to the next level and levels earned with dates.

| Input | Type | Notes |
|---|---|---|
| `milestone_type` | string | e.g. HIGH_STRAIN |
| `include` | list of `badges` |  |

### `whoop_community`

Community and friends. Returns OTHER PEOPLE'S names and scores, read live (never cached). Views: communities (your teams and rank), leaderboard (a community's ranking plus your row, for a day or a 7/30-day average), following (people you follow and their shared scores), snapshot (one person's daily scores), comments (on a snapshot). No social writes.

| Input | Type | Notes |
|---|---|---|
| `view` | `communities`, `leaderboard`, `following`, `snapshot`, `comments` |  |
| `community_id` | integer | leaderboard; default your first |
| `metric` | `recovery`, `sleep`, `strain` |  |
| `window` | `day`, `week`, `month` |  |
| `date` | string | leaderboard: the window's last day |
| `limit` | integer |  |
| `offset` | integer |  |
| `user_id` | integer | snapshot: from view following; default you |
| `snapshot_id` | string | comments: from view snapshot |

## Anything else

Any WHOOP endpoint, for what no tool covers yet.

### `whoop_raw` (changes data)

Escape hatch: call any WHOOP endpoint when no tool fits (the whoop://catalog/endpoints resource lists verified paths). GET by default. Writes need allow_write:true and confirm:true; some paths are refused outright (auth, account, purchases, consents, strap, telemetry). Social writes (follow, comment) are only available here.

| Input | Type | Notes |
|---|---|---|
| `path` (required) | string | e.g. /home-service/v1/home |
| `method` | `GET`, `POST`, `PUT`, `DELETE` |  |
| `query` | object |  |
| `body` | any |  |
| `allow_write` | boolean |  |
