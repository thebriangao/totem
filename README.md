<p align="center">
  <img src="assets/banner.svg" alt="whoop-mcp — 47 MCP tools, remote-ready" width="820">
</p>

<p align="center">
  <i>Give Claude (or any MCP-compatible AI) <b>full read + write access to your Whoop fitness data</b> by wrapping Whoop's private iOS API — not their limited 13-endpoint public developer API.</i>
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/tests-127%20passing-green" alt="tests"></a>
  <a href="#"><img src="https://img.shields.io/badge/tools-47-lightgrey" alt="tools"></a>
  <a href="#"><img src="https://img.shields.io/badge/typescript-6.0-lightgrey" alt="typescript"></a>
  <a href="#"><img src="https://img.shields.io/badge/node-24%2B-lightgrey" alt="node"></a>
  <a href="#"><img src="https://img.shields.io/badge/MCP-1.29%2B-lightgrey" alt="mcp"></a>
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="license"></a>
</p>

47 tools, structured zod-validated outputs, bundled catalogs (372 exercises, 308 behaviors, 203 sports), write-safety harness, automatic Cognito token refresh, session-scoped catalog gate. TypeScript 6, Node 24, 127 tests.

---

## ⚠️ This violates Whoop's Terms of Service

This MCP wraps Whoop's **private iOS API**, which was discovered via mitmproxy. Doing that is explicitly prohibited by [Whoop's Terms of Use](https://www.whoop.com/us/en/whoop-terms-of-use/) **Section 4**, which forbids:

- **Reverse engineering** the Services or any embedded Software (Section 4(v))
- **Web scraping, web harvesting, or web data extraction** from WHOOP Services — *"even if the Account owner gives permission"* (Section 4(iii))
- Any other use of the Services "in violation of this Agreement" (Section 4(vii))

**Using this MCP is not illegal — but it is not allowed by Whoop's ToS.** Whoop reserves the right to take disciplinary action against accounts that violate the ToS, including (per their published policy) terminating your Membership, suspending API access, and barring you from future Memberships.

**Use this at your own discretion.** Nobody affiliated with this project will be paying your account-reactivation fee if Whoop bans you. If that risk is unacceptable, use [Whoop's public OAuth API](https://developer.whoop.com/) instead — it's the supported path. The trade-off is that the OAuth API exposes a much smaller, read-only slice (see [Why this exists](#why-this-exists) for the comparison).

---

## Quickstart (5 minutes)

```bash
# 1. Clone + install
git clone https://github.com/briangaoo/whoop-mcp.git
cd whoop-mcp
npm install

# 2. Add your Whoop login to .env
cp .env.example .env
# edit .env: set WHOOP_EMAIL and WHOOP_PASSWORD

# 3. One-time auth (handles SMS MFA if your account has it)
npm run cognito-bootstrap

# 4. Build
npm run build
```

Then wire into your client:

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whoop": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/whoop-mcp/dist/server.js"]
    }
  }
}
```

**Claude Code** — one line:

```bash
claude mcp add whoop /opt/homebrew/bin/node /absolute/path/to/whoop-mcp/dist/server.js
```

Restart your client. Ask Claude: *"how am i doing today on whoop?"* — you should see structured recovery / sleep / strain data come back.

**Optional but recommended:** install the `whoop-mcp` CLI globally so you can manage the server, run tests, deploy, and tail logs from any directory:

```bash
npm link   # from inside whoop-mcp/ — symlinks `whoop-mcp` into your global PATH

whoop-mcp         # banner + help
whoop-mcp info    # current state of your install
whoop-mcp ping    # is my deployment alive?
```

See [The `whoop-mcp` CLI](#the-whoop-mcp-cli) for the full command reference.

Full walkthrough with troubleshooting: [Setup](#setup). Want to host it on a remote URL so you can use it from multiple devices? See [Remote hosting](#remote-hosting).

---

## Table of contents

1. [Quickstart (5 minutes)](#quickstart-5-minutes) ← above
2. [Why this exists](#why-this-exists)
3. [What it does](#what-it-does)
4. [Architecture](#architecture)
5. [The 47 tools](#the-47-tools)
6. [Authentication](#authentication)
7. [Write-safety harness](#write-safety-harness)
8. [Bundled catalogs](#bundled-catalogs)
9. [Setup](#setup)
10. [Configuration](#configuration)
11. [Remote hosting](#remote-hosting)
12. [The `whoop-mcp` CLI](#the-whoop-mcp-cli)
13. [Example conversations](#example-conversations)
14. [Project structure](#project-structure)
15. [Development guide](#development-guide)
16. [Testing](#testing)
17. [Error handling](#error-handling)
18. [Token usage analysis](#token-usage-analysis)
19. [Privacy + security](#privacy--security)
20. [Troubleshooting](#troubleshooting)
21. [Comparison to alternatives](#comparison-to-alternatives)
22. [Roadmap](#roadmap)
23. [FAQ](#faq)
24. [Going deeper](#going-deeper)
25. [Disclaimers](#disclaimers)
26. [Acknowledgments](#acknowledgments)

**Other root-level docs:** [`WHOOP_API_ENDPOINTS.md`](WHOOP_API_ENDPOINTS.md) (5,900-line API reference) · [`CHANGELOG.md`](CHANGELOG.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`LICENSE`](LICENSE)

---

## Why this exists

Whoop ships two APIs.

**The public developer API** at [`developer.whoop.com`](https://developer.whoop.com/api/) is OAuth2-based, returns 429 on overage (threshold not published), is read-only, and exposes exactly **13 endpoints** under 6 scopes (`read:recovery`, `read:cycles`, `read:workout`, `read:sleep`, `read:profile`, `read:body_measurement`):

- `GET /v2/user/profile/basic` → `{user_id, email, first_name, last_name}`
- `GET /v2/user/measurement/body` → `{height_meter, weight_kilogram, max_heart_rate}` (no resting HR)
- `DELETE /v2/user/access` → revokes the OAuth grant
- `GET /v2/cycle` (paginated, ≤25/page) + `GET /v2/cycle/{id}` → strain, kJ, avg/max HR
- `GET /v2/cycle/{id}/sleep`, `GET /v2/cycle/{id}/recovery`
- `GET /v2/recovery` (paginated) → recovery score, RHR, HRV (rmssd milli), SpO2, skin_temp, calibrating flag
- `GET /v2/activity/sleep` + `GET /v2/activity/sleep/{id}` → stage totals (REM/light/SWS/wake/in-bed/no-data milli), cycle count, disturbance count, sleep_needed breakdown, performance/consistency/efficiency %, respiratory rate
- `GET /v2/activity/workout` + `GET /v2/activity/workout/{id}` → strain, kJ, avg/max HR, percent_recorded, distance/altitude, **zone_duration** array, sport_name (numeric `sport_id` removed 2025-09-01)
- `GET /v1/activity-mapping/{v1Id}` → bridges legacy long IDs → v2 UUIDs

Plus **6 webhook events** (v2 only — v1 webhooks removed): `recovery.{updated,deleted}`, `workout.{updated,deleted}`, `sleep.{updated,deleted}`, each carrying `{user_id, id, type, trace_id}`.

**What the public OAuth API does NOT have:**
journal (308 behaviors) · behavior impact analysis · stress monitor · Whoop Coach · per-minute hypnogram (only stage totals) · trends (25-metric series) · compare-windows · smart alarm CRUD · HR zone config · hidden metrics / stealth mode · profile editing · Strength Trainer (sets/reps/weight/PRs) · custom exercises · workout templates · activity create/delete writes · journal logging · cycle/symptom logging (women's health) · communities / leaderboards · performance assessment · live HR/state/stress · sleep coach (recommended bedtime) · calendar month grid · MCI / hormonal insights · body composition / VO2 / weight trends · achievements / streaks / data quality.

**The private iOS API** is what the actual Whoop app uses — `api.prod.whoop.com` behind AWS Cognito auth. It exposes **384 distinct operations** (after deduplication; raw mitm captures saw ~419 before merging body-shape variants) across **47 microservices**, including:

- **Strength Trainer** — every set of every workout, exercise-by-exercise volume progression, the full 372-exercise official catalog, custom exercise creation, template library, PRs with medals
- **The 308-behavior Journal** — every trackable behavior with its impact on recovery/HRV/sleep, full CRUD on daily entries
- **Hypnogram-level sleep data** — minute-by-minute sleep stage timeline, sleep HR and HRV averages, respiratory rate during sleep, latency, disturbances, debt
- **Stress monitor** — 15-minute-bucket stress timeline, calibration state, baseline
- **Smart Alarm** — full schedule CRUD, preferences, master enable/disable
- **Live HR + activity state** — current heart rate from the strap, current activity (workout / sleep / idle / recovery)
- **Whoop Coach** — the AI chat assistant inside the app, with full conversation history
- **Hidden metrics** — body composition, healthspan, stealth mode toggles
- **Health monitor** — weekly HRV / RHR / respiratory rate trends with insights
- **Performance assessment** — month-over-month coaching evaluations
- **Hormonal insights / MCI** — women's-health features, cycle tracking, symptom logging
- **Community leaderboards** — every metric × every window, with your rank
- **Followers + social graph**
- **Trend deep dives** — 25 distinct metrics over up to four windows (week / month / six_month / year — most metrics return 3 segments, a few return 2)
- **HR zones** — read + write, max HR auto-zones or custom 5-zone bands
- **Profile editing** — name, birthday, gender, height/weight, country/state, avatar
- **Behavior impact analysis** — "your alcohol intake last night likely dropped recovery by 12%"
- **Achievements + data streaks**

This MCP wraps the **iOS surface**, not the public OAuth one. That's the entire reason it exists.

### How was the iOS API reverse-engineered?

Short version: **mitmproxy + iPhone + Whoop's lack of SSL certificate pinning**. The full methodology, including which capture sessions revealed what, the dedup pipeline, the agent-based analysis, and the captured response fixtures, is documented in [`WHOOP_API_ENDPOINTS.md`](WHOOP_API_ENDPOINTS.md).

### Why use the iOS API instead of the public one?

Verified by fetching the live OAuth API docs and probing every endpoint (see "Comparison source" at the end of the table):

| Feature | Public OAuth (v2) | iOS API | This MCP |
|---|---|---|---|
| Recovery score, RHR, HRV (rmssd), SpO2, skin_temp | ✓ | ✓ | `whoop_recovery` |
| **HRV time-series across days** | ✗ (only per-cycle) | ✓ | `whoop_trend` (25 metrics × up to 4 windows) |
| Sleep cycle (start/end, performance/consistency/efficiency %) | ✓ | ✓ | `whoop_sleep` |
| Sleep stage **totals** (REM/light/SWS/wake/in-bed milli) | ✓ | ✓ | `whoop_sleep` |
| **Hypnogram (per-minute stage timeline)** | ✗ (only totals) | ✓ | `whoop_sleep` |
| Workout list (paginated) | ✓ (≤25/page) | ✓ | `whoop_workouts` |
| Workout detail (strain, kJ, avg/max HR, zone_duration, distance, altitude) | ✓ | ✓ | `whoop_workout` |
| Workout numeric `sport_id` | ✗ removed 2025-09-01 | ✓ | `whoop_workouts` (via private API) |
| Body measurements (height, weight, max HR) | ✓ (3 fields) | ✓ (30+ fields) | `whoop_profile` |
| **Resting HR (current)** | ✗ | ✓ | `whoop_profile, whoop_recovery` |
| Cycle (strain, kJ, avg/max HR) | ✓ | ✓ | `whoop_today, whoop_strain` |
| **Strength Trainer set/rep/weight + PRs** | ✗ | ✓ | `whoop_lift_*` (8 tools) |
| **372-exercise catalog** | ✗ | ✓ | `whoop_lift_catalog` |
| **308-behavior Journal** | ✗ | ✓ | `whoop_journal*` (5 tools) |
| **Behavior impact analysis** | ✗ | ✓ | `whoop_behavior_impact` |
| **Stress monitor (15-min buckets)** | ✗ | ✓ | `whoop_stress, whoop_live_stress` |
| **Whoop Coach AI chat** | ✗ | ✓ | `whoop_coach_ask` |
| **Smart Alarm read + write** | ✗ | ✓ | `whoop_smart_alarm*` |
| **HR zones (read + config)** | ✗ | ✓ | `whoop_hr_zones, whoop_hr_zones_set` |
| **Compare two windows side-by-side** | ✗ | ✓ | `whoop_compare` |
| **Sleep coach (recommended bedtime)** | partial (raw `sleep_needed`) | ✓ | `whoop_sleep_need` |
| **Calendar month grid** | ✗ | ✓ | `whoop_calendar` |
| **Performance assessment (WEEK/MONTH)** | ✗ | ✓ | `whoop_performance_assessment` |
| **Live HR / activity state / live stress** | ✗ | ✓ | `whoop_live_*` (3 tools) |
| **Community leaderboards** (9 window×metric combos) | ✗ | ✓ | `whoop_leaderboard` |
| **Hidden metrics + stealth mode** | ✗ | ✓ | `whoop_hidden_metric` |
| **Women's health: cycle, symptoms, MCI** | ✗ | ✓ | `whoop_cycle*, whoop_symptom_log` |
| **Write surface (any kind)** | ✗ | ✓ | 14 write tools |
| **Webhooks** (sleep/workout/recovery updated+deleted) | ✓ 6 events | ✗ (push notifications instead) | not exposed by MCP |
| Pagination | required (≤25/page, `nextToken`) | mostly absent | n/a |
| Rate limits | 429 exists (threshold not published) | none observed | n/a |
| Auth | OAuth2 client registration + scopes | Cognito proxy + auto-refresh | handled |
| Endpoint count | 13 | 384 deduped (47 microservices) | 47 MCP tools (incl. 2 escape hatches) |

**Comparison source.** Public-API column was extracted from [developer.whoop.com/api](https://developer.whoop.com/api/) and the per-resource docs at `/docs/developing/user-data/{recovery,sleep,workout,cycle}/` on 2026-05-25. iOS column was captured via mitmproxy across three sessions in May 2026 and is documented in [`WHOOP_API_ENDPOINTS.md`](WHOOP_API_ENDPOINTS.md). Enums and ID-format claims were verified live against a test account (the raw probe scripts and the 309-variant test matrix live in the separate `whoop-testing` archive — they require a dummy account and aren't shipped with the prod MCP).

If you don't care about anything in the bottom half of the table, the public API is fine and you should use it. If any row in the bottom half is interesting, you need this.

---

## What it does

The MCP runs as a local Node process. It speaks the **Model Context Protocol** over stdio, registers 47 tools at startup, and waits for tool calls from a connected MCP client (Claude Desktop, Claude Code, etc).

When a tool is called, it:

1. Authenticates via the cached Cognito access token (auto-refreshes if expired)
2. Issues HTTP requests to `api.prod.whoop.com`
3. Walks the response to extract a flat domain object (the **projection** step)
4. Validates the projected object against a zod schema (catches Whoop API drift)
5. Returns the structured JSON to the MCP client

Writes follow the same path, plus a **preview gate**: every write tool defaults `confirm: false`, returning a preview of what would be sent. Claude must explicitly re-call with `confirm: true` to fire the actual request.

### One-line summary per major capability

| Capability | What it does | Tool(s) |
|---|---|---|
| Today snapshot | Combined recovery + sleep + strain + current state | `whoop_today` |
| Historical day snapshot | Same but for any past date | `whoop_day` |
| Identity | Bootstrap + bio data + privacy state | `whoop_profile` |
| Calendar month | Per-day score grid | `whoop_calendar` |
| Recovery deep dive | Score, HRV, RHR, respiratory rate, contributors | `whoop_recovery` |
| Sleep deep dive | Stages, hypnogram, efficiency, performance, disturbances | `whoop_sleep` |
| Strain deep dive | Score, HR-zone time buckets, steps, strength time, workouts count | `whoop_strain` |
| Trend any metric | 25-metric × up-to-4-window data series | `whoop_trend` |
| Compare windows | Side-by-side metric comparison | `whoop_compare` |
| Stress monitor | 15-min bucket timeline + current level | `whoop_stress, whoop_live_stress` |
| Sleep coach | Recommended bedtime + sleep need breakdown | `whoop_sleep_need` |
| Live HR | Current bpm + zone if strap is recording | `whoop_live_hr` |
| Activity state | Currently in a workout / sleep / idle | `whoop_live_state` |
| Workout list | Recent activities with strain + HR + calories | `whoop_workouts` |
| Workout detail | Full HR curve, zones, MSK breakdown | `whoop_workout` |
| Create activity | Log a generic activity (manual entry) | `whoop_activity_create` |
| Delete activity | Remove an activity | `whoop_activity_delete` |
| Sport catalog | 203-sport `sport_id` ↔ name lookup | `whoop_sports_catalog` |
| PRs | All Strength Trainer PRs with medals | `whoop_lift_prs` |
| Exercise composite | Meta + history + PRs in one call | `whoop_lift_exercise` |
| Exercise progression | Volume trend over windows | `whoop_lift_progression` |
| Strength history | Recent strength workouts with per-exercise aggregates (set count, total reps, tonnage, medals) | `whoop_lift_history` |
| Templates | Saved workout templates | `whoop_lift_library` |
| Exercise catalog | 372-exercise bundled catalog with search | `whoop_lift_catalog` |
| Log strength workout | Save a finished workout with all sets | `whoop_lift_log` |
| Save template | Create or save-as a template | `whoop_lift_template_save` |
| Create custom exercise | Add a custom exercise based on an official one | `whoop_lift_custom_exercise` |
| Journal entry | Tracked behaviors for a date with values | `whoop_journal` |
| Behavior catalog | 308-behavior bundled catalog with search | `whoop_journal_catalog` |
| Behavior impact | Per-behavior recovery / HRV / sleep correlations | `whoop_behavior_impact` |
| Log journal | Save full daily journal entry | `whoop_journal_log` |
| Autopop journal | Trigger Whoop's HealthKit-based suggestion engine | `whoop_journal_autopop` |
| Cycle status | Phase, day, prediction, hormonal mode | `whoop_cycle` |
| Log period/ovulation | Cycle entry | `whoop_cycle_log` |
| Log symptoms | Women's-health symptom + flow log | `whoop_symptom_log` |
| Coach ask | Send a question to Whoop Coach | `whoop_coach_ask` |
| Performance assessment | Weekly or monthly coaching summary (YEAR rejected by API) | `whoop_performance_assessment` |
| Smart alarm read | Schedules + preferences | `whoop_smart_alarm` |
| Smart alarm write | 4 modes (schedule / prefs / master_enable / master_disable) | `whoop_smart_alarm_set` |
| Leaderboard | Community ranking + your position | `whoop_leaderboard` |
| HR zones read | Max HR + 5 zone ranges | `whoop_hr_zones` |
| HR zones write | Set max HR (auto-zones) or 5 custom zones | `whoop_hr_zones_set` |
| Profile update | Name / birthday / gender / weight / height / location | `whoop_profile_update` |
| Hidden metric | Show / hide BODY_COMP or HEALTHSPAN | `whoop_hidden_metric` |
| Raw API | Call any of the 384 endpoints directly | `whoop_raw` |
| Endpoint search | Search the bundled endpoint catalog | `whoop_endpoints` |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│         Claude Desktop / Claude Code        │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │   MCP client (built into Claude)      │  │
│  └───────────────────────────────────────┘  │
└─────────────────┬───────────────────────────┘
                  │ stdio (JSON-RPC)
                  │
        ┌─────────▼─────────┐
        │  src/server.ts    │  Node 24 process
        │  (MCP entry)      │
        └─────────┬─────────┘
                  │
        ┌─────────▼──────────┐
        │  registerTools()   │  src/tools/register.ts
        │  47 tool handlers  │
        └─────────┬──────────┘
                  │
   ┌──────────────┼──────────────────────┐
   │              │                      │
   ▼              ▼                      ▼
┌────────┐   ┌─────────┐         ┌──────────────┐
│schemas │   │projections│       │  whoop/      │
│(zod)   │   │(raw→flat) │       │  client      │
└────────┘   └─────────┘         └──────┬───────┘
                                        │ HTTPS + Bearer
                                        │
                                        ▼
                            ┌──────────────────────┐
                            │ api.prod.whoop.com   │
                            │ (47 microservices)   │
                            └──────────────────────┘
```

### Three-layer per-tool architecture

Every tool follows the same pattern. Take `whoop_recovery` as an example:

**1. Schema (`src/schemas/recovery.ts`)**

```ts
import { z } from "zod";

export const RecoveryOut = z.object({
  date: z.iso.date(),
  score: z.number().nullable(),
  state: z.enum(["GREEN", "YELLOW", "RED"]).nullable(),
  hrv: z.object({
    ms: z.number().nullable(),
    baseline_ms: z.number().nullable(),
    delta_pct: z.number().nullable(),
  }),
  rhr: z.object({
    bpm: z.number().nullable(),
    baseline_bpm: z.number().nullable(),
    delta_pct: z.number().nullable(),
  }),
  respiratory_rate: z.number().nullable(),
  spo2_pct: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  sleep_performance_pct: z.number().nullable(),
  contributors: z.array(z.object({
    name: z.string(),
    direction: z.enum(["positive", "negative", "neutral"]),
    detail: z.string().nullable(),
  })),
  calibration_state: z.enum(["CALIBRATING", "CALIBRATED"]).nullable(),
});
export type RecoveryOutT = z.infer<typeof RecoveryOut>;
```

The schema is the **contract** between the tool and Claude. It's used at runtime to validate that the projection produced data of the expected shape, and it's documentation — anyone reading `src/schemas/` knows exactly what each tool returns.

**2. Projection (`src/projections/recovery.ts`)**

```ts
import type { RecoveryOutT } from "../schemas/recovery.js";
import { isObject, asArray, asString } from "../lib/walk.js";

export function projectRecovery(raw: unknown, date: string): RecoveryOutT {
  // Walk every nested item with a `type` field, collecting {type, content} pairs.
  const items = collectItems(raw);
  // Recovery score lives in SCORE_GAUGE { id: "RECOVERY_SCORE_GAUGE" }.
  const gauge = items.find(it => it.type === "SCORE_GAUGE" && it.content.id === "RECOVERY_SCORE_GAUGE");
  const score = parseNumber(gauge?.content.score_display);
  // HRV / RHR / respiratory / sleep_performance live in CONTRIBUTORS_TILE metrics[].
  const contributors = items.find(it => it.type === "CONTRIBUTORS_TILE" && it.content.id === "RECOVERY_CONTRIBUTORS_TILE");
  const metrics = contributors?.content.metrics ?? [];
  // status = today's value, status_subtitle = baseline (API-provided).
  return { date, score, state, hrv, rhr, respiratory_rate, sleep_performance_pct, ... };
}
```

The projection function takes Whoop's deep-dive BFF response and emits a flat object. This is where all the "Whoop returns the data here, not where you'd expect" knowledge lives.

**Whoop migrated this shape in May 2026.** The recovery + strain deep-dive responses used to be `GRAPHING_CARD` tiles keyed by `content.title` (e.g. `"RECOVERY"`, `"HEART RATE VARIABILITY"`, `"STRAIN"`, `"CALORIES"`, `"HR ZONES 1-3"`). The new shape uses `SCORE_GAUGE` + `CONTRIBUTORS_TILE` items with stable `content.id` keys (`RECOVERY_SCORE_GAUGE`, `CONTRIBUTORS_TILE_HRV`, etc.). Other deep-dives (sleep, stress) still use the old card-based shape. When projections fail silently after a Whoop migration like this, the `whoop_endpoints` + `whoop_raw` escape hatch lets you fetch the new shape and inspect it before rewriting the projection — see [Fixing a broken projection](#fixing-a-broken-projection).

**3. Tool (`src/tools/v2/recovery.ts`)**

```ts
import { z } from "zod";
import { RecoveryOut } from "../../schemas/recovery.js";
import { projectRecovery } from "../../projections/recovery.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerRecovery(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_recovery",
    "Recovery deep-dive: score, HRV, RHR, respiratory rate, contributors.",
    { date: z.iso.date().optional() },
    async ({ date }) => {
      const d = date ?? todayIso();
      const raw = await client.get("/home-service/v1/deep-dive/recovery", { date: d });
      const projected = projectRecovery(raw, d);
      try {
        const out = RecoveryOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_recovery", e);
        throw e;
      }
    },
  );
}
```

The tool file for `whoop_recovery` is **~25 lines**. Tool files range from 26 to 116 lines depending on schema complexity (e.g., `whoop_smart_alarm_set` has 4 modes and is 103 lines; `whoop_coach_ask` polls for results and is 116). They register the tool with the MCP server, parse input arguments, call the client, run the projection, validate with zod, and return. Almost no logic — that all lives in projection.

This separation makes the codebase highly testable. Projection functions are pure transformations of raw API responses — they're tested against captured fixtures in `tests/fixtures/*.json` without ever hitting the network. See `tests/projections/round{1,2,3}.test.ts`.

### Where each piece lives

```
src/
├── server.ts               # 42 lines: dotenv → TokenManager → WhoopClient → McpServer
├── whoop/                  # The "transport + auth" layer (unchanged from v1)
│   ├── client.ts           # HTTP wrapper, error classification, 30s timeout
│   ├── cognito.ts          # Cognito proxy auth (no AWS SDK, no client secret)
│   ├── token_manager.ts    # Auto-refresh, single-flight, .env persistence
│   ├── write_safety.ts     # preview() + withPreview() helpers
│   ├── build_lift_body.ts  # 84 lines: builds Whoop's nested workout_groups[].workout_exercises[].sets[] body; denormalizes EXERCISES_BY_ID into each exercise_details
│   ├── errors.ts           # 5 error classes (Auth, Server, Api, Schema, Projection)
│   ├── json_out.ts         # JSON.stringify thin wrapper
│   ├── constants.ts        # BASE_URL, API_VERSION=7, REQUEST_TIMEOUT_MS
│   └── types.ts            # BootstrapSchema, ExerciseInfoSchema (reused zod)
│
├── data/                   # Bundled catalogs (auto-generated)
│   ├── behaviors.ts        # 308 journal behaviors + BEHAVIORS_BY_ID + BEHAVIORS_BY_NAME
│   ├── exercises.ts        # 372 official Strength Trainer exercises + EXERCISES_BY_ID
│   └── endpoints.ts        # 384 deduped API endpoint paths
│
├── schemas/                # zod output schemas, one file per tool group
│   ├── primitives.ts       # Shared: HrZoneDurations, RecoveryState, withPreview, etc.
│   ├── today.ts            # whoop_today + whoop_day
│   ├── profile.ts
│   ├── calendar.ts
│   ├── recovery.ts
│   ├── sleep.ts
│   ├── strain.ts
│   ├── trend.ts
│   ├── compare.ts
│   ├── stress.ts
│   ├── sleep_need.ts
│   ├── live.ts             # live_hr, live_state, live_stress
│   ├── workouts.ts         # workout/workouts/activity_create/activity_delete
│   ├── strength.ts         # all 9 strength tools
│   ├── journal.ts          # all 5 journal tools
│   ├── womens_health.ts    # cycle, cycle_log, symptom_log
│   ├── coach.ts            # coach_ask
│   ├── performance.ts
│   ├── smart_alarm.ts      # smart_alarm + smart_alarm_set
│   ├── leaderboard.ts
│   ├── settings.ts         # hr_zones, hr_zones_set, profile_update, hidden_metric
│   └── escape.ts           # raw + endpoints
│
├── projections/            # Raw API response → flat domain object
│   ├── today.ts            # Composes home + sleep + state
│   ├── profile.ts          # bootstrap + hidden-metrics + stealth
│   ├── calendar.ts
│   ├── recovery.ts         # Walks SCORE_GAUGE + CONTRIBUTORS_TILE (new May-2026 shape)
│   ├── sleep.ts            # Walks DETAILS_GRAPHING_CARDs + BAR_GRAPH_CARD stages
│   ├── strain.ts           # Same pattern as recovery
│   ├── trend.ts            # Handles dual segment shape (array vs named keys)
│   ├── stress.ts           # stress_state.timeline extraction
│   ├── sleep_need.ts       # Parses "8h 23m" formatted strings
│   ├── live_hr.ts          # health-tab-bff section walk
│   ├── live_state.ts       # user-state passthrough with state enum coercion
│   ├── live_stress.ts      # Reuses projectStress
│   ├── workouts.ts         # /developer/v2 list flattening
│   ├── workout.ts          # cardio-details walk (HR zones, MSK, etc.)
│   ├── lift_prs.ts         # extractPrTiles wrapper
│   ├── lift_exercise.ts    # 3-input composite
│   ├── lift_progression.ts # metrics-as-array fix
│   ├── lift_history.ts     # Filtered workouts + per-id cardio-details
│   ├── lift_library.ts     # Discriminated union list/single
│   ├── journal.ts          # v3 drafts → BEHAVIORS_BY_ID lookup
│   ├── behavior_impact.ts  # METRIC_CARD walk
│   ├── cycle.ts            # CYCLE_PHASE_TILE walk
│   ├── performance_assessment.ts
│   ├── smart_alarm.ts      # alarm_schedule_list + alarm_bounds composition
│   ├── leaderboard.ts      # board + your row composition
│   └── hr_zones.ts         # zones + settings composition
│
├── tools/
│   ├── register.ts         # Wires all 47 tools to McpServer
│   └── v2/                 # 47 tool files (26–116 lines each; median ~50)
│       ├── today.ts
│       ├── day.ts
│       ├── profile.ts
│       ├── calendar.ts
│       ├── recovery.ts
│       ├── sleep.ts
│       ├── strain.ts
│       ├── trend.ts
│       ├── compare.ts
│       ├── stress.ts
│       ├── sleep_need.ts
│       ├── live_hr.ts
│       ├── live_state.ts
│       ├── live_stress.ts
│       ├── workouts.ts
│       ├── workout.ts
│       ├── activity_create.ts
│       ├── activity_delete.ts
│       ├── sports_catalog.ts
│       ├── lift_prs.ts
│       ├── lift_exercise.ts
│       ├── lift_progression.ts
│       ├── lift_history.ts
│       ├── lift_library.ts
│       ├── lift_catalog.ts
│       ├── lift_log.ts
│       ├── lift_template_save.ts
│       ├── lift_custom_exercise.ts
│       ├── journal.ts
│       ├── journal_catalog.ts
│       ├── behavior_impact.ts
│       ├── journal_log.ts
│       ├── journal_autopop.ts
│       ├── cycle.ts
│       ├── cycle_log.ts
│       ├── symptom_log.ts
│       ├── coach_ask.ts
│       ├── performance_assessment.ts
│       ├── smart_alarm.ts
│       ├── smart_alarm_set.ts
│       ├── leaderboard.ts
│       ├── hr_zones.ts
│       ├── hr_zones_set.ts
│       ├── profile_update.ts
│       ├── hidden_metric.ts
│       ├── raw.ts
│       └── endpoints.ts
│
├── lib/                    # Shared utilities
│   ├── walk.ts             # Tree walkers, type coercers, extract*Sessions, findCardByTitle
│   ├── dates.ts            # todayIso, parsePgRange, rangeFromDays
│   ├── format.ts           # kgToLb, metersToFeet, kjToCal, msToMinutes
│   └── stats.ts            # mean, slopePerDay, deltaVsWindow
│
└── scripts/
    ├── cognito_bootstrap.ts        # One-time login: writes tokens to .env
    └── (catalog-regenerators, live-API test runners, and probe scripts all live in the separate whoop-testing archive — they need raw captures that contain personal data)
```

That's **114 source files** (115 with the one shipped script) totaling ~14,100 lines of TypeScript. ~8,300 lines are auto-generated bundled-catalog code (`src/data/{behaviors,exercises,sports,endpoints}.ts`). The remaining ~5,800 lines are real code: ~4,960 across projections + tools + whoop + lib (the actual logic), plus ~840 in zod schemas.

---

## The 47 tools

Below is every tool with its signature, source endpoints, and notes. Inputs are the zod schema; outputs are described as TypeScript-ish for brevity (full schemas in `src/schemas/`).

### Snapshots & profile (4)

#### `whoop_today`
Composite snapshot of today: recovery score + state, sleep performance + stages, day strain so far, current activity state, workouts count.

- **Input:** `{}`
- **Source endpoints (3 parallel):** `GET /home-service/v1/home?date=today`, `GET /home-service/v1/deep-dive/sleep/last-night?date=today`, `GET /activities-service/v1/user-state`
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
- **Output:** See [Architecture → Schema](#three-layer-per-tool-architecture) above for the full schema.
- **Walk shape (new):** `SCORE_GAUGE { id: "RECOVERY_SCORE_GAUGE" }.content.score_display` for the score, `CONTRIBUTORS_TILE { id: "RECOVERY_CONTRIBUTORS_TILE" }.content.metrics[]` for each contributor. Each metric carries `status` (today's value) and `status_subtitle` (baseline — API-provided, not computed). Whoop migrated from `GRAPHING_CARD` tiles to this shape in May 2026; the projection was rewritten on 2026-05-26.
- **Baseline:** unlike the old projection (which computed a 6-day rolling mean), baselines now come straight from the API in `status_subtitle`. Same field on the wire, no client-side math.
- **SpO2 / skin_temp:** populated only on 4.0+ straps. The new contributors tile includes `CONTRIBUTORS_TILE_SPO2` and `CONTRIBUTORS_TILE_SKIN_TEMPERATURE` when present.

#### `whoop_sleep`
Sleep duration, time in bed, efficiency, performance, consistency, all 4 stages (REM / LIGHT / SWS / AWAKE) with ms + percent, hypnogram timeline, disturbances, sleep HR + HRV.

- **Input:** `{date?: string}`
- **Source:** `GET /home-service/v1/deep-dive/sleep/last-night?date=`
- **Output:** `{date, started_at, ended_at, total_sleep_ms, time_in_bed_ms, efficiency_pct, performance_pct, consistency_pct, debt_ms, latency_ms, stages: {rem_ms, rem_pct, light_ms, light_pct, sws_ms, sws_pct, wake_ms, wake_pct}, hypnogram: [{started_at, ended_at, stage}], disturbances, sleep_hr: {avg_bpm, min_bpm}, sleep_hrv_ms, respiratory_rate}`

Note: the underlying endpoint is 848 KB. The projection extracts ~500 chars.

#### `whoop_strain`
Day strain + HR zone time buckets + steps + strength activity time + workouts count.

- **Input:** `{date?: string}`
- **Source:** `GET /home-service/v1/deep-dive/strain?date=`
- **Output:** `{date, score, calories, avg_hr_bpm, max_hr_bpm, zone_durations: {zone_0_ms..zone_5_ms}, workouts_count, steps, strength_activity_time_ms}`
- **Walk shape (new):** `SCORE_GAUGE { id: "STRAIN_SCORE_GAUGE" }.content.score_display` for the day strain, `CONTRIBUTORS_TILE { id: "STRAIN_CONTRIBUTORS_TILE" }.content.metrics[]` for time-bucket / step / strength-time contributors. `ACTIVITY` items in the same response represent the day's workouts (count = number of these items). Whoop migrated from `GRAPHING_CARD` tiles in May 2026; rewritten 2026-05-26.
- **Removed fields:** `calories`, `avg_hr_bpm`, `max_hr_bpm`, and per-zone (zone_0/2/3/5) granularity are no longer in this deep-dive endpoint. They live per-workout — use `whoop_workout` for HR zone breakdown of a specific activity. The schema fields are kept (returning null) so the shape stays compatible if Whoop adds them back.
- **HR zones:** Whoop now reports only `HR_ZONES_1_3` (low+mid intensity) and `HR_ZONES_4_5` (high intensity) at the day level. We store the 1-3 aggregate in `zone_1_ms` and the 4-5 aggregate in `zone_4_ms`; zones 0/2/3/5 stay null.

### Trends (2)

#### `whoop_trend`
Trend data for any of 25 metrics across up to four windows (week / month / six_month / year). Most metrics return 3 segments; a few (e.g. VO2_MAX) return 2.

- **Input:** `{metric: "HRV" | "RHR" | "RECOVERY" | "DAY_STRAIN" | "CALORIES" | "STEPS" | "AVERAGE_HR" | "HOURS_V_NEED" | "HOURS_V_NEEDED_PERCENT" | "TIME_IN_BED" | "SLEEP_PERFORMANCE" | "SLEEP_EFFICIENCY" | "SLEEP_CONSISTENCY" | "SLEEP_DEBT_POST" | "RESTORATIVE_SLEEP" | "HR_ZONES_1_3" | "HR_ZONES_4_5" | "RESPIRATORY_RATE" | "STRENGTH_ACTIVITY_TIME" | "STRESS" | "STRESS_DURING_SLEEP" | "STRESS_DURING_NON_STRAIN" | "VO2_MAX" | "BODY_COMPOSITION" | "WEIGHT", end_date?: string}`
- **Source:** `GET /progression-service/v3/trends/{metric}?endDate=`
- **Output:** `{metric, end_date, segments: [{label: "week"|"month"|"six_month"|"year", start_date, end_date, avg, min, max, delta_pct, unit, points: [{date, value, value_display}]}], cardio_fitness_level}`

Heads up: this is one of the larger tools by output size because it returns per-day data points across multiple windows. Output size varies by metric — see the [token usage analysis](#token-usage-analysis) for measured values. Use `whoop_compare` if you only need aggregate numbers.

#### `whoop_compare`
Side-by-side comparison of two date windows across recovery / sleep performance / day strain / HRV / RHR.

- **Input:** `{window?: "week" | "month", end_a?: string, end_b?: string, metrics?: string[]}`
- **Source:** 2× `whoop_trend` for each metric in the array
- **Output:** `{window, a: {start_date, end_date}, b: {start_date, end_date}, metrics: [{metric, a_avg, b_avg, delta_abs, delta_pct, unit}]}`

### Stress + sleep coach (2)

#### `whoop_stress`
Full stress timeline for a day (15-minute buckets), current level, baseline, peak, min.

- **Input:** `{date?: string}`
- **Source:** `GET /health-service/v2/stress-bff/{date}`
- **Output:** `{date, current_level, baseline_level, peak_level, min_level, calibration_state, timeline: [{started_at, ended_at, level}]}`

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

### Activities (2 read + 2 write)

#### `whoop_workouts`
List of recent activities with sport, start, end, duration, strain, HR, calories.

- **Input:** `{start?: string, end?: string, sport?: string, limit?: number}`
- **Source:** `GET /developer/v2/activity/workout` (yes, this uses the public-API endpoint — Whoop's iOS app does too)
- **Output:** `Array<{id, sport_name, start, end, duration_ms, strain, avg_hr_bpm, max_hr_bpm, calories, distance_m}>`

#### `whoop_workout`
Full detail of one activity: HR curve, HR zone durations, calories, distance. Strength workouts include MSK summary (volume + intensity).

- **Input:** `{activity_id: string}`
- **Source:** `GET /core-details-bff/v1/cardio-details?activityId=` (300 KB response)
- **Output:** `{id, sport_name, start, end, duration_ms, strain, calories, distance_m, avg_hr_bpm, max_hr_bpm, zone_durations: HrZoneDurations, hr_curve: [{at, bpm}], msk: {total_volume_kg, intensity_pct, strain_score, is_strength_workout}}`

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
- **Output:** `{exercise_id, end_date, segments: [{label, start_date, end_date, avg_volume, delta_pct, unit, points: [{date, volume, reps, top_weight}]}]}`

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
Per-behavior impact analysis — how this behavior has affected your recovery / HRV / sleep over time.

- **Input:** `{behavior_id: number | string}` (UUID preferred — pass the impact UUID from the v3 BFF, not the numeric `behavior_tracker_id`)
- **Source:** `GET /behavior-impact-service/v2/impact/details/{id}`
- **Output:** `{behavior_id, behavior_name, metrics: [{metric, delta_avg, delta_unit, sample_size, direction}], insight}`
- **Caveat:** This endpoint requires history — fresh accounts return 500 (no impact data computed yet). Brian's account works; the dummy doesn't.

#### `whoop_journal_log` ⚠️ WRITE (gated by `whoop_journal_catalog`)
Save a full journal entry. Replaces the existing entry for that date with the new set of behaviors. Use empty `behaviors: []` to clear the entry.

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
Current menstrual cycle status — phase, cycle day, prediction, hormonal mode, pregnancy state.

- **Input:** `{date?: string}`
- **Source:** `GET /womens-health-service/v1/menstrual-cycle-insights?date=`
- **Output:** `{date, phase, cycle_day, cycle_length, next_period_predicted_date, ovulation_predicted_date, hormonal_mode, contraception_type, is_pregnant}`
- **Caveat:** This endpoint requires the user's `contraception_type` to be set. If not, returns 400 with `"User has no contraception status"`. The user must run the MCI survey first (Whoop's iOS onboarding does this — or you can do it via `whoop_raw` to `PUT /health-service/v1/hormonal-insights/settings/mci/survey`).

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

### Social (1)

#### `whoop_leaderboard`
Community leaderboard + your position. Auto-discovers your first community if `community_id` omitted.

- **Input:** `{community_id?: number, date?: string, window?: "day"|"week"|"month", metric?: "recovery"|"sleep"|"strain"}`
- **Source (2-3 parallel):** memberships (if auto-discovery), board, your row
- **Output:** `{community_id, community_name, window, metric, date_label, average, total_compliant, total_empty, records: [{rank, user_id, first_name, last_name, value, secondary_value}], your_position: {rank, value, in_window}}`
- **Note:** 404 on your row is handled gracefully — `in_window: false` instead of throwing.

### Settings (1 read + 4 write)

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
Search the bundled catalog of 384 deduped endpoint paths.

- **Input:** `{filter?: string, method?: "GET"|"POST"|"PUT"|"DELETE", limit?: number}`
- **Source:** Bundled `src/data/endpoints.ts`
- **Output:** `{total_in_catalog, matched, truncated, endpoints: string[]}` (lines like `GET 200 /home-service/v1/home`)

---

## Authentication

The MCP wraps Whoop's Cognito auth flow with automatic refresh, single-flight concurrency control, and `.env` persistence. You bootstrap once with email + password (+ MFA code if your account has SMS MFA enabled). After that, refresh tokens auto-renew for ~30 days and access tokens auto-refresh every 24 hours in the background.

### The auth model

Whoop's iOS app uses **AWS Cognito** but routes all Cognito calls through a Whoop-owned proxy at `api.prod.whoop.com/auth-service/v3/whoop/`. The proxy fills in the `ClientId` + `SECRET_HASH` server-side, so we don't need to extract these from the IPA. The wire format is the standard `application/x-amz-json-1.1` Cognito envelope.

```
src/whoop/cognito.ts: 150 lines
├── bootstrapCognito({email, password, mfaPrompt})
│   → USER_PASSWORD_AUTH InitiateAuth
│   → If SMS_MFA / SOFTWARE_TOKEN_MFA challenge, prompt + RespondToAuthChallenge
│   → Returns {accessToken, refreshToken, idToken, expiresAt}
│
└── refreshCognitoSession(email, refreshToken)
    → REFRESH_TOKEN_AUTH InitiateAuth
    → Returns new tokens (refresh token may or may not rotate)
```

### Token management

```
src/whoop/token_manager.ts: 83 lines
├── constructor(config)
│   - Reads access token, decodes JWT exp claim
│   - Computes expiresAt = exp * 1000
│
├── async getToken(): Promise<string>
│   - If Date.now() < expiresAt - 60s → return cached token
│   - Else: refresh (single-flight)
│   - Returns: current valid access token
│
└── doRefresh(): single-flight async
    - Calls refreshCognitoSession()
    - Updates cached tokens + expiresAt
    - Persists new tokens to .env (overwrite-in-place)
```

The single-flight gate prevents thundering-herd refreshes when many tool calls race past the staleness check simultaneously:

```ts
async getToken(): Promise<string> {
  if (this.isFresh()) return this.accessToken;
  if (!this.refreshing) {
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
  }
  await this.refreshing;
  return this.accessToken;
}
```

### HTTP client

```
src/whoop/client.ts: 112 lines
└── class WhoopClient
    ├── get<T>(path, query?)
    ├── post<T>(path, body, query?)
    ├── put<T>(path, body, query?)
    └── delete<T>(path, query?)
        all delegate to:
    └── private request<T>(method, path, query, body)
        - Awaits getToken() for fresh bearer
        - Sets authorization: bearer <token>
        - Appends apiVersion=7
        - AbortController with 30s timeout
        - Classifies response:
            - 204 → undefined (writes)
            - 401 → throw WhoopAuthExpiredError
            - 5xx → throw WhoopServerError
            - other 4xx → throw WhoopApiError with parsed description
            - 2xx → return parsed JSON
```

### Error model

```
src/whoop/errors.ts
├── WhoopAuthExpiredError  - JWT expired, refresh triggered
├── WhoopApiError          - 4xx with description
├── WhoopServerError       - 5xx (transient)
├── WhoopSchemaError       - response shape change detected
└── WhoopProjectionError   - projection emitted data that failed zod parse
```

The last one is particularly useful — when Whoop changes a response shape, your tools don't silently return junk. The schema parse fails and you get a clear `"Projection for whoop_recovery failed zod parse: ..."` error.

---

## Write-safety harness

Every write tool defaults `confirm: false`. The first call returns a **preview** of what would execute. Claude must explicitly re-call with `confirm: true` to fire the actual request.

### How it works

```ts
// src/whoop/write_safety.ts
export const WritePreviewSchema = z.object({
  preview: z.literal(true),
  will_execute: z.object({
    method: z.string(),
    path: z.string(),
    body_summary: z.unknown(),
  }),
  set_confirm_true_to_run: z.literal(true),
});

export function preview(method: string, path: string, bodySummary: unknown): WritePreview {
  return {
    preview: true,
    will_execute: { method, path, body_summary: bodySummary },
    set_confirm_true_to_run: true,
  };
}

export function withPreview<T extends z.ZodTypeAny>(receipt: T) {
  return z.union([WritePreviewSchema, receipt]);
}
```

Every write tool's output schema is `withPreview(SuccessReceiptSchema)`, which is a discriminated union of either preview or receipt.

Inside a write tool handler:

```ts
async ({ confirm, ...args }) => {
  const body = buildBody(args);
  if (!confirm) {
    return { content: [{ type: "text", text: jsonOut(preview("POST", PATH, summarize(args))) }] };
  }
  const receipt = await client.post(PATH, body);
  return { content: [{ type: "text", text: jsonOut(ReceiptSchema.parse(receipt)) }] };
}
```

### What Claude sees

When Claude calls `whoop_lift_log` with workout details (no `confirm`):

```json
{
  "preview": true,
  "will_execute": {
    "method": "POST",
    "path": "/weightlifting-service/v2/weightlifting-workout/activity",
    "body_summary": {
      "exercise_count": 3,
      "set_count": 12,
      "exercise_list": [
        {"name": "BENCHPRESS_BARBELL", "set_count": 5},
        {"name": "OVERHEADPRESS_BARBELL", "set_count": 3},
        {"name": "OVERHANDGRIPPULLUPS", "set_count": 4}
      ]
    }
  },
  "set_confirm_true_to_run": true
}
```

Claude reads this back to you, you confirm, Claude re-calls with `confirm: true`, and the actual POST fires:

```json
{
  "logged": true,
  "activity_id": "6bbc2d36-dad7-408b-aa6e-90fe993c3bc7",
  "exercise_count": 3,
  "set_count": 12,
  "total_volume_kg": null
}
```

### Why it matters

LLMs occasionally hallucinate or misinterpret. Without the preview gate, "log my workout" could fire a malformed write that creates garbage activities on your Whoop account. With the gate, every write requires Claude to re-confirm — which means it has to "intend to write" twice, with the preview JSON visible in chat both times. You get to read what's about to happen before it happens.

---

## Bundled catalogs

Four datasets are compiled into the MCP at build time, not fetched at runtime:

| Catalog | Entries | Use | Catalog tool |
|---|---:|---|---|
| `src/data/behaviors.ts` | 308 | Journal behavior lookup; validation in `whoop_journal_log` + `whoop_symptom_log` | `whoop_journal_catalog` |
| `src/data/exercises.ts` | 372 | Exercise lookup; denormalization in `whoop_lift_log` body builder | `whoop_lift_catalog` |
| `src/data/sports.ts` | 203 | Numeric `sport_id` ↔ name lookup for `whoop_activity_create` | `whoop_sports_catalog` |
| `src/data/endpoints.ts` | 384 | Path search | `whoop_endpoints` |

### Session-scoped catalog gate

To keep tool descriptions small (saves ~14k system-prompt tokens per session), the three large catalogs (sports, exercises, behaviors) are **gated** by their corresponding catalog tools. Tools that take IDs from these catalogs refuse to run until the lookup tool has been called at least once in the session. The gate state lives in `src/whoop/session_state.ts`.

| Catalog | Unlock tool | Gated tools |
|---|---|---|
| sports | `whoop_sports_catalog` | `whoop_activity_create` |
| exercises | `whoop_lift_catalog` | `whoop_lift_log`, `whoop_lift_exercise`, `whoop_lift_progression`, `whoop_lift_template_save`, `whoop_lift_custom_exercise` |
| behaviors | `whoop_journal_catalog` | `whoop_journal_log`, `whoop_symptom_log` (only when `symptoms[]` is non-empty) |

Without the gate, an AI calling e.g. `whoop_activity_create` first gets a structured error `{error: "Must call whoop_sports_catalog first…", hint: "…"}` — even if the `sport_id` it guessed is real.

### Why bundled?

The MCP runs locally on your machine and has filesystem access. We could read these as JSON files at runtime. But:

1. **Speed.** No file I/O. The maps `BEHAVIORS_BY_ID` and `EXERCISES_BY_ID` are initialized once at module load.
2. **Type safety.** Each entry is typed against its zod schema at compile time. If the catalog has a malformed entry, `tsc` fails.
3. **Distribution.** A single `dist/server.js` includes everything. No external files to ship.

### Regenerating

When Whoop adds new behaviors / exercises / sports / endpoints, the bundled `src/data/*.ts` files need to be regenerated. The raw inputs and the build script are NOT shipped with this package — they live in the separate `whoop-testing` archive because the raw captures contain personal data (real account IDs, real biometric values, etc.).

To regenerate: ask the maintainer, or capture your own raw responses against the relevant endpoints via `whoop_raw` and hand-edit the corresponding `src/data/*.ts` file. The bundled files are auto-generated but plain TypeScript — they're readable and you can append entries directly if Whoop adds something new.

---

## Setup

### Prerequisites

- **macOS, Linux, or Windows.** All tested on macOS 14 (Apple Silicon). Linux works. Windows works via WSL or PowerShell.
- **Node.js 24+.** The MCP uses modern ESM, `fetch`, `AbortController`, and other Node 20+ features. Older Node won't work.
- **A Whoop account** with login credentials. SMS MFA is supported.
- **An MCP-compatible client.** Claude Desktop, Claude Code, or any other client that speaks MCP over stdio.

### Step 1: Install

```bash
git clone <repo> whoop-mcp
cd whoop-mcp
npm install
```

This installs:
- `@modelcontextprotocol/sdk` (the MCP server SDK)
- `zod` (schema validation)
- `dotenv` (env loading)
- `typescript`, `tsx`, `vitest` as devDeps

No network requests during install other than npm registry fetches.

### Step 2: Create `.env`

Create a file named `.env` at the repo root:

```bash
WHOOP_EMAIL=your@email.com
WHOOP_PASSWORD=your-whoop-password
WHOOP_USER_ID=
WHOOP_IOS_BEARER_TOKEN=
WHOOP_COGNITO_REFRESH_TOKEN=
```

The last three are filled in automatically after bootstrap.

**Security note:** Your password is stored locally in `.env`. It's used once during bootstrap and never again. If you'd rather not store it long-term, delete the `WHOOP_PASSWORD` line after the initial bootstrap — auto-refresh works off the refresh token, not the password.

### Step 3: Bootstrap

```bash
npm run cognito-bootstrap
```

What this does:
1. Loads `WHOOP_EMAIL` + `WHOOP_PASSWORD` from `.env`
2. Calls `POST /auth-service/v3/whoop/` with `AuthFlow: USER_PASSWORD_AUTH`
3. If the response is an `SMS_MFA` challenge, prompts you for the 6-digit code Whoop just texted you
4. Calls `RespondToAuthChallenge` with the code
5. Receives the access token (24h), refresh token (~30d), and ID token
6. Writes `WHOOP_IOS_BEARER_TOKEN` + `WHOOP_COGNITO_REFRESH_TOKEN` back to `.env`
7. Verifies refresh works by immediately calling `REFRESH_TOKEN_AUTH`
8. Writes the (possibly rotated) refreshed tokens back

You should see:

```
Authenticating with AWS Cognito (us-west-2_rYv1jhSC3)...
Enter the SMS MFA code Whoop just texted you: 123456

Initial auth OK. Access token expires in ~24h. Refresh token saved.

Verifying that auto-refresh works (no MFA expected)...
  Auto-refresh works. New access token expires in ~24h.

Setup complete. The MCP will auto-refresh access tokens going forward.
Re-bootstrap only when the refresh token expires (~30 days).
```

If your account has TOTP authenticator MFA instead of SMS, you'll be prompted with a slightly different message but the flow is the same.

### Step 4: Build

```bash
npm run build
```

This runs `tsc` and outputs to `dist/`. You should see no errors.

```bash
ls dist/
# data/  lib/  projections/  schemas/  scripts/  server.js  server.js.map  tools/  whoop/
```

### Step 5: Verify locally

Run the server in dev mode:

```bash
npm run dev
```

This starts the MCP server on stdio. You won't see much output — MCP servers are designed to be invoked by clients, not run interactively. Hit Ctrl+C to stop.

If you want to confirm tools registered correctly, look at the verbose output during the first call from your client.

### Step 6: Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your OS:

```json
{
  "mcpServers": {
    "whoop": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/whoop-mcp/dist/server.js"]
    }
  }
}
```

> **Critical:** Use the absolute path to `node` (find it via `which node`). Claude Desktop does NOT inherit your shell's `PATH`, so `"node"` alone won't be found.

Restart Claude Desktop. You should see "whoop" listed as an available MCP server in the chat input. All 47 tools should be available.

### Step 6b (alternative): Wire into Claude Code

```bash
claude mcp add whoop /opt/homebrew/bin/node /absolute/path/to/whoop-mcp/dist/server.js
```

Or edit your Claude Code MCP config directly:

```bash
~/.claude/mcp.json
```

### Step 6c (alternative): Use `tsx` for live dev

If you're actively developing the MCP, point your client at `tsx` so you don't have to rebuild:

```json
{
  "mcpServers": {
    "whoop": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["tsx", "/absolute/path/to/whoop-mcp/src/server.ts"]
    }
  }
}
```

### Step 7: Test

In your Claude client, ask:

> "How am I doing today on Whoop?"

You should get a structured response from `whoop_today` containing your recovery score, sleep performance, and day strain.

If it doesn't work, see [Troubleshooting](#troubleshooting).

---

## Configuration

### Environment variables

Required:

| Variable | Description |
|---|---|
| `WHOOP_EMAIL` | Your Whoop login email |
| `WHOOP_PASSWORD` | Your Whoop login password (only used during bootstrap) |
| `WHOOP_IOS_BEARER_TOKEN` | Cognito access token (24h lifetime, auto-refreshed) |
| `WHOOP_COGNITO_REFRESH_TOKEN` | Cognito refresh token (~30d lifetime) |

Optional:

| Variable | Description |
|---|---|
| `WHOOP_USER_ID` | Your Whoop user ID (used by `whoop_profile`, `whoop_leaderboard`) |
| `WHOOP_TIMEZONE` | IANA timezone (e.g., `America/Los_Angeles`). Whoop's API returns timestamps in UTC; the MCP rewrites them with an explicit offset for this zone so the AI sees clock-correct local times. Falls back to the server's system timezone if unset — which is UTC inside Docker / Fly / Railway, so **set this explicitly for deployed instances** or you'll get UTC timestamps that confuse the AI. |

The MCP also respects standard env vars like `NODE_ENV` and `HTTP_PROXY` (for routing through a proxy during development).

### Claude Desktop config

The minimal MCP config:

```json
{
  "mcpServers": {
    "whoop": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/whoop-mcp/dist/server.js"]
    }
  }
}
```

With explicit env (overrides .env):

```json
{
  "mcpServers": {
    "whoop": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/whoop-mcp/dist/server.js"],
      "env": {
        "WHOOP_EMAIL": "you@example.com",
        "WHOOP_USER_ID": "200001"
      }
    }
  }
}
```

The MCP loads `.env` from the repo root (relative to `server.js`), so if you move the built `dist/` somewhere else, also move `.env` to its parent.

### TypeScript config

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

Strict mode is on. `exactOptionalPropertyTypes` is the strictest setting — TypeScript will reject `{x?: number}` types that allow `{x: undefined}`, requiring you to use `{x?: number | undefined}` explicitly when needed.

`noUncheckedIndexedAccess` means `arr[0]` is typed as `T | undefined`, not `T`. This catches off-by-one bugs in array access.

---

## Remote hosting

By default this MCP runs as a local stdio process that your AI client spawns as a subprocess. That's fine for one machine, but if you want to:

- Use the same Whoop MCP from multiple devices (laptop, desktop, phone via a mobile MCP client)
- Run it on an always-on server so it's available without your computer being on
- Share it with a remote Claude (claude.ai web, ChatGPT once their MCP support lands)

…you can also run it over HTTP. The exact same 47 tools, same Cognito auto-refresh, same write-safety harness — just exposed at a URL behind a bearer-token gate instead of stdio.

### How it works

```
Your AI client (Claude Desktop, Claude Code, ChatGPT, etc.)
    │
    │  HTTPS + Authorization: Bearer <your-token>
    ▼
┌──────────────────────────────────┐
│  whoop-mcp HTTP server           │
│  - StreamableHTTP transport      │
│  - bearer-token auth gate        │
│  - same 47 MCP tools             │
│  - same Cognito auto-refresh     │
└──────────────────────────────────┘
    │
    │  authenticated as YOUR Whoop account
    ▼
api.prod.whoop.com
```

**Single-user, single-account.** A deployment is tied to one Whoop account (the one whose Cognito tokens you set in env). If two people each want remote MCP access, each runs their own deployment.

### One-time setup on your local Mac

You still need to do the Cognito bootstrap locally because it requires an interactive MFA prompt (if your Whoop account has SMS MFA on). After that, you copy the resulting tokens to your server.

```bash
git clone https://github.com/briangaoo/whoop-mcp.git
cd whoop-mcp
npm install
cp .env.example .env
# edit .env: WHOOP_EMAIL + WHOOP_PASSWORD
npm run cognito-bootstrap
# This populates WHOOP_IOS_BEARER_TOKEN + WHOOP_COGNITO_REFRESH_TOKEN in .env

# Generate a random bearer token your AI client will send on every request:
openssl rand -hex 32
# → save the output somewhere safe (you'll need it both server-side and client-side)
```

### Deploy with Docker (anywhere)

The repo ships a `Dockerfile` that builds a single Alpine-based image. Deploy it to any container host:

```bash
# Local test first
docker build -t whoop-mcp .
docker run --rm -p 3000:3000 \
  -e WHOOP_EMAIL=your@email.com \
  -e WHOOP_IOS_BEARER_TOKEN="$(grep WHOOP_IOS_BEARER_TOKEN .env | cut -d= -f2-)" \
  -e WHOOP_COGNITO_REFRESH_TOKEN="$(grep WHOOP_COGNITO_REFRESH_TOKEN .env | cut -d= -f2-)" \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  whoop-mcp

# You should see: [whoop-mcp] listening on http://0.0.0.0:3000/mcp
# Hit GET /health (no auth) to confirm it's alive:
curl http://localhost:3000/health
# → {"status":"ok"}
```

From here, deploy to any Docker host you like:

| Host | Why | Notes |
|---|---|---|
| **Fly.io** | free tier with always-on machines, easy CLI | `fly launch && fly secrets set WHOOP_EMAIL=... WHOOP_IOS_BEARER_TOKEN=... WHOOP_COGNITO_REFRESH_TOKEN=... MCP_AUTH_TOKEN=...` |
| **Railway** | tightest GitHub integration, $5 trial | New project → deploy from GitHub → add the env vars in the Variables panel |
| **Render** | free tier (with cold starts) | Free tier sleeps after 15 min idle — bad for SSE-style connections, fine for occasional MCP queries |
| **A VPS** (Hetzner, DigitalOcean, etc.) | $4–6/mo, full control | `docker run -d --restart=always ...` and put it behind Caddy or Nginx with HTTPS |
| **Cloudflare Tunnel from your Mac** | zero deployment cost, easiest debug path | `cloudflared tunnel --url http://localhost:3000` — only works when your Mac is awake |

### Point your AI client at the deployed URL

The exact config depends on the client.

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`. Claude Desktop does **not** natively support remote MCP servers; you have to bridge through stdio with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-app.fly.dev/mcp",
        "--header",
        "Authorization:Bearer your-mcp-auth-token-here"
      ]
    }
  }
}
```

`mcp-remote` is a small Node bridge that connects to your remote HTTP MCP server and proxies it as stdio for Claude Desktop. First invocation downloads it via `npx` (~5s); subsequent runs are cached and instant.

> If you paste a config with `{"url": "...", "headers": {...}}` directly into Claude Desktop, you'll see a dialog: *"The following entries in claude_desktop_config.json are not valid MCP server configurations and were skipped: whoop"* — that's Claude Desktop telling you it only accepts stdio. Use the `mcp-remote` form above.

**Claude Code** — natively supports remote MCP servers (no bridge needed):

```bash
claude mcp add whoop --url https://your-app.fly.dev/mcp --header "Authorization: Bearer your-mcp-auth-token-here"
```

Restart your client. The 47 tools should appear identically to the local stdio setup.

### Environment variables (HTTP mode)

| Var | Required | Default | Notes |
|---|---|---|---|
| `MCP_TRANSPORT` | yes | `stdio` | Set to `http` to enable the HTTP server |
| `MCP_AUTH_TOKEN` | yes (HTTP) | — | ≥16 char random string clients must present in the `Authorization: Bearer …` header |
| `PORT` (or `MCP_HTTP_PORT`) | no | `3000` | The HTTP port to listen on |
| `WHOOP_EMAIL` | yes | — | Same as local |
| `WHOOP_IOS_BEARER_TOKEN` | yes | — | From `npm run cognito-bootstrap` |
| `WHOOP_COGNITO_REFRESH_TOKEN` | yes | — | From `npm run cognito-bootstrap` |
| `WHOOP_TOKEN_STORE` | no | `envfile` | `envfile` writes refreshed tokens back to `.env` (works on hosts with a persistent volume mounted at `/app`); `memory` skips persistence (use on Cloudflare Workers / read-only filesystems — accept that you re-bootstrap every ~30 days when the refresh token expires) |

The Dockerfile sets `MCP_TRANSPORT=http` and `WHOOP_TOKEN_STORE=memory` by default. Override if your host gives you a writable volume.

### Health check

```
GET /health  →  200 OK {"status":"ok"}
```

No auth required. Use this for container health probes (Fly, Kubernetes, Docker `HEALTHCHECK`).

### Security model

The bearer token is the only thing standing between a stranger with your URL and full read+write access to your Whoop account. Treat it like a password:

- **Generate randomly.** `openssl rand -hex 32` produces a 64-char hex string with 256 bits of entropy. Don't pick a memorable one.
- **Never commit it.** It belongs in your host's secrets, not in source.
- **Rotate if leaked.** Generate a new one, update on both server and client, redeploy.
- **HTTPS only in production.** Plain HTTP exposes the bearer token to anyone sniffing the network. Every recommended host above gives you free HTTPS automatically.
- **The token never expires** on its own — there's no rotation policy built in. If you want one, set up a cron job to redeploy with a new `MCP_AUTH_TOKEN` every N days.

The token is compared in constant time (`crypto.timingSafeEqual`) to dodge timing attacks. Failed auth returns 401 without revealing whether the token was missing vs wrong.

### Re-bootstrap when Cognito expires (~every 30 days)

Whoop's refresh token has a ~30-day lifetime. When it expires, every tool call against the deployed MCP starts returning 5xx until you do a fresh `USER_PASSWORD_AUTH` login — which triggers an SMS code that needs interactive entry. There's no terminal on the deployed host, so the recovery flow is:

```bash
# Run from your Mac (anywhere with the repo checked out + .env):
npm run rebootstrap
# Or pass --app if your fly.toml isn't in the cwd:
npx tsx src/scripts/rebootstrap.ts --app whoop-mcp-bg
```

What this does:
1. Calls `USER_PASSWORD_AUTH` against Cognito (Whoop texts your phone)
2. Prompts you in the terminal for the SMS code
3. Writes new `WHOOP_IOS_BEARER_TOKEN` + `WHOOP_COGNITO_REFRESH_TOKEN` to your local `.env`
4. Pushes both to Fly via `fly secrets set -a <your-app>` so the deployed server picks them up automatically (Fly restarts the machine with the new secrets — takes ~10s)

You'll know you need to run this when:
- Tool calls start failing with 500-class errors
- `fly logs -a <your-app>` shows `WhoopAuthExpiredError` followed by a refresh that fails
- Or proactively: ~25 days after your last bootstrap

**Caveat: requires you to be at your Mac.** If you're traveling when this happens, you're locked out until you can get back to a machine with the repo + `fly` CLI. If that's a dealbreaker, build the optional web-admin UI variant (a few hours of work to add a `/admin` route that takes the SMS code from a browser — see Roadmap).

### When to use HTTP vs stdio

| Use stdio when | Use HTTP when |
|---|---|
| You only use one machine | You roam between laptop + desktop + phone |
| You're fine restarting your AI client to update the MCP | You want the MCP always running |
| Local debugging — `npm run dev` reloads instantly | You want to share access between AI clients (Claude + ChatGPT etc.) |
| Privacy: nothing leaves your machine except direct Whoop API calls | You're OK with your Whoop tokens living on a remote host |

If you're not sure, start with stdio. Migrate to HTTP later — the codebase supports both, no fork needed.

---

## The `whoop-mcp` CLI

The package ships a CLI that wraps every npm script plus a handful of operational helpers (Fly deploy / logs / status, health ping, install-state inspection, config snippets). It works from any directory on your system — the CLI resolves its own install path, so `whoop-mcp deploy` from `~/Desktop` does the same thing as `cd whoop-mcp && fly deploy`.

### Install

```bash
git clone https://github.com/briangaoo/whoop-mcp.git
cd whoop-mcp
npm install
npm run build        # compiles src/cli/index.ts → dist/cli/index.js
npm link             # symlinks `whoop-mcp` into your global PATH
```

After this, `whoop-mcp` is a real command anywhere. `which whoop-mcp` should print something like `/opt/homebrew/bin/whoop-mcp` (Apple Silicon) or `/usr/local/bin/whoop-mcp` (Intel / Linux).

To unlink later: `cd whoop-mcp && npm unlink -g`.

### Running it

```bash
whoop-mcp                 # Banner + full help
whoop-mcp help            # Help without the banner art
whoop-mcp --version       # Just the version string (parseable)
```

### Command groups

| Group | Command | What it does |
|---|---|---|
| **Local** | `whoop-mcp start [--http]` | Run the compiled MCP server. Default stdio mode; `--http` boots the HTTP transport. Drop-in replacement for `node dist/server.js`. |
| | `whoop-mcp dev` | `tsx src/server.ts` — auto-reload dev mode (stdio). |
| | `whoop-mcp dev:http` | `tsx src/server.ts` with `MCP_TRANSPORT=http`. |
| | `whoop-mcp build` | `tsc` — compile to `dist/`. |
| | `whoop-mcp test [filter]` | `vitest run` with optional filter. |
| | `whoop-mcp typecheck` | `tsc --noEmit`. |
| **Setup** | `whoop-mcp bootstrap` | First-time Cognito login, writes tokens to `.env` (SMS code prompt in your terminal). |
| | `whoop-mcp rebootstrap [--app <fly-app>]` | Re-bootstrap + push fresh tokens to your Fly app's secrets. See [Re-bootstrap when Cognito expires](#re-bootstrap-when-cognito-expires-every-30-days). |
| **Deployed** | `whoop-mcp deploy` | `fly deploy` from the package root. |
| | `whoop-mcp logs` | `fly logs --tail`, with `-a` auto-filled from `fly.toml` or `$FLY_APP`. |
| | `whoop-mcp status` | `fly status` + a live GET on `/health`. |
| | `whoop-mcp ping` | Just the `/health` probe — fast confidence check that your deploy is up. |
| **Inspect** | `whoop-mcp info` | Install path, node version, dist build state, `.env` presence, Fly app, deployed URLs. |
| | `whoop-mcp tools` | Lists all 47 MCP tools grouped by read / write / escape-hatch. |
| | `whoop-mcp config <stdio\|http>` | Prints a Claude Desktop config snippet pre-filled with absolute paths or your Fly URL. |
| **Help** | `whoop-mcp help` | The full command list. |
| | `whoop-mcp version` | Just the version string. |

### Examples

```bash
# Daily life
whoop-mcp ping              # Is my deployment up?
whoop-mcp logs              # Tail Fly logs without remembering -a flag
whoop-mcp info              # Quick state check

# Shipping a change
whoop-mcp typecheck && whoop-mcp test && whoop-mcp deploy

# Recovering when Cognito refresh dies (~every 30 days)
whoop-mcp rebootstrap       # SMS prompt → tokens pushed to Fly → done

# Generating a Claude config (stdio install)
whoop-mcp config stdio > /tmp/whoop-config.json
```

### Design choices

- **Single binary, no install pollution.** One file in `bin/`, no auxiliary `whoop-mcp-deploy` / `whoop-mcp-logs` etc.
- **The CLI never assumes your cwd is the repo.** It resolves the package root from `import.meta.url`, then spawns subprocesses with `cwd = ROOT`. You can `cd` anywhere.
- **`whoop-mcp start` keeps stdout clean** — no banner, no header, no color — so it can be plugged into Claude Desktop's stdio mode as a drop-in for `node dist/server.js`.
- **Dev-tool subcommands need devDeps installed.** `dev`, `test`, `build`, `typecheck`, `bootstrap`, `rebootstrap` all spawn binaries from local `node_modules/.bin/`. If you cloned and ran `npm install`, you're fine. If you somehow installed via `npm install -g whoop-mcp` without the dev deps, those commands will exit with a "missing dev dependency" message — `start`, `ping`, `info`, `logs`, `deploy`, `status` still work.
- **Banner can be disabled.** Set `NO_COLOR=1` to drop ANSI codes, useful for CI logs and screen readers.

---

## Example conversations

Here's what real conversations look like, with the tool calls Claude makes inline.

### "How am I doing today?"

```
You: how am i doing today on whoop?

Claude calls: whoop_today({})

Returns: {
  "date": "2026-05-25",
  "recovery": {"score": 78, "state": "GREEN", "hrv_ms": 42, "rhr_bpm": 68},
  "sleep": {
    "performance_pct": 83,
    "total_sleep_ms": 26640000,
    "time_in_bed_ms": 28740000,
    "efficiency_pct": 93,
    "stages": {"rem_ms": 6600000, "light_ms": 15180000, "sws_ms": 4860000, "wake_ms": 2100000},
    ...
  },
  "strain": {"score": 17.8, "calories": 1792, "avg_hr_bpm": 84, "max_hr_bpm": 171, "workouts_count": 1},
  "current_state": {"state": "idle", "sport_name": null, "started_at": null}
}

Claude: Solid day. Your recovery is 78 (GREEN), HRV is 42ms which is at your baseline,
and resting HR is 68 bpm. You slept 7h 24m last night (83% performance) with 93%
efficiency. Strain is already at 17.8 from your one workout earlier — strong showing.
You're currently idle.
```

### "Log my workout"

```
You: log my workout: bench 5x5 @ 225, ohp 3x8 @ 95, pull-ups 4x10

Claude calls: whoop_lift_log({
  exercises: [
    {exercise_id: "BENCHPRESS_BARBELL", sets: [
      {reps: 5, weight: 225}, {reps: 5, weight: 225}, {reps: 5, weight: 225},
      {reps: 5, weight: 225}, {reps: 5, weight: 225}
    ]},
    {exercise_id: "OVERHEADPRESS_BARBELL", sets: [
      {reps: 8, weight: 95}, {reps: 8, weight: 95}, {reps: 8, weight: 95}
    ]},
    {exercise_id: "OVERHANDGRIPPULLUPS", sets: [
      {reps: 10}, {reps: 10}, {reps: 10}, {reps: 10}
    ]}
  ]
})

Returns: {
  "preview": true,
  "will_execute": {
    "method": "POST",
    "path": "/weightlifting-service/v2/weightlifting-workout/activity",
    "body_summary": {
      "exercise_count": 3,
      "set_count": 12,
      "exercise_list": [
        {"name": "BENCHPRESS_BARBELL", "set_count": 5},
        {"name": "OVERHEADPRESS_BARBELL", "set_count": 3},
        {"name": "OVERHANDGRIPPULLUPS", "set_count": 4}
      ]
    }
  },
  "set_confirm_true_to_run": true
}

Claude: Ready to log:
- Bench Press: 5 sets × 5 reps @ 225 lbs
- Overhead Press: 3 sets × 8 reps @ 95 lbs
- Pull-ups: 4 sets × 10 reps

12 total sets across 3 exercises. Confirm?

You: yes

Claude calls: whoop_lift_log({...same args..., confirm: true})

Returns: {
  "logged": true,
  "activity_id": "2c425b12-5abe-4c50-9e40-67449993c78e",
  "exercise_count": 3,
  "set_count": 12,
  "total_volume_kg": null
}

Claude: Done. Workout logged with ID 2c425b12. Whoop will compute the strain score
async in the next few minutes.
```

### "How's my HRV trending?"

```
You: how's my hrv trending vs last month?

Claude calls: whoop_trend({metric: "HRV"})

Returns: {
  "metric": "HRV",
  "end_date": "2026-05-25",
  "segments": [
    {
      "label": "week",
      "start_date": "May 19-25",
      "end_date": "May 26",
      "avg": 41,
      "delta_pct": -2,
      "unit": "ms",
      "points": [...]
    },
    {
      "label": "month",
      "start_date": "Apr 26 - May 25",
      "avg": 42,
      "delta_pct": 8,
      "unit": "ms",
      "points": [...]
    },
    {
      "label": "six_month",
      "avg": 39,
      "delta_pct": 13,
      "unit": "ms",
      "points": [...]
    }
  ]
}

Claude: Up trend. Your 30-day average HRV is 42ms (+8% vs prior month), and 6-month
average is 39ms (+13% vs prior 6-month). This week is 41ms (-2% vs last week — basically
flat). Long-term trajectory is positive.
```

### "What did Whoop Coach say about my recovery?"

```
You: ask whoop coach about my recovery

Claude calls: whoop_coach_ask({message: "How's my recovery looking?"})

Returns: {
  "preview": true,
  "will_execute": {
    "method": "POST",
    "path": "/ai-conversation-bff/v1/conversation + /turn",
    "body_summary": {"message": "How's my recovery looking?", "context": "HOME"}
  },
  "set_confirm_true_to_run": true
}

Claude: I'll ask Whoop Coach. Confirm to send?

You: yes

Claude calls: whoop_coach_ask({message: "How's my recovery looking?", confirm: true})

(30 second poll loop)

Returns: {
  "conversation_id": "5e0d4424-b31a-4a67-b06d-dfbf1030c0e9",
  "turn_id": "596cb5fa-17b1-41e2-bf1e-6eed830462b7",
  "response_text": "Hey Brian, your recovery is sitting at 78% today which is in your
  green zone. HRV is right at baseline (42ms), and RHR is 68 — within 2 bpm of your
  typical resting. Sleep efficiency was strong at 93% but you came in about 35 minutes
  short of your needed hours. Push the lifts you had planned, but consider a slightly
  earlier bedtime tonight to recover the deficit.",
  "turn_status": "COMPLETE",
  "polled_iterations": 8,
  "timed_out": false
}

Claude: Whoop Coach says you're in the green zone (78% recovery). HRV is at baseline,
RHR is 2 bpm above typical, sleep efficiency was 93% but you were 35 min short of
your sleep need. Coach recommends pushing your planned lifts and going to bed slightly
earlier tonight to recover the deficit.
```

### "Show me my bench press history"

```
You: show me bench press history with PRs

Claude calls: whoop_lift_exercise({exercise_id: "BENCHPRESS_BARBELL"})

Returns: {
  "exercise": {
    "id": "BENCHPRESS_BARBELL",
    "name": "Bench Press - Barbell",
    "muscle_groups": ["CHEST"],
    "equipment": "BARBELL",
    "movement_pattern": "HORIZONTAL_PRESS",
    "laterality": "BILATERAL",
    "custom": false,
    "volume_input_format": "WEIGHT",
    "instructions": ["Lie on the bench with your back and head resting..."],
    "video_url": "https://dh6o7n168ts9.cloudfront.net/exercise-videos-temp/BENCHPRESS_BARBELL.mp4"
  },
  "recent_sessions": [
    {"date": "May 17, 2026", "top_set": {"reps": 5, "weight": 225, "units": "lbs", "medal": null},
     "sets": [{"reps": 5, "weight": 225, "units": "lbs", "medal": null}, ...],
     "total_volume": 5625, "activity_id": "..."},
    ...
  ],
  "personal_records": [
    {"date": "May 17, 2026", "top_set": {"reps": 5, "weight": 225, "units": "lbs", "medal": "GOLD"},
     "sets": [...]},
    ...
  ]
}

Claude: Bench Press - Barbell (horizontal press, chest, bilateral). Your current PR
is 5 reps × 225 lbs (gold medal) set on May 17. Recent sessions have been at the
same weight — you're maintaining your top set. Volume per session has been around
5,000-6,000 lbs total tonnage.
```

---

## Project structure

Full file inventory at the time of this README. Run `find src/ -name "*.ts" | wc -l` for current count.

### Source files (115 files total, 17,928 lines including bundled catalogs + scripts)

```
src/
├── server.ts                                 42 lines
├── whoop/                                   (10 files, ~684 lines)
│   ├── client.ts                            112 lines  HTTP wrapper
│   ├── cognito.ts                           150 lines  Cognito auth flows
│   ├── token_manager.ts                      83 lines  Auto-refresh + persistence
│   ├── write_safety.ts                       30 lines  preview() + withPreview()
│   ├── build_lift_body.ts                    84 lines  Constructs lift_log body
│   ├── errors.ts                             47 lines  5 error classes
│   ├── json_out.ts                            5 lines  JSON.stringify wrapper
│   ├── constants.ts                           3 lines  BASE_URL, API_VERSION
│   ├── types.ts                              89 lines  Shared zod schemas
│   └── session_state.ts                      39 lines  Catalog-gate state
│
├── data/                                  (auto-generated, 4 files, ~8,257 lines)
│   ├── behaviors.ts                       308 entries
│   ├── exercises.ts                       372 entries
│   ├── sports.ts                          203 entries
│   └── endpoints.ts                       384 entries
│
├── schemas/                              (22 files, 800 lines)
│   ├── primitives.ts
│   ├── today.ts, profile.ts, calendar.ts
│   ├── recovery.ts, sleep.ts, strain.ts
│   ├── trend.ts, compare.ts
│   ├── stress.ts, sleep_need.ts
│   ├── live.ts
│   ├── workouts.ts
│   ├── strength.ts
│   ├── journal.ts
│   ├── womens_health.ts
│   ├── coach.ts, performance.ts
│   ├── smart_alarm.ts
│   ├── leaderboard.ts
│   ├── settings.ts
│   └── escape.ts
│
├── projections/                          (26 files, 1,521 lines)
│   ├── today.ts (composes home + sleep + state)
│   ├── profile.ts
│   ├── calendar.ts
│   ├── recovery.ts
│   ├── sleep.ts (DETAILS_GRAPHING_CARD walks)
│   ├── strain.ts
│   ├── trend.ts (metrics-as-array)
│   ├── stress.ts
│   ├── sleep_need.ts ("8h 23m" parsing)
│   ├── live_hr.ts, live_state.ts, live_stress.ts
│   ├── workouts.ts, workout.ts
│   ├── lift_prs.ts
│   ├── lift_exercise.ts
│   ├── lift_progression.ts
│   ├── lift_history.ts
│   ├── lift_library.ts
│   ├── journal.ts
│   ├── behavior_impact.ts
│   ├── cycle.ts
│   ├── performance_assessment.ts
│   ├── smart_alarm.ts (alarm_bounds composition)
│   ├── leaderboard.ts
│   └── hr_zones.ts
│
├── tools/                                 (48 files, 2,287 lines)
│   ├── register.ts (wires 47 tools)      118 lines
│   └── v2/                               (47 files, 2,169 lines)
│       └── (one file per tool, see The 47 tools section)
│
├── lib/                                  (4 files, ~400 lines)
│   ├── walk.ts (tree walkers, type coercers, extractSessions, findCardByTitle)
│   ├── dates.ts
│   ├── format.ts
│   └── stats.ts
│
└── scripts/
    └── cognito_bootstrap.ts          One-shot login. (Catalog-regenerators, live-API test runners, and probe scripts are archived in the separate whoop-testing repo — they need raw captures + dummy-account credentials and aren't shipped here.)
```

### Tests

```
tests/                                 11 test files, 127 passing
├── fixtures/                          23 captured API response JSON files
│   ├── activity_types.json            67 KB    (v2 sports/activity-types)
│   ├── behavior_summary.json          985 B
│   ├── bootstrap.json                 1.2 KB
│   ├── cardio_details.json            300 KB   strength workout
│   ├── cardio_details_nonstrength.json 1.1 MB  non-strength workout (largest)
│   ├── deep_dive_recovery.json        21 KB
│   ├── deep_dive_sleep.json           848 KB   (largest sleep BFF)
│   ├── deep_dive_strain.json          29 KB
│   ├── exercise_info.json             1.1 KB
│   ├── feature_education_state.json   16 KB
│   ├── home.json                      55 KB
│   ├── journal_behaviors.json         74 KB
│   ├── journal_behaviors_v3.json      122 KB
│   ├── journal_draft.json             821 B
│   ├── lift_exercise_history.json     12 KB
│   ├── lift_exercise_prs.json         7 KB
│   ├── lift_progression.json          11 KB
│   ├── lift_prs.json                  10 KB
│   ├── notification_settings.json
│   ├── overlay_all.json
│   ├── stress.json                    3 KB
│   ├── stress_bff.json
│   └── trend_hrv.json                 117 KB
│
├── projections/                       Projection unit tests
│   ├── round1.test.ts                 Snapshots + deep dives + trends
│   ├── round2.test.ts                 Workout + lift_progression + journal + lift_prs
│   └── round3.test.ts                 Lift_exercise + profile
│
├── data/
│   └── catalogs.test.ts               Catalog integrity (308/372/203/384)
├── whoop/
│   ├── client.test.ts                 HTTP wrapper tests
│   ├── parsers.test.ts                Pointing at lib/walk.js
│   └── types.test.ts                  zod schema parsing
└── lib/
    ├── dates.test.ts
    ├── format.test.ts
    └── stats.test.ts
```

### Docs

```
docs/
├── WHOOP_API_ENDPOINTS.md            Deep developer doc (5000+ lines)
├── discovery/
│   ├── whoop-api-reference.md        Original reverse-engineering summary
│   ├── api-brief.md                  Opus 4.7-generated brief
│   ├── behaviors-catalog.md          308 behaviors organized
│   ├── exercises-catalog.md          372 exercises organized
│   ├── request-body-reference.md     14 canonical write bodies
│   ├── behaviors-v2-raw.json         Raw catalog dump
│   ├── exercises-v2-raw.json         Raw catalog dump
│   ├── endpoints-dedup-419.txt       Deduped 419-op list
│   ├── flows.mitm                    Phase 1 raw mitm (122 MB)
│   ├── flows-phase8.mitm             Phase 8a raw mitm (29 MB)
│   ├── flows-phase8b.mitm            Phase 8b raw mitm (284 MB)
│   ├── v2-tool-test-report.md        Live test report (Brian's acct)
│   └── v2-tool-test-report-dummy.md  Live test report (dummy acct)
└── superpowers/
    ├── specs/                        Brainstormed design specs
    └── plans/                        Task-by-task implementation plans
```

---

## Development guide

### Adding a new tool

Say you want to add a `whoop_recovery_history` tool that returns the last N days of recovery scores in one call.

**1. Pick the source endpoint(s).** Browse `WHOOP_API_ENDPOINTS.md` for the relevant service. For recovery history, the right call is `whoop_trend` with `metric: "RECOVERY"` — but maybe you want a custom shape. Let's say you'll fetch N days of `/home-service/v1/deep-dive/recovery?date=` in parallel.

**2. Add the schema.** Create `src/schemas/recovery_history.ts`:

```ts
import { z } from "zod";

export const RecoveryHistoryOut = z.object({
  end_date: z.iso.date(),
  days: z.array(z.object({
    date: z.iso.date(),
    score: z.number().nullable(),
    state: z.enum(["GREEN", "YELLOW", "RED"]).nullable(),
    hrv_ms: z.number().nullable(),
    rhr_bpm: z.number().nullable(),
  })),
});
export type RecoveryHistoryOutT = z.infer<typeof RecoveryHistoryOut>;
```

**3. Add the projection.** Create `src/projections/recovery_history.ts`:

```ts
import type { RecoveryHistoryOutT } from "../schemas/recovery_history.js";
import { projectRecovery } from "./recovery.js";

interface ProjectInput {
  responses: { date: string; raw: unknown }[];
  end_date: string;
}

export function projectRecoveryHistory(input: ProjectInput): RecoveryHistoryOutT {
  return {
    end_date: input.end_date,
    days: input.responses.map(({ date, raw }) => {
      const r = projectRecovery(raw, date);
      return { date, score: r.score, state: r.state, hrv_ms: r.hrv.ms, rhr_bpm: r.rhr.bpm };
    }),
  };
}
```

Reusing `projectRecovery` keeps the day-shape consistent with `whoop_recovery`.

**4. Add the tool.** Create `src/tools/v2/recovery_history.ts`:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { RecoveryHistoryOut } from "../../schemas/recovery_history.js";
import { projectRecoveryHistory } from "../../projections/recovery_history.js";
import { WhoopProjectionError } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { todayIso } from "../../lib/dates.js";

export function registerRecoveryHistory(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_recovery_history",
    "Recovery score, HRV, RHR for the last N days. Cheaper than calling whoop_recovery N times.",
    {
      days: z.number().int().min(1).max(30).default(7),
      end_date: z.iso.date().optional(),
    },
    async ({ days, end_date }) => {
      const end = end_date ?? todayIso();
      const dates = Array.from({ length: days }, (_, i) => {
        const d = new Date(end);
        d.setDate(d.getDate() - i);
        return d.toISOString().slice(0, 10);
      });
      const responses = await Promise.all(
        dates.map(date => client.get("/home-service/v1/deep-dive/recovery", { date })
          .then(raw => ({ date, raw }))
          .catch(() => ({ date, raw: null }))
        )
      );
      const projected = projectRecoveryHistory({ responses, end_date: end });
      try {
        const out = RecoveryHistoryOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_recovery_history", e);
        throw e;
      }
    },
  );
}
```

**5. Wire it into `register.ts`.** Add the import + the call:

```ts
// At top
import { registerRecoveryHistory } from "./v2/recovery_history.js";

// In registerTools()
registerRecoveryHistory(server, client);
```

**6. Add a test.** Optional but recommended. Create `tests/projections/recovery_history.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRecoveryHistory } from "../../src/projections/recovery_history.js";
import { RecoveryHistoryOut } from "../../src/schemas/recovery_history.js";

const fixture = JSON.parse(readFileSync(resolve("tests/fixtures/deep_dive_recovery.json"), "utf8"));

describe("projectRecoveryHistory", () => {
  it("projects 3 days of same fixture", () => {
    const out = projectRecoveryHistory({
      responses: [
        { date: "2026-05-23", raw: fixture },
        { date: "2026-05-22", raw: fixture },
        { date: "2026-05-21", raw: fixture },
      ],
      end_date: "2026-05-23",
    });
    expect(() => RecoveryHistoryOut.parse(out)).not.toThrow();
    expect(out.days).toHaveLength(3);
    expect(out.days[0]?.score).toBe(78);
  });
});
```

**7. Build + run.**

```bash
npm run typecheck    # should be clean
npm test             # should pass
npm run build        # should output dist/
```

Restart Claude. The new tool is available.

### Fixing a broken projection

When Whoop changes a response shape, you'll see `WhoopProjectionError` in your Claude output. To fix:

**1. Capture the new raw response.** Use `whoop_raw` to hit the same endpoint and copy the output. Save it to `tests/fixtures/<endpoint>.json`.

**2. Inspect.** Look at the new response shape. Compare to the projection's assumptions.

```bash
# Quick scan of top-level keys
node -e "const j = JSON.parse(require('fs').readFileSync('tests/fixtures/x.json','utf8')); console.log(Object.keys(j));"

# Look for a specific section type
node -e "
const j = JSON.parse(require('fs').readFileSync('tests/fixtures/x.json','utf8'));
const types = new Set();
function walk(n) { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.type) types.add(n.type); Object.values(n).forEach(walk); } }
walk(j);
console.log(Array.from(types).sort());
"
```

**3. Update the projection.** Change the paths it walks. Test against the updated fixture.

**4. Update the schema if needed.** If Whoop added new fields, you may want to expose them — extend the zod schema and the projection's output.

**5. Verify.**

```bash
npm test -- tests/projections/<projection>.test.ts
```

### Conventions

**Schema files:** Export both `FooOut` (the zod schema, runtime value) and `FooOutT` (the inferred TypeScript type). Use the type for projection return annotations, use the schema for `.parse()`.

**Projection signatures:** `function projectFoo(raw: unknown, ...args): FooOutT`. Always take `unknown` as input and return a typed object. Never throw — return null/empty arrays for missing data and let zod parse catch it at the boundary.

**Tool descriptions:** First sentence is what the tool returns. Second sentence (optional) is when to use it vs other tools. Keep it under 200 chars — Claude reads this every conversation to pick tools.

**Tool input schemas:** Make required args required, give optional args sane defaults via `.default()`. Use `.describe()` on any arg whose meaning isn't obvious from the name.

**Write-tool input schemas:** Every write tool MUST have `confirm: z.boolean().default(false)`. The handler MUST branch on `confirm` and return a preview when false.

**Error handling:** Wrap `Schema.parse()` in try/catch and rethrow as `WhoopProjectionError("<tool_name>", e)`. Let other errors propagate naturally.

**Logging:** Don't write to stdout from tool handlers. The MCP transport uses stdout for protocol messages, so console.log() can corrupt the wire format. Use `console.error()` for diagnostic output (stderr is safe).

---

## Testing

### Run all tests

```bash
npm test
```

Output:

```
 Test Files  10 passed (10)
      Tests  116 passed (116)
```

### What's tested

| Layer | What | How |
|---|---|---|
| `lib/` | Pure functions (date math, formatting, stats) | Unit tests |
| `whoop/client` | HTTP wrapper, error classification, query/body shaping | `vi.stubGlobal("fetch", mock)` |
| `whoop/cognito` | Auth flows (covered indirectly through bootstrap script) | Manual + smoke |
| `whoop/token_manager` | Refresh logic, single-flight, persistence | Mock client |
| `schemas/*` | zod schemas parse captured fixtures | `Schema.parse(fixture)` |
| `projections/*` | Raw → flat correctness | Fixture-driven, asserts exact values |
| `tools/*` | Wiring of schema + projection + client | Mock client tests |
| `data/*` | Catalog integrity (counts + per-entry parse) | Asserts 308/372/203/384 |

### Running specific tests

```bash
# All projection tests
npm test -- tests/projections/

# One specific test file
npm test -- tests/projections/round1.test.ts

# Watch mode
npm run test:watch
```

### Live API testing

The prod repo ships unit-test coverage only (fixtures + projections). Live-API integration tests, the 309-variant parameter matrix, the per-endpoint probes, and the catalog-verification scripts all live in a separate **`whoop-testing`** archive — they need a dummy Whoop account, capture mitm fixtures, and aren't safe to expose to first-time users. If you want to run them, ask Brian.

Past results (snapshot from 2026-05-25):
- **309 variants** exercised across every tool. **300 OK + 0 fail + 9 expected errors.**
- **All 25 trend metrics** verified.
- **Every catalog (372 exercises / 308 behaviors / 203 sports)** matched live API responses 100%.
- **Every enum** (gender, menstruation, cervical_mucus, movement_pattern, muscle_groups, contraception_type, MCI interest) verified against live API by deliberate probe-then-reject.

### Captured fixtures

`tests/fixtures/*.json` contains 23 raw API response snapshots from real captures. Projection tests assert exact values:

```ts
it("extracts recovery score (78)", () => {
  expect(out.score).toBe(78);
});
it("extracts HRV current (42 ms)", () => {
  expect(out.hrv.ms).toBe(42);
});
```

If Whoop changes shape and you recapture, expect these assertions to need updating with the new values. Don't change them to make tests pass blindly — verify the new values match what Whoop's app shows.

---

## Error handling

### Errors the MCP throws

| Error | When | Recovery |
|---|---|---|
| `WhoopAuthExpiredError` | Access token rejected with 401 | TokenManager auto-refreshes on next call |
| `WhoopServerError` | Whoop returned 5xx | Transient — retry in 30s |
| `WhoopApiError` | Whoop returned 4xx (non-401) | Read the description to learn what went wrong |
| `WhoopProjectionError` | Projection emitted data that failed zod parse | Whoop changed shape — capture the new response, update projection |

### Errors Whoop returns

| Status | Body shape | Meaning |
|---|---|---|
| 400 | `{code, message, location}` | Validation. `message` is human-readable. `location` gives line/column. |
| 401 | varies | Token expired. MCP refreshes automatically. |
| 403 | varies | Permission denied (e.g. community you've left). |
| 404 | varies | Resource missing or feature not enabled for your account. |
| 409 | varies | Resource conflict (overlapping time ranges, duplicate writes). |
| 422 | varies (sometimes empty) | Body validation failed beyond shape — e.g. partial profile PUT. |
| 428 | varies | Precondition required (rare; `If-Match` missing). |
| 500 | varies | Server error. The behavior-impact endpoint has known 500s on stale UUIDs. |

### Common scenarios

**"WhoopAuthExpiredError" but I just refreshed."** Your refresh token has likely hit its ~30-day limit. Re-run `npm run cognito-bootstrap`.

**"WhoopApiError 422 on /profile-service/v1/profile."** You're trying a partial profile update. Send a near-complete body (most fields). See `whoop_profile_update` docs.

**"WhoopApiError 400 on /womens-health-service/..."** Your account doesn't have MCI configured. Run the survey via `whoop_raw` to `PUT /health-service/v1/hormonal-insights/settings/mci/survey`.

**"WhoopApiError 409 on /weightlifting-service/v2/weightlifting-workout/activity."** You're trying to log a workout in a time range that conflicts with an existing one. Use different start/end times.

**"WhoopProjectionError for whoop_X."** Capture the new response, update the projection.

---

## Token usage analysis

How many output tokens each tool returns, measured against Brian's account (populated) and dummy account (fresh).

### Per-tool output cost

| Tool | Brian's acct | Dummy acct | Notes |
|---|---|---|---|
| `whoop_today` | 136 | 120 | Composite of 3 endpoints, well-projected |
| `whoop_day` | 129 | 113 | Same |
| `whoop_profile` | 139 | 139 | Identity + privacy state |
| `whoop_calendar` | 8 | 8 | Empty days don't take much |
| `whoop_recovery` | 72 | 72 | Just the scores, baselines, contributors |
| `whoop_sleep` | 127 | 114 | Full stage breakdown |
| `whoop_strain` | 68 | 68 | Score + zones + steps + cal |
| `whoop_trend` | 3,073 | 128 | The big one — per-day points × 3 windows. Empty on fresh accts. |
| `whoop_compare` | 146 | 153 | Side-by-side metric comparison |
| `whoop_stress` | 37 | 37 | Stress timeline + current |
| `whoop_sleep_need` | 66 | 66 | Need breakdown |
| `whoop_live_hr` | 25 | 25 | Just current bpm + state |
| `whoop_live_state` | 47 | 47 | Activity state |
| `whoop_live_stress` | 25 | 25 | Just current level |
| `whoop_workouts` | 317 | 1 | List of recent workouts (empty on dummy) |
| `whoop_workout` | 122 | n/a | Single workout detail |
| `whoop_lift_prs` | 497 | 507 | All PRs |
| `whoop_lift_exercise` | 1,117 | 604 | Composite |
| `whoop_lift_progression` | 311 | 113 | Volume trend |
| `whoop_lift_history` | 1 | 1 | Empty on Brian (no recent strength) |
| `whoop_lift_library` | 333 | 333 | Templates list |
| `whoop_lift_catalog` | 273 | 273 | Local lookup, search "bench" |
| `whoop_journal` | 24 | 24 | Empty entry |
| `whoop_journal_catalog` | 232 | 232 | Lifestyle category × 5 |
| `whoop_behavior_impact` | 26 | n/a | Requires impact data |
| `whoop_cycle` | 51 (with MCI) | n/a | Needs contraception_type |
| `whoop_coach_ask` | ~150 | ~200 | Real response from Coach |
| `whoop_performance_assessment` | 68 | 67 | |
| `whoop_smart_alarm` | 143 | 96 | Schedules + preferences |
| `whoop_smart_alarm_set` | 10 | 10 | Receipt |
| `whoop_leaderboard` | 142 | 821 | Auto-discovers community |
| `whoop_hr_zones` | 63 | 63 | Zones + max HR |
| `whoop_hr_zones_set` | 8 | 8 | Receipt |
| `whoop_profile_update` | 41 | 71 | Receipt with fields_updated |
| `whoop_hidden_metric` | 14 | 14 | Toggle receipt |
| `whoop_activity_create` | 44 | 44 | Receipt with activity_id |
| `whoop_activity_delete` | 18 | 18 | Receipt with deleted_id |
| `whoop_lift_log` | 31 | 31 | Receipt |
| `whoop_lift_template_save` | 24 | 24 | Receipt |
| `whoop_lift_custom_exercise` | 26 | 26 | Receipt with new exercise_id |
| `whoop_journal_log` | 14 | 14 | Receipt |
| `whoop_journal_autopop` | 10 | 10 | Receipt |
| `whoop_cycle_log` | 9 | 9 | Receipt |
| `whoop_symptom_log` | 14 | 14 | Receipt |
| `whoop_raw` | varies | varies | Whatever endpoint you hit |
| `whoop_endpoints` | 200+ | 200+ | Filter results |

**Aggregate** for one call of every tool: ~8,620 tokens (Brian's account). Realistic session profiles:

- "How am I doing today?" → `whoop_today` + maybe `whoop_recovery`/`whoop_sleep` → **300-500 tokens**
- "Show my lifting progress" → `whoop_lift_prs` + `whoop_lift_exercise` for 1 exercise → **~1,600 tokens**
- "Compare this week to last week" → `whoop_compare` → **~150 tokens** (much cheaper than 2× whoop_trend)
- "Log my workout" → `whoop_lift_log` preview + `whoop_lift_log` confirm → **~100 tokens** total

### Input token cost

Tool definitions live in Claude's context for the duration of the session. The 47 tool definitions cost approximately **~7,000 tokens** at session start (descriptions + input schemas). This is a one-time cost per session.

### Reducing tokens

If you want a cheaper subset for a focused session:

- Comment out tool registrations in `src/tools/register.ts` and rebuild
- Or use `whoop_endpoints` + `whoop_raw` as a flexible escape hatch without registering the other 45 specific tools

---

## Privacy + security

### Where data lives

| Data | Location | Visible to Claude? |
|---|---|---|
| Whoop email | `.env` on your machine | Only if Claude reads `.env` (which it doesn't unless you tell it to) |
| Whoop password | `.env` on your machine | Same |
| Access token | `.env` + memory of the running MCP process | Same |
| Refresh token | `.env` + memory of the running MCP process | Same |
| Tool input args | Memory, sent to Whoop API | YES — Claude picks them |
| Tool output | Memory, sent to Claude as text | YES — Claude consumes them |

The MCP process is a Node child of your Claude client. Its environment is yours. Nothing leaves your machine except:
- Outbound HTTPS to `api.prod.whoop.com`
- The structured JSON returned by each tool back to Claude

### What Claude can't see

- The contents of `.env`
- Your password (it's only sent to Whoop's auth endpoint, once)
- Other MCP servers' data (each MCP is isolated)
- Your file system, unless you've also wired in the filesystem MCP

### What Claude can see

- The data returned by each tool you let it call
- The tool descriptions you've registered (so it can pick tools)

### Write safety

Every write tool defaults to `confirm: false`. The preview shape includes what would be sent. You see the preview in chat before any mutation happens.

If you want even tighter control, you can:
- Remove specific write tools by commenting out their registration in `src/tools/register.ts`
- Add a global "always require human approval" gate (one of Claude Desktop's settings)

### Open source

The MCP is open source. Every line of code that touches your Whoop data is auditable. No telemetry. No analytics. No external services besides Whoop itself.

---

## Troubleshooting

**"AUTH FAIL: Cognito InitiateAuth failed (400)"**
> Wrong email or password. Double-check `.env`.

**"AUTH FAIL: Cognito MFA challenge missing Session token"**
> The InitiateAuth response was malformed (unusual). Re-run `npm run cognito-bootstrap` — Cognito occasionally drops sessions.

**"MFA verification did not return tokens"**
> You entered the wrong SMS code (or it timed out). Codes expire after ~3 minutes.

**"WhoopAuthExpiredError" after every call**
> Your refresh token has expired (>30 days since last bootstrap). For a **local install**, re-run `npm run cognito-bootstrap`. For a **deployed install** (Fly etc.), run `npm run rebootstrap` from your Mac — it re-bootstraps locally AND pushes the new tokens to your deployed app's secrets in one step. Either way you'll get a fresh SMS code on your phone that you type in the terminal.

**"WhoopServerError: 502" / "503" / "504"**
> Whoop's servers are having issues. Retry in 30 seconds.

**Claude says it doesn't see any whoop tools**
> Check `claude_desktop_config.json` paths are absolute. Restart Claude Desktop fully (quit, then reopen).
> Check the MCP server runs without errors: `npm run dev` — it should start silently and wait on stdin.

**"WhoopApiError: 422 on /profile-service/v1/profile"**
> Your `whoop_profile_update` body is too partial. Send most fields (gender from {MALE,FEMALE,NON_BINARY} only, birthday as YYYY-MM-DD or ISO datetime, country ISO-2). If `country=US`, also send `state` — Whoop returns 400 `"AdminDivision (state) must be set for US"` otherwise.

**"Whoop API error 409 on /weightlifting-service/v2/weightlifting-workout/activity"**
> Time window conflicts with an existing workout. Use a different range.

**"WhoopProjectionError for whoop_X"**
> Whoop changed a response shape. Capture the new response (e.g. via `whoop_raw`), inspect, update the projection.

**Tests fail after `git pull`**
> Pull may have updated captured fixtures. Run `npm test` again to see what changed. If projections need updating, that's the work.

**`npm run build` fails with "Top-level await is currently not supported with the 'cjs' output format"**
> You're using an old Node. Upgrade to Node 24+.

**"Error: ENOENT: no such file or directory, open '.env'"**
> Create `.env` at the repo root (or wherever `dist/server.js` is being run from — the MCP loads `.env` relative to the entry).

**"Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'"**
> Run `npm install`.

**"AbortError: This operation was aborted"**
> A request to Whoop's API took longer than 30s. Either Whoop is slow or your network is slow. Retry.

---

## Comparison to alternatives

| Approach | Pros | Cons |
|---|---|---|
| **This MCP** | Full iOS API surface (47 total: 31 reads + 14 writes + 2 escape hatches), writes supported, structured outputs, auto-refresh, write-safety, session-scoped catalog gate | **Violates Whoop's ToS Section 4(iii) + 4(v); Whoop can suspend or terminate your account.** Reverse-engineered (Whoop could break it at any time); local install required |
| Whoop's public OAuth API | Official, supported, 6 webhook events, scoped permissions | Only 13 endpoints; read-only; no journal/strength/stress/coach/smart-alarm/trends/hypnogram; numeric `sport_id` removed 2025-09-01; 429s exist |
| HealthKit-based scraper | Bypass Whoop entirely; uses Apple's data sync | Loses Whoop-specific data (recovery score, journal, coach); requires iOS device involvement |
| Direct mitmproxy capture | See everything | Manual, not programmable, doesn't scale |
| Whoop iOS app + screenshots → Claude | Works without code | Painful, slow, no writes |

This MCP is the only option for **programmatic write access** to your Whoop data right now.

---

## Roadmap

In rough priority order:

- **Better behavior_impact handling.** Currently returns 500 on fresh accounts. Needs fallback to summary-card endpoint.
- **Sleep hypnogram extraction.** The projection currently returns an empty array — the captured fixture's hypnogram structure isn't fully mapped yet. PRs welcome.
- **Live HR endpoint refinement.** Speculative tile names; could improve with another capture session.
- **Avatar PUT tool.** Currently requires raw PNG bytes; would need a base64 / file-path input wrapper.
- **Family plan management tools.** Read membership status; not currently wrapped.
- **Subscription cancel/pause.** Currently can only `resume`, not `cancel`.
- **Account deletion flow.** Whoop's iOS app has it; we don't.
- **Apple Watch / Garmin specific endpoints.** Not yet captured (Brian doesn't use them).
- **Workout sharing to Strava trigger.** Settings GET captured but not the trigger POST.
- **Data export trigger.** Read endpoint captured; trigger POST not.
- **Webhook subscription.** Whoop has push notifications for data events; not currently wrapped.

Phase 9 of discovery (more mitm captures of niche flows) would unlock most of these. Phase 10 (catalog of internal admin endpoints) is theoretical.

---

## FAQ

**Q: Is this against Whoop's Terms of Service?**
A: **Yes.** Specifically, Section 4 of [Whoop's Terms of Use](https://www.whoop.com/us/en/whoop-terms-of-use/) prohibits reverse engineering the Services or any embedded Software (4(v)), and prohibits web scraping/harvesting/extraction from Whoop Services — *"even if the Account owner gives permission"* (4(iii)). This MCP does both: the iOS API surface was discovered via mitmproxy (reverse engineering the embedded Software's network layer), and every tool call extracts structured data from a non-public surface. It's not illegal — Whoop's API isn't protected by anti-circumvention law in the way DRM is — but it is not allowed by the contract you agreed to when you accepted the ToS.

**Q: Will Whoop ban my account for using this?**
A: They could. Their ToS reserves the right to suspend or terminate access "at any time" if they determine you've materially breached the agreement (Section 21). In practice: as of this writing, the project's authors have used the MCP heavily for weeks with no account flags, and the traffic patterns look very similar to normal app usage (single-digit requests per second, real iOS app headers, real Cognito-authenticated bearer tokens). That said — **there is no guarantee**. Whoop could change their detection at any time, or notice this repo and act. If you can't afford to lose your Whoop account (or get re-charged a setup fee, or lose your data), don't use this. The trade-off you're making: ~5-10x more API surface vs the supported OAuth API, in exchange for sitting in a category Whoop has explicitly said is not permitted.

**Q: What's the worst case if Whoop notices?**
A: Per their published policy, possible outcomes include: (1) suspension of API access (you'd still own the device, you'd just lose data sync), (2) account termination with no refund of remaining Membership Fees (Section 6), (3) being barred from future Memberships (Section 21.4: "you shall not attempt to re-register"), or (4) legal action — extremely unlikely for personal use, but technically available to them under the ToS. Of these, (1) and (2) are realistic; (3) is plausible; (4) basically never happens for individual users.

**Q: Why not use Whoop's public OAuth API?**
A: It's 13 endpoints, all read-only, no journal, no strength, no stress, no coach, no smart alarm, no trends beyond a single recovery score per day. Whoop also pulled numeric `sport_id` past 2025-09-01 (now `sport_name` strings only). See the comparison table in "Why this exists" for the full diff. If you only need recovery score + sleep stage totals + workout list, the OAuth API is the right answer.

**Q: Will this work with the Whoop 4.0 vs 5.0 strap?**
A: Yes — the API doesn't care which strap you have. It cares about your account.

**Q: What about Whoop 6.0?**
A: When it launches and the iOS app updates, the api version may bump from 7 to 8. The MCP's `constants.ts` may need an update. Worst case, projections break and you fix them.

**Q: Can I run this on a server / cloud / always-on?**
A: Sure. The MCP doesn't care where it runs. Just make sure your `.env` survives restarts.

**Q: Can I share this MCP with my friends?**
A: Each user needs their own `.env` with their own Whoop credentials. Don't share tokens.

**Q: Is there an HTTP transport instead of stdio?**
A: Not yet. The MCP SDK supports SSE but we haven't wired it. PR welcome.

**Q: Does this support Claude's Computer Use API?**
A: It's MCP-compatible — anything that speaks MCP can talk to it.

**Q: Why TypeScript instead of Python?**
A: The MCP SDK is most mature in TypeScript. Also Whoop's API responses are heavily nested — zod is genuinely the best validation library for that shape work.

**Q: Why Node 24 specifically?**
A: Uses `import.meta.dirname` (added in 20.11), modern `fetch`, native ESM, `AbortController`. Node 18 might work; 16 won't.

**Q: How long did this take?**
A: ~3 weeks of evening/weekend work for v1, plus another week to rewrite as v2 with proper projections and the write-safety harness.

**Q: Will you maintain this?**
A: Best-effort. PRs welcome.

---

## Going deeper

In this repo:

- **[`WHOOP_API_ENDPOINTS.md`](WHOOP_API_ENDPOINTS.md)** — 5,900-line full reverse-engineering writeup. Methodology, every microservice, every endpoint, every body shape, every enum, every status code pattern, auth flows, capture sessions, the dedup pipeline. The single source of truth for API surface knowledge.
- **[`CHANGELOG.md`](CHANGELOG.md)** — release history.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — orientation for adding tools or fixing projections.
- **[`SECURITY.md`](SECURITY.md)** — security policy, threat model, credential hygiene.

Not shipped with this package (lives in a sibling `whoop-testing` archive — ask Brian if you need them):

- Raw catalog dumps (`behaviors-v2-raw.json`, `exercises-v2-raw.json`, `sport_ids-raw.json`, `endpoints-dedup-419.txt`) + the `build_catalogs.ts` regenerator — withheld because the captures contain personal account data
- Phase 1/8a/8b mitmproxy captures (~450 MB total)
- The 309-variant live-API test matrix + reports
- All probe scripts (`probe_auth.ts`, `probe_journal.ts`, etc.)
- The v1 codebase (a thinner raw-passthrough version, pre-projection-pattern)
- Brainstormed design specs + implementation plans from the v2 rewrite

---

## Disclaimers

- **This violates Whoop's Terms of Service.** Specifically Section 4(v) (reverse engineering the embedded Software) and Section 4(iii) (web scraping / data extraction, even with the account owner's permission). It is not illegal — but it is not allowed. See the [⚠️ banner at the top of this README](#-this-violates-whoops-terms-of-service) and the [FAQ](#faq) for the full breakdown of possible disciplinary action.
- **Use at your own discretion.** If Whoop terminates your account, suspends your data sync, or bars you from re-registering, that's the risk you accept by using this. Nobody affiliated with this project is going to pay your reactivation fee or recover your historical data.
- **This is NOT affiliated with Whoop.** "WHOOP" is a trademark of WHOOP, Inc. This is a community-built tool that interacts with surfaces Whoop has not published.
- **The API surface is reverse-engineered.** Whoop can change response shapes at any time without notice. The zod schemas surface drift as `WhoopProjectionError` instead of silent corruption — see [Fixing a broken projection](#fixing-a-broken-projection) for the recovery loop.
- **No warranty.** If you 422 something and lose data, that's on you.
- **Respect Whoop's rate limits.** We've not hit any in normal usage. Don't be the person who triggers a backend alert that gets every user of this MCP banned.
- **Don't share tokens.** Your `.env` is yours. Don't commit it, don't share it, don't paste it into chats outside this MCP.
- **Don't share user data.** Your Whoop data is yours. If you write integrations on top of this MCP, respect your users' privacy and their separate consent (which they also haven't given Whoop a chance to revoke).

---

## Acknowledgments

- **WHOOP** for building a fitness platform worth reverse-engineering
- **Anthropic** for [MCP](https://modelcontextprotocol.io) and [Claude](https://claude.ai)
- **mitmproxy** for being the tool that made discovery possible
- **The TypeScript + zod community** for making strict validation pleasant
- The various API consumers + bloggers who documented bits of Whoop's private API over the years

This is open source under the terms in `LICENSE`. Contributions welcome.
