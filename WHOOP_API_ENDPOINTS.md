# Whoop iOS API — Deep Endpoint Research

> Full reverse-engineering writeup of Whoop's private iOS API surface. 47 microservices, 384 deduped unique operations (filename `endpoints-dedup-419.txt` retains the pre-final-dedup count), ~85 KB of captured request bodies, ~6 MB of captured response payloads. Compiled from three mitmproxy capture sessions across two accounts.

> ## ⚠️ Compliance notice
>
> Everything documented below was obtained by **reverse engineering the network traffic** between the Whoop iOS app and `api.prod.whoop.com`. This is explicitly prohibited by [Whoop's Terms of Use](https://www.whoop.com/us/en/whoop-terms-of-use/) Section 4(v) (reverse engineering the Services or any embedded Software) and Section 4(iii) (web scraping / harvesting / data extraction, *even if the Account owner gives permission*). It is not illegal — but it is not permitted by the user agreement.
>
> This document exists because the research happened, and full documentation is more responsible than partial documentation that hides the methodology. It is *not* an endorsement that you should run mitm captures against your own account. If you do — Whoop reserves the right to suspend your access, terminate your Membership, or bar future re-registration (ToS Sections 4(vii), 21). Use this at your own discretion.

**This document is for developers**. If you want to understand what the MCP does, read [`README.md`](README.md). If you want to know how Whoop's private API actually works at the wire level — what bytes go in, what bytes come out, what enums exist, what status codes mean what, how auth was reverse-engineered — read this.

The whoop-api-reference.md companion file is the *summary* of this research. This is the *primary source*. Everything in this document was observed in actual captured network traffic.

---

## Table of contents

1. [Methodology — How we discovered all of this](#methodology)
2. [Authentication deep dive](#authentication)
3. [Cross-cutting patterns](#cross-cutting-patterns)
4. [Per-service endpoint reference](#per-service-endpoint-reference)
   1. [achievements-service](#achievements-service)
   2. [activities-service](#activities-service)
   3. [advanced-labs-service](#advanced-labs-service)
   4. [ai-conversation-bff + ai-conversation-service](#ai-conversation-bff--ai-conversation-service)
   5. [app-notifications-service](#app-notifications-service)
   6. [auth-service](#auth-service)
   7. [autopop-service](#autopop-service)
   8. [behavior-impact-service](#behavior-impact-service)
   9. [candidate-service](#candidate-service)
   10. [coaching-service](#coaching-service)
   11. [commerce-service](#commerce-service)
   12. [community-service](#community-service)
   13. [context-hub-bff](#context-hub-bff)
   14. [core-details-bff](#core-details-bff)
   15. [device-config](#device-config)
   16. [enterprise-service](#enterprise-service)
   17. [entitlement-service](#entitlement-service)
   18. [followers-service](#followers-service)
   19. [growth-content-service](#growth-content-service)
   20. [health-service](#health-service)
   21. [health-tab-bff](#health-tab-bff)
   22. [home-service](#home-service)
   23. [hr-zones-service](#hr-zones-service)
   24. [integrations-bff](#integrations-bff)
   25. [journal-service](#journal-service)
   26. [member-data-export-service](#member-data-export-service)
   27. [membership + membership-service](#membership--membership-service)
   28. [metrics-service](#metrics-service)
   29. [notification-service](#notification-service)
   30. [onboarding-service](#onboarding-service)
   31. [privacy-service](#privacy-service)
   32. [profile-service](#profile-service)
   33. [progression-service](#progression-service)
   34. [research-service](#research-service)
   35. [sleep-service](#sleep-service)
   36. [smart-alarm-bff + smart-alarm-service](#smart-alarm-bff--smart-alarm-service)
   37. [social-service](#social-service)
   38. [strap-location-service](#strap-location-service)
   39. [streaks-service](#streaks-service)
   40. [users-service](#users-service)
   41. [vow-service](#vow-service)
   42. [weightlifting-service](#weightlifting-service)
   43. [widget-service](#widget-service)
   44. [womens-health-service](#womens-health-service)
5. [Enum reference](#enum-reference)
6. [Templated path glossary](#templated-path-glossary)
7. [Response shape patterns](#response-shape-patterns)
8. [Status code taxonomy](#status-code-taxonomy)
9. [Token cost analysis per endpoint](#token-cost-analysis)
10. [Internal vocabulary glossary](#internal-vocabulary-glossary)
11. [Appendix A: Operation count by service](#appendix-a-operation-count-by-service)
12. [Appendix B: Bytes-per-endpoint table](#appendix-b-bytes-per-endpoint-table)
13. [Appendix C: Endpoints not yet wrapped by the MCP](#appendix-c-endpoints-not-yet-wrapped)

---

## Methodology

### The problem

Whoop has a public OAuth-based developer API at [developer.whoop.com](https://developer.whoop.com). It exposes **exactly 13 endpoints** under 6 read-only scopes, all paginated where applicable at ≤25 items per page with cursor `nextToken`. The full list (verified live against [developer.whoop.com/api](https://developer.whoop.com/api/) on 2026-05-25):

| Method | Path | Scope | Returns |
|---|---|---|---|
| GET | `/v2/user/profile/basic` | `read:profile` | `{user_id, email, first_name, last_name}` |
| GET | `/v2/user/measurement/body` | `read:body_measurement` | `{height_meter, weight_kilogram, max_heart_rate}` |
| DELETE | `/v2/user/access` | (auth only) | 204 — revokes the OAuth grant |
| GET | `/v2/cycle` | `read:cycles` | Paginated cycle list |
| GET | `/v2/cycle/{cycleId}` | `read:cycles` | `{id, user_id, created_at, updated_at, start, end, timezone_offset, score_state, score:{strain, kilojoule, average_heart_rate, max_heart_rate}}` |
| GET | `/v2/cycle/{cycleId}/sleep` | `read:cycles` | Sleep activity for a given cycle |
| GET | `/v2/cycle/{cycleId}/recovery` | `read:recovery` | Recovery for a given cycle |
| GET | `/v2/recovery` | `read:recovery` | Paginated recovery list; each entry has `{cycle_id, sleep_id, user_id, created_at, updated_at, score_state, score:{recovery_score, resting_heart_rate, hrv_rmssd_milli, spo2_percentage, skin_temp_celsius, user_calibrating}}` |
| GET | `/v2/activity/sleep` | `read:sleep` | Paginated sleep activities |
| GET | `/v2/activity/sleep/{sleepId}` | `read:sleep` | Full sleep detail (see below) |
| GET | `/v2/activity/workout` | `read:workout` | Paginated workouts |
| GET | `/v2/activity/workout/{workoutId}` | `read:workout` | Full workout detail (see below) |
| GET | `/v1/activity-mapping/{activityV1Id}` | (none) | Maps legacy `long` v1 IDs → v2 UUIDs |

Sleep detail score object: `{stage_summary:{total_in_bed_time_milli, total_awake_time_milli, total_no_data_time_milli, total_light_sleep_time_milli, total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli, sleep_cycle_count, disturbance_count}, sleep_needed:{baseline_milli, need_from_sleep_debt_milli, need_from_recent_strain_milli, need_from_recent_nap_milli}, respiratory_rate, sleep_performance_percentage, sleep_consistency_percentage, sleep_efficiency_percentage}`. The OAuth API gives stage **totals** in milliseconds but **not** the per-minute hypnogram.

Workout detail score object: `{strain, average_heart_rate, max_heart_rate, kilojoule, percent_recorded, distance_meter, altitude_gain_meter, altitude_change_meter, zone_duration}`. Workouts carry `sport_name` (string). Numeric `sport_id` was removed on **2025-09-01**; the v1 `long` ID (`v1_id`) was also removed on that date. Anything referencing those fields in legacy code now sees them as missing.

**6 webhook events (v2 only — v1 webhooks were removed):** `recovery.{updated,deleted}`, `workout.{updated,deleted}`, `sleep.{updated,deleted}`. Payload: `{user_id, id, type, trace_id}` where `id` is the UUID of the affected resource (sleep UUID for recovery webhooks — recovery in v2 keys off sleep, not cycle).

**Auth:** OAuth2 with auth URL `https://api.prod.whoop.com/oauth/oauth2/auth` and token URL `https://api.prod.whoop.com/oauth/oauth2/token`. Rate-limited (429 responses occur; Whoop does not publish a threshold).

The iOS app, in contrast, shows much more: strength workouts with set-by-set detail, the 308-behavior Journal with impact correlations, stress monitor timelines, smart alarm CRUD, hidden metrics, stealth mode, body composition deep-dives, Whoop Coach AI chat, advanced labs (bloodwork), hormonal insights, women's-health tracking, community leaderboards, achievement progressions, and a few dozen more surfaces — all the things this MCP wraps.

To wrap the rich surface, we needed to know:

1. **What endpoints does the iOS app hit?** No public list exists.
2. **What auth does it use?** The public API is OAuth2 (auth URL `https://api.prod.whoop.com/oauth/oauth2/auth`, token URL `https://api.prod.whoop.com/oauth/oauth2/token`, 6 read-only scopes). The iOS app uses AWS Cognito Identity Provider via Whoop's own `/auth-service/v3/whoop/` proxy. Same base host, completely different auth surface and token semantics.
3. **What does each endpoint expect as input?** Request body shapes are entirely undocumented.
4. **What does each endpoint return?** Response shapes vary wildly across the BFF (Backend-for-Frontend) surfaces.
5. **What are the enum values?** Tools that write data need to know exactly which strings the server accepts.
6. **What error codes mean what?** A 400 from `/profile-service/v1/profile` could mean anything until you see the patterns.

### The tools

**mitmproxy** running on a Mac, with the iPhone configured to route its Wi-Fi traffic through the Mac's IP on port 8080. mitmproxy's CA cert installed and trusted on the iPhone (Settings → General → About → Certificate Trust Settings → Enable Full Trust for mitmproxy).

```bash
mitmproxy --listen-port 8080 --set save_stream_file=flows.mitm
```

iPhone Wi-Fi proxy:
```
Server: <Mac's local IP>
Port: 8080
```

### Why this worked at all

**Whoop's iOS app does not implement SSL certificate pinning.** This was the single most important fact in the whole project. Most production iOS apps pin their CA cert, which means even if you install your own root CA on the device, the app refuses to talk to a proxy that doesn't present the pinned cert. Whoop doesn't pin. So once mitmproxy's CA was trusted, the iPhone happily routed every Whoop API call through the proxy and let us see the cleartext HTTPS contents on the Mac side.

This was verified early in Phase 2 by tapping through the app: if pinning had been enabled, the app would have shown an error or refused to load data when the proxy was active. It loaded everything normally. Confirmed.

### The three capture sessions

> The raw `.mitm` files captured below are **not shipped with this package** — they contain personal account data. They live in a separate archive. The summaries here describe what each capture covered.

**Phase 1 (2026-05-23, ~2 hours).** Primary account. Recorded a long read-heavy session: opening every tab in the app, scrolling through trends, opening Strength Trainer history, reading the Journal, asking Whoop Coach a question, looking at communities, browsing the calendar. Goal: get the read surface mapped. ~122 MB capture.

**Phase 8a (2026-05-24, ~14 minutes).** A separate test account set up specifically for write testing. Captured the new-user onboarding flow end-to-end — strap pairing, account creation, signup with a stripe token, MFA setup, the "what to expect" walkthrough, initial entitlement provisioning. Wi-Fi dropped silently after ~14 minutes; iOS didn't reapply the proxy on reconnect, so we lost the rest of that session. ~29 MB capture.

**Phase 8b (2026-05-24, ~35 minutes).** Same test account, after fixing the proxy + adding a heartbeat monitor that watches for >60s gaps in capture and warns. Exercised every write surface we knew about: created and deleted activities, logged Strength Trainer workouts with custom exercises, saved and edited templates, logged a journal entry with 47 behaviors, ran Smart Alarm CRUD, set HR zones, edited the profile (with a deliberately weird state/country combo to trigger a 400), toggled hidden metrics, ran the MCI women's-health survey, blocked and unblocked notification namespaces. ~284 MB capture.

### The dedup pipeline

Raw mitm captures contain everything — including duplicate operations, telemetry uploads (`/metrics-service/v1/metrics` fires hundreds of times per session), and noise like feature-flag polls. To get a clean per-operation view, we ran `/tmp/dump_combined.py` over all three captures:

```python
SOURCES = [
    ("flows.mitm", "phase1"),
    ("flows-phase8.mitm", "phase8a"),
    ("flows-phase8b.mitm", "phase8b"),
]

SKIP = (
    "/mobile-metric-service/", "/log-service/", "/gps-service/",
    "/firmware-service/", "/pip-metrics-service/",
    "/notification-service/v0/push/",
    "/feature-flags/flags/", "/experiment-service/",
    "/status-service/", "/configuration/v1/services/mobile",
    "/language-service/", "/tombstone-service/",
)
```

The skip list excludes pure telemetry endpoints that don't represent real product surfaces. Everything else is parsed into:

```
(method, templated_path, body_signature, status_code) → entry
```

Where `body_signature` is the **shape of the request body** — sorted top-level keys for JSON bodies, `array[N]` for arrays, `binary` for protobuf, `empty` for no body. This dedup key separates "the same operation called twice with the same body shape" (deduped) from "the same path called with structurally different bodies" (kept as separate entries — important for endpoints like Cognito's auth-service that multiplex on body shape).

Path templating collapsed concrete IDs into placeholders:

```python
p = re.sub(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", "{uuid}", p)
p = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "{date}", p)
p = re.sub(r"/\d{6,}", "/{id}", p)
p = re.sub(r"/exercise/[A-Z][A-Z0-9]*_[A-Z0-9_]+", "/exercise/{exercise_id}", p)
p = re.sub(r"/trends/[A-Z][A-Z0-9_]+", "/trends/{metric}", p)
p = re.sub(r"/educations/[A-Z][A-Z0-9_]+", "/educations/{education_name}", p)
```

After dedup: **419 unique operations across 47 microservices**, further collapsed to **384 final-deduped paths** once we merged variants that shared identical body shapes but differed only in cosmetic ways. The bundled `src/data/endpoints.ts` contains the 384 final-deduped paths; the file kept the `endpoints-dedup-419.txt` filename to preserve traceability to the per-chunk analysis below.

The full deduped dump lives at `/tmp/whoop_combined/all.txt` (1,580 lines) and is split into 12 chunks of ~100 ops each for parallel analysis. Each entry looks like:

```
#NUM [src] METHOD STATUS templated_path
  REQ (body_signature): <body text, truncated at 6KB>
  RESP (size_bytes): keys=[top-level response keys]
```

### The agent-based analysis pass

Mapping 419 operations into a structured per-service reference, while extracting enums and writing semantic notes, is the kind of task that takes a human days but a battery of LLM agents about 90 minutes. We dispatched 12 parallel Claude Sonnet 4.6 agents to chunk_01.txt through chunk_12.txt, each tasked with:

- For each operation in the chunk, write a structured entry with method, path, status codes seen, request body shape, response key listing, semantic note about what it does.
- Identify any enum values from request bodies or status code patterns.
- Flag operations that look like telemetry, deprecated paths, or one-off bugs (e.g. the lone 428 on `/membership?useReplica=true`).

The Sonnet outputs were too shallow. We then ran a **single Opus 4.7 agent** over the entire 1,580-line `all.txt` with explicit instructions to "read every single request" and produce an exhaustive brief. That agent wrote `api-brief.md` (1,252 lines / 87 KB — archived separately along with the raw captures), which became the spine of this document.

### The captured response fixtures

For 16 of the highest-value endpoints, we saved the full raw response JSON into `tests/fixtures/` so projections could be developed and tested without hitting the live API:

```
behavior_summary.json          985 bytes
bootstrap.json               1,209 bytes
cardio_details.json        300,123 bytes
deep_dive_recovery.json     21,001 bytes
deep_dive_sleep.json       848,428 bytes  <-- the biggest captured single response
deep_dive_strain.json       28,706 bytes
exercise_info.json           1,071 bytes
home.json                   54,751 bytes
journal_behaviors.json      73,571 bytes
journal_draft.json             821 bytes
lift_exercise_history.json  11,590 bytes
lift_exercise_prs.json       6,964 bytes
lift_progression.json       11,413 bytes
lift_prs.json               10,463 bytes
stress.json                  2,820 bytes
trend_hrv.json             116,971 bytes
```

These fixtures are committed to git and the projection test suite (`tests/projections/round1.test.ts`, `round2.test.ts`, `round3.test.ts`) asserts exact field values against them. If Whoop changes a response shape, tests fail loudly.

### Caveats

- **Single-account observation.** Most endpoints were exercised under exactly one set of user state. We don't know how endpoints behave on accounts with different feature flags (advanced labs purchased, family plan member, enterprise team membership, premium tier vs. base tier).
- **Time-of-day matters.** The Stress endpoint behavior we observed was during normal business hours. Whoop's batch jobs run at specific times (recovery is computed shortly after wake), and the responses can differ during those windows.
- **The strap state matters.** Several endpoints behave differently when the strap is actively recording vs. idle. Phase 1 was an idle-strap session; Phase 8b had the strap actively connected.
- **iOS app version 7.0.0 (api version 7).** All requests pin `apiVersion=7` as a query param. Whoop has been incrementing this every ~6 months. Future captures will likely show v8+ endpoints with different shapes for the same product surfaces.

---

## Authentication

Whoop's iOS app authenticates via **AWS Cognito**, but it routes all Cognito calls through Whoop's own backend at `api.prod.whoop.com/auth-service/v3/whoop/`. The proxy exists for two reasons:

1. **The mobile app doesn't ship with the Cognito client secret.** Cognito user pools that require SECRET_HASH (most production setups) can't be called directly from a mobile app without leaking the client secret in the IPA bundle. Routing through a backend proxy lets the secret stay server-side.
2. **CloudFlare WAF in front of api.prod.whoop.com applies the same rate-limit and abuse protection to auth calls as to data calls.** Direct Cognito traffic would bypass that.

### The proxy endpoint

```
POST https://api.prod.whoop.com/auth-service/v3/whoop/
```

Despite living at a Whoop-branded URL, the wire protocol is the standard AWS Cognito `application/x-amz-json-1.1` envelope:

```
content-type: application/x-amz-json-1.1
x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth
user-agent: aws-sdk-swift/1.5.86 ua/2.1 api/cognito_identity_provider#1.5.86 os/ios#26.3.1 lang/swift#5.10 m/D,N,Z,b
amz-sdk-invocation-id: <UUID>
amz-sdk-request: attempt=1; max=1
```

The proxy fills in the `ClientId` + computes the `SECRET_HASH` server-side before forwarding to `cognito-idp.us-west-2.amazonaws.com`. So our request body sends `"ClientId":""` (empty string) — the proxy substitutes the real value.

The User-Pool ID was leaked through one of the bootstrap script's console outputs and inferred from URL patterns: `us-west-2_rYv1jhSC3`. We never need it directly — the proxy handles it.

### Flow 1: USER_PASSWORD_AUTH (cold login)

```http
POST /auth-service/v3/whoop/ HTTP/1.1
content-type: application/x-amz-json-1.1
x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth

{
  "AuthFlow": "USER_PASSWORD_AUTH",
  "AuthParameters": {
    "USERNAME": "you@example.com",
    "PASSWORD": "your-password"
  },
  "ClientId": ""
}
```

Response (status 200, ~1768 B if MFA required, ~4570 B if not):

```json
{
  "ChallengeName": "SMS_MFA",
  "Session": "<opaque base64 ~300 chars>",
  "ChallengeParameters": {
    "CODE_DELIVERY_DELIVERY_MEDIUM": "SMS",
    "CODE_DELIVERY_DESTINATION": "+1***-***-1234",
    "USER_ID_FOR_SRP": "you@example.com"
  },
  "AuthenticationResult": null,
  "AvailableChallenges": ["SMS_MFA"]
}
```

If the account has no MFA, `ChallengeName` is null and `AuthenticationResult` is populated directly:

```json
{
  "AuthenticationResult": {
    "AccessToken": "eyJraWQiOi...",
    "RefreshToken": "eyJjdHkiOi...",
    "IdToken": "eyJraWQiOi...",
    "ExpiresIn": 86400,
    "TokenType": "Bearer"
  }
}
```

**Important field shapes:**
- `AccessToken`: standard JWT, ~1100 chars. `exp` claim is 24 hours from issue.
- `IdToken`: also a JWT, ~1500 chars. Contains user attributes (sub, email, email_verified).
- `RefreshToken`: NOT a JWT — it's a JWE (JSON Web Encryption) blob, ~2000 chars. Algorithm: `A256GCM` + `RSA-OAEP`. Whoop's Cognito uses encrypted refresh tokens; we can't decode them, only present them back to Cognito for renewal.
- `ExpiresIn`: integer seconds the access token is valid (always 86400 = 24h).
- `TokenType`: always `"Bearer"`.

### Flow 2: SMS_MFA challenge response

If `ChallengeName: "SMS_MFA"` came back, the iOS app prompts the user for the 6-digit SMS code and sends:

```http
POST /auth-service/v3/whoop/ HTTP/1.1
content-type: application/x-amz-json-1.1
x-amz-target: AWSCognitoIdentityProviderService.RespondToAuthChallenge

{
  "ChallengeName": "SMS_MFA",
  "ChallengeResponses": {
    "USERNAME": "you@example.com",
    "SMS_MFA_CODE": "123456"
  },
  "ClientId": "",
  "Session": "<the Session token from the InitiateAuth response>"
}
```

Response includes `AuthenticationResult` with all four tokens. Same shape as Flow 1 success.

### Flow 3: REFRESH_TOKEN_AUTH (silent renewal)

```http
POST /auth-service/v3/whoop/ HTTP/1.1
x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth

{
  "AuthFlow": "REFRESH_TOKEN_AUTH",
  "AuthParameters": {
    "REFRESH_TOKEN": "<the JWE refresh token>"
  },
  "ClientId": ""
}
```

Response (status 200, ~1700 B):

```json
{
  "AuthenticationResult": {
    "AccessToken": "<new JWT>",
    "IdToken": "<new JWT>",
    "ExpiresIn": 86400,
    "TokenType": "Bearer"
  }
}
```

**Note: the refresh response does NOT include a new RefreshToken field.** Cognito does NOT rotate refresh tokens by default on this flow. The same refresh token continues to work until either:
1. The refresh token's own expiry (~30 days for Whoop), or
2. The user signs out, or
3. Whoop revokes it server-side.

Our `TokenManager` (`src/whoop/token_manager.ts`) handles both cases — if the refresh response *does* include a new RefreshToken (some Cognito configurations do rotate), it persists it. If it doesn't, we keep using the existing one.

### Flow 4: SOFTWARE_TOKEN_MFA (TOTP, not SMS)

For accounts using a TOTP authenticator app instead of SMS, the challenge name changes:

```json
{
  "ChallengeName": "SOFTWARE_TOKEN_MFA",
  "ChallengeResponses": {
    "USERNAME": "you@example.com",
    "SOFTWARE_TOKEN_MFA_CODE": "123456"
  },
  ...
}
```

Our `bootstrapCognito()` handles both:

```ts
if (init.ChallengeName === "SMS_MFA" || init.ChallengeName === "SOFTWARE_TOKEN_MFA") {
  ...
  ChallengeResponses: {
    USERNAME: input.email,
    [init.ChallengeName === "SMS_MFA" ? "SMS_MFA_CODE" : "SOFTWARE_TOKEN_MFA_CODE"]: code,
  }
}
```

### Flow 5: GetUser (read current user attributes)

```http
POST /auth-service/v3/whoop/ HTTP/1.1
x-amz-target: AWSCognitoIdentityProviderService.GetUser

{
  "AccessToken": "<current access token>"
}
```

Response (200, 579 B):

```json
{
  "Username": "8a3f1d4e-...",
  "UserAttributes": [
    {"Name": "sub", "Value": "8a3f1d4e-..."},
    {"Name": "email_verified", "Value": "true"},
    {"Name": "phone_number_verified", "Value": "true"},
    {"Name": "phone_number", "Value": "+15551234567"},
    {"Name": "email", "Value": "you@example.com"}
  ],
  "MfaOptions": [],
  "PreferredMfaSetting": "SMS_MFA",
  "UserMFASettingList": ["SMS_MFA"]
}
```

If the access token is expired, this returns 401 with:

```json
{
  "__type": "NotAuthorizedException",
  "message": "Access Token has expired"
}
```

The MCP doesn't use this endpoint — it relies on the cached user info from the bootstrap response — but it's useful for verifying auth state during debugging.

### Flow 6: JWE refresh (alternate path observed)

In Phase 1 we observed a different refresh path being used by the iOS app:

```http
POST /auth-service/v3/whoop/ HTTP/1.1
content-type: application/x-amz-json-1.1
(no x-amz-target)

{
  "ClientId": "",
  "Token": "eyJjdHkiOiJKV1Qi..."
}
```

The `Token` is the full JWE-encrypted refresh blob. The response in our capture was a 200 with no body recorded (mitmproxy lost the body on connection drop), so we don't have the full response shape. Hypothesis: this is an older path that's being replaced by REFRESH_TOKEN_AUTH. We don't use it.

### Headers required for auth requests

The Cognito proxy is sensitive to headers — missing the AWS SDK fingerprint headers causes CloudFlare to 403:

```
content-type: application/x-amz-json-1.1
x-amz-target: AWSCognitoIdentityProviderService.<Operation>
amz-sdk-invocation-id: <UUID, generated per request>
amz-sdk-request: attempt=1; max=1
user-agent: aws-sdk-swift/1.5.86 ua/2.1 api/cognito_identity_provider#1.5.86 os/ios#26.3.1 lang/swift#5.10 m/D,N,Z,b
accept: */*
accept-encoding: gzip, deflate, br
accept-language: en-US,en;q=0.9
```

The User-Agent must look like AWS's Swift SDK. We initially tried with a Node-style UA and got 403. Adopting the iOS SDK's UA passed.

### Headers for all other (data) requests

After auth, every API call to `api.prod.whoop.com/<service>/<endpoint>` uses bearer-token auth:

```
authorization: bearer <access token>
accept: application/json
content-type: application/json    (for POST/PUT/PATCH only)
accept-encoding: gzip, deflate, br
accept-language: en-US,en;q=0.9
user-agent: WHOOP/<build> CFNetwork/<n> Darwin/<n>    (when calling from the iOS app)
```

The MCP omits the iOS User-Agent since we're not pretending to be the app — we just need the token. Whoop doesn't seem to validate User-Agent on data endpoints.

The `apiVersion=7` query parameter is automatically appended to every request by `src/whoop/client.ts:54`:

```ts
const url = new URL(BASE_URL + path);
url.searchParams.set("apiVersion", API_VERSION);
```

We've not observed API version drift mid-session, but iOS app updates do roll the version forward periodically.

### Token storage

In the MCP, tokens persist to `.env`:

```
WHOOP_EMAIL=you@example.com
WHOOP_PASSWORD=<your password>
WHOOP_USER_ID=200001
WHOOP_IOS_BEARER_TOKEN=eyJraWQiOi...  (access token, ~1100 chars)
WHOOP_COGNITO_REFRESH_TOKEN=eyJjdHkiOi...  (refresh token, ~2000 chars)
```

`TokenManager` reads these on startup, decodes the JWT `exp` claim from the access token, and refreshes proactively when within 60 seconds of expiry. The refresh is single-flight: if two tool calls race past the freshness check, only one actually hits the refresh endpoint; the other awaits its result.

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

When the refresh response comes back with a rotated refresh token, it's written back to `.env`. Server restarts always pick up the freshest state.

### Error responses

| Status | Body shape | Meaning |
|---|---|---|
| 400 | `{"__type":"InvalidParameterException","message":"..."}` | Malformed request — missing required field, wrong type |
| 400 | `{"__type":"CodeMismatchException","message":"Invalid verification code provided, please try again."}` | Bad MFA code |
| 400 | `{"__type":"ExpiredCodeException","message":"Invalid code provided, please request a code again."}` | MFA code timed out (~3 min validity) |
| 401 | `{"__type":"NotAuthorizedException","message":"Incorrect username or password."}` | Wrong password |
| 401 | `{"__type":"NotAuthorizedException","message":"Refresh Token has expired"}` | Refresh token >30 days old; must re-bootstrap |
| 401 | `{"__type":"NotAuthorizedException","message":"Access Token has expired"}` | Access token >24 h old; refresh |
| 403 | (Cloudflare HTML page) | WAF rejected the request — usually a missing AWS SDK header |
| 429 | `{"__type":"TooManyRequestsException","message":"..."}` | Rate limit on auth attempts. Wait 60+ seconds. |

The MCP's error classifier (`src/whoop/errors.ts`) wraps these into:
- `WhoopAuthExpiredError` for 401
- `WhoopApiError` with the body excerpt for 4xx
- `WhoopServerError` for 5xx

---

## Cross-cutting patterns

Across the 47 services, six structural patterns recur. Understanding them once unlocks most of the API.

### Pattern 1: BFF vs. data services

Endpoints come in two flavors:

**Pure data services** return domain objects:
```json
{"score": 78, "hrv": 42, "rhr": 68, "respiratory_rate": 14.7}
```

**BFF (Backend-for-Frontend) services** return UI tree fragments:
```json
{
  "sections": [
    {"type": "HEADER", "content": {"title": "Recovery", "icon": "RECOVERY_HIGH"}},
    {"type": "GRAPHING_CARD", "content": {"title": "HEART RATE VARIABILITY", "graph": {...}}}
  ],
  "navigation_bar_text": "Recovery",
  "analytics_metadata": {...}
}
```

BFFs are designed for the iOS app to render directly — they include icons, fonts, navigation hints, modal definitions, and haptic feedback specifications inline. Some are 100% UI tree (e.g. `/health-tab-bff`, `/smart-alarm-bff`); others mix data + UI (e.g. `/home-service` returns pillars with both `score: 78` AND `display_name: "OVERVIEW"` and embedded UI sections).

To detect a BFF response: look for any of these top-level keys:

```
sections, tiles, modal, _dialog, _drawer, _bottom_sheet,
navigation_bar_text, toolbar_title, navigation_title,
content + type + refresh_behavior + prefetch_list,  (the followers-service/context-hub-bff envelope)
analytics, analytics_id, analytics_metadata, analytics_action,
cta, cta_location, button_title,
_display suffix on display strings (title_display, body_display)
```

Services we identified as primarily BFF:

```
/ai-conversation-bff/
/context-hub-bff/
/core-details-bff/
/followers-service/                           (BFF-shaped despite "-service" name)
/health-tab-bff/
/home-service/                                (BFF-style with pillars + sections)
/integrations-bff/
/smart-alarm-bff/
/membership-service/                          (mostly BFF)
/onboarding-service/                          (mostly BFF)
/streaks-service/v1/bff/...                   (literally has /bff/ in the path)
/coaching-service/v1/health/bff/monitor       (same)
/hr-zones-service/v1/bff/*                    (same)
/journal-service/v3/                          (BFF — vs v2 which is data)
/profile-service/v1/profile/bff*              (suffix)
/weightlifting-service/v3/                    (BFF — vs v2 which is data)
/womens-health-service/v1/                    (mostly BFF)
/advanced-labs-service/
/commerce-service/v1/mobile/shop/home
/research-service/research-bff-service/
/widget-service/
/community-service/v1/communities/featured    (BFF list)
```

The MCP prefers **data endpoints over BFFs** when both exist. For example:
- For sleep stages, the BFF endpoint `/home-service/v1/deep-dive/sleep/last-night?date=` returns the full UI tree (~848 KB). We project from it because it's the only sleep stage source, but we extract just the structured fields we need (~500 chars output).
- For workouts list, we use the public-API-equivalent endpoint at `/developer/v2/activity/workout` exposed inside the iOS API (~600 bytes per workout) instead of the home BFF's ACTIVITY tiles (~5 KB per workout with UI cruft). The iOS app calls this endpoint internally even though it's the same path the OAuth API documents — so we get the same compact shape without needing OAuth scopes.
- For journal entries, we use the v3 drafts endpoint (`/journal-service/v3/journals/drafts/mobile/{date}`) which is BFF-ish but returns structured `{tracked_behaviors[]}` — and NOT the v2 `/behaviors/user/{date}` endpoint, which misleadingly returns the user's behavior catalog (which behaviors they've enabled for tracking), not the entries.

### Pattern 2: GRAPHING_CARD by title (legacy — partially superseded)

> **Heads up:** Whoop migrated `/home-service/v1/deep-dive/recovery` and `/home-service/v1/deep-dive/strain` from this pattern to the new **`SCORE_GAUGE + CONTRIBUTORS_TILE`** shape in May 2026 — see [Pattern 2b](#pattern-2b-score_gauge--contributors_tile-may-2026-recovery--strain) below. The pattern below still applies to **sleep deep-dive, stress timeline, and trends**, which retain the card-based shape.

The most-loaded BFF pattern across most of Whoop's deep-dive endpoints. A `GRAPHING_CARD` represents one metric displayed as a line or bar chart over time:

```json
{
  "type": "GRAPHING_CARD",
  "content": {
    "id": "hrv",
    "title": "HEART RATE VARIABILITY",
    "trends_cta": {...},
    "icon": "HRV",
    "graph": {
      "id": "RECOVERY",
      "plane": {...},
      "plots": [
        {
          "plot": {
            "segments": [
              {
                "points": [
                  {
                    "data_scrubber_details": {
                      "primary_contextual_display": "SUN, MAY 17",
                      "value": null,
                      "value_display": "32",
                      "unit_display": "ms",
                      ...
                    },
                    "graph_label": {
                      "label": "32",
                      "label_style": "RECOVERY"
                    },
                    "position_x": 0.07,
                    "position_y": 0.34,
                    "style": "RECOVERY"
                  },
                  ...
                ]
              }
            ]
          }
        }
      ],
      "graph_title_display": null,
      "graph_buttons": [...]
    },
    "sub_items": [],
    "accessibility_label": "Seven day HRV graph"
  }
}
```

**Critical extraction rules** (the MCP discovered these the hard way):

1. **Identify the card by `content.title`** — case-insensitive substring match. Possible titles **on endpoints still using this pattern** (sleep deep-dive, stress, trends, home BFF): "HEART RATE VARIABILITY", "RESTING HEART RATE", "RESPIRATORY RATE", "SLEEP PERFORMANCE", "STEPS", "STRENGTH ACTIVITY TIME". The titles `"RECOVERY"`, `"STRAIN"`, `"HR ZONES 1-3"`, `"HR ZONES 4-5"`, `"CALORIES"` **no longer exist** in the recovery/strain deep-dives after Whoop's May 2026 migration — those moved to [Pattern 2b](#pattern-2b-score_gauge--contributors_tile-may-2026-recovery--strain). `type: "GRAPHING_CARD"` is the discriminator on `type`, but the title text identifies which card.

2. **Today's value lives at `graph.plots[0].plot.segments[0].points[N-1].graph_label.label`** as a STRING (e.g. "78%", "42", "1:41", "4,880"). Strip the `%` suffix and commas to get a number. Time labels like "1:41" should be parsed as minutes-to-ms.

3. **`data_scrubber_details.value` is always null.** Whoop puts the real value in `value_display` (string) and `graph_label.label` (string). The `value` field gets populated only after scrubbing on the touchscreen — at API time it's null. Our `extractGraphPoints` helper reads `value_display` first, falls back to parsing `graph_label.label`.

4. **Bar plots use a different path.** For day-strain weekly bars and HR-zone-time bars, points come from `plot.bar_groups[]` instead of `plot.segments[].points[]`. Each `bar_group` has a `top_label.label` with the value. The latest day is the rightmost bar (highest `position_x`).

5. **Baselines aren't returned as separate fields.** The HRV card has 7 daily points; today's value is the last point, and the "baseline" is implicitly the trend of the prior 6 points. The MCP computes baseline as the mean of prior points.

The MCP's `lib/walk.ts` provides:
- `findCardByTitle(node, titleSubstr)` — depth-first walk for a GRAPHING_CARD whose `content.title` contains the substring (case-insensitive)
- `latestGraphLabel(card)` — returns the latest point's `graph_label.label` or the last bar's `top_label.label` as a string
- `labelToNumber(label)` — strips `%` and commas, returns null for time labels
- `timeLabelToMs(label)` — parses `H:MM` to ms

### Pattern 2b: SCORE_GAUGE + CONTRIBUTORS_TILE (May 2026 — recovery + strain)

In May 2026 Whoop migrated `/home-service/v1/deep-dive/recovery` and `/home-service/v1/deep-dive/strain` away from the GRAPHING_CARD-by-title shape to a tighter design built around two new item types: `SCORE_GAUGE` and `CONTRIBUTORS_TILE`. The migration was discovered when `whoop_recovery` and `whoop_strain` started returning all-null structured outputs against live data (matrix tests on the dummy account didn't catch it — empty output looked plausible there).

**New shape (recovery example):**

```json
{
  "sections": [
    {
      "section_type": "COMPACT",
      "items": [{
        "type": "SCORE_GAUGE",
        "content": {
          "id": "RECOVERY_SCORE_GAUGE",
          "score_display": "78",
          "score_display_suffix": "%",
          "progress_fill_style": "RECOVERY_HIGH",
          "gauge_fill_percentage": 0.78,
          "destination": {"screen": "TRENDS", "parameters": {"trend_key": "RECOVERY", "duration": 1, "date": "2026-05-23"}}
        }
      }]
    },
    {
      "section_type": "COMPACT",
      "items": [{
        "type": "CONTRIBUTORS_TILE",
        "content": {
          "id": "RECOVERY_CONTRIBUTORS_TILE",
          "metrics": [
            {"id": "CONTRIBUTORS_TILE_HRV", "title": "Heart Rate Variability", "status": "42", "status_subtitle": "40", "status_type": "HIGHER_POSITIVE"},
            {"id": "CONTRIBUTORS_TILE_RHR", "title": "Resting Heart Rate", "status": "68", "status_subtitle": "70", "status_type": "LOWER_POSITIVE"},
            {"id": "CONTRIBUTORS_TILE_RESPIRATORY_RATE", "title": "RESPIRATORY RATE", "status": "14.7", "status_subtitle": "14.8", "status_type": "LOWER_POSITIVE"},
            {"id": "CONTRIBUTORS_TILE_SLEEP_PERFORMANCE", "title": "SLEEP PERFORMANCE", "status": "83%", "status_subtitle": "78%", "status_type": "HIGHER_POSITIVE"}
          ]
        }
      }]
    },
    {"section_type": "COMPACT", "items": [{"type": "ARCH_MINI_RECOVERY_IMPACTS", "content": {"path": "behavior-impact-service/v1/impact/summary-card/2026-05-23"}}]},
    {"section_type": "COMPACT", "items": [{"type": "ARCH_MINI_TRENDS", "content": {"path": "home-service/v1/deep-dive/recovery/trends?date=2026-05-23"}}]}
  ]
}
```

**Extraction rules:**

1. **Score lives in `SCORE_GAUGE.content.score_display`** as a STRING (e.g. `"78"` for recovery, `"18.9"` for strain). Match the right gauge by `content.id`:
   - Recovery score: `id === "RECOVERY_SCORE_GAUGE"`
   - Strain score: `id === "STRAIN_SCORE_GAUGE"`

2. **Recovery state comes from `progress_fill_style`** on the recovery score gauge: `RECOVERY_HIGH → GREEN`, `RECOVERY_MEDIUM → YELLOW`, `RECOVERY_LOW → RED`. The strain gauge's `progress_fill_style` is just `"STRAIN"` (a visual style, not a state).

3. **Contributor metrics are in `CONTRIBUTORS_TILE.content.metrics[]`**, identified by stable `id` constants. The full set seen so far:

   **Recovery contributors (`id === "RECOVERY_CONTRIBUTORS_TILE"`):**
   - `CONTRIBUTORS_TILE_HRV` — HRV (ms)
   - `CONTRIBUTORS_TILE_RHR` — Resting heart rate (bpm)
   - `CONTRIBUTORS_TILE_RESPIRATORY_RATE` — Respiratory rate (rpm)
   - `CONTRIBUTORS_TILE_SLEEP_PERFORMANCE` — Last night's sleep performance (% with suffix)
   - `CONTRIBUTORS_TILE_SPO2` — Blood oxygen (4.0+ strap only — not present on Brian's 3.0)
   - `CONTRIBUTORS_TILE_SKIN_TEMPERATURE` — Skin temperature (4.0+ strap only)

   **Strain contributors (`id === "STRAIN_CONTRIBUTORS_TILE"`):**
   - `CONTRIBUTORS_TILE_HR_ZONES_1_3` — Time in low/mid HR zones (format `"2:18"` → h:m)
   - `CONTRIBUTORS_TILE_HR_ZONES_4_5` — Time in high HR zones (format `"0:03"`)
   - `CONTRIBUTORS_TILE_STRENGTH_TRAINING_TIME` — Time in Strength Trainer (format `"2:35"`)
   - `CONTRIBUTORS_TILE_STEPS` — Today's step count (format `"10,616"`)

4. **`status` = today's value, `status_subtitle` = baseline.** Whoop now provides the baseline directly — the old projection's "compute mean of prior 6 days" math is gone. Just read both fields.

5. **Time-format values** (`"2:18"`, `"0:03"`) parse as `h:mm`. Use `(h*60 + m) * 60 * 1000` for ms. Three-segment values (`"1:23:45"`) parse as `h:m:s`.

6. **Comma-separated numbers** (`"10,616"`) need `.replace(/,/g, "")` before `parseInt`.

7. **`status_type`** classifies the trend direction: `HIGHER_POSITIVE` (current > baseline is good — HRV, steps), `HIGHER_NEGATIVE` (current > baseline is bad — RHR, resp rate), `LOWER_POSITIVE` (current < baseline is good — RHR, resp rate dropped), `LOWER_NEGATIVE` (current < baseline is bad — HRV dropped). Use this if you want to surface "your X is trending up/down" without doing math.

**Strain-specific differences from the legacy shape:**

- `calories`, `avg_hr_bpm`, `max_hr_bpm`, and per-zone (zone_0/2/3/5) granularity are **no longer in this endpoint** at all. They live per-workout in `/cardio-details`. The MCP keeps the schema fields (returning null) for compatibility.
- HR zones are only reported as the two aggregate buckets (1-3 and 4-5). The MCP stores them in `zone_1_ms` and `zone_4_ms` respectively; the other zones are null.
- Workout count comes from counting `ACTIVITY` items in the response (one per workout that day).

**Other deep-dive endpoints that have NOT migrated** (still use Pattern 2):

- `/home-service/v1/deep-dive/sleep/last-night?date=` — still has `DETAILS_GRAPHING_CARD` + `BAR_GRAPH_CARD` with stage timeline
- `/health-service/v2/stress-bff/{date}` — still has stress timeline via `STANDARD` + `LINE_PLOT`
- `/progression-service/v3/trends/{metric}?endDate=` — trend cards still use the older shape
- `/home-service/v1/home?date=` — home BFF still uses `KEY_STATISTIC` + `CARDIO` cards

If your projection of one of those endpoints starts returning all-nulls, repeat the migration analysis (dump live response → diff types/titles vs fixture → rewrite). The `whoop_endpoints` + `whoop_raw` MCP tools make this a 30-second loop.

### Pattern 3: Templated paths and placeholders

When the dedup pipeline templated paths, the following placeholders emerged:

| Placeholder | What it is | Where it comes from |
|---|---|---|
| `{uuid}` | UUID v4 (8-4-4-4-12 hex) | Server-assigned for most resources. Client-generated for workout set IDs, custom-exercise IDs (`randomUUID().toUpperCase()` per captured bodies). |
| `{id}` | Integer ≥6 digits | DB primary keys for communities, journal entries, weekly plans, behaviors |
| `{date}` | ISO `YYYY-MM-DD` | Day-level path segment, client uses local timezone for the date |
| `{community_id}` | Integer | Stable community ID. Seen: `12090, 36852, 36858, 41237, 67472`. |
| `{user_id}` | Integer | Stable user ID. Seen: `200001`, `200002` (test testuser2), `228741` (likely Whoop staff member who appeared in a leaderboard), `314986` (another user from leaderboard). |
| `{exercise_id}` | Upper-snake string OR UUID | Catalog: `BENCHPRESS_BARBELL`, `LATPULLDOWNFRONT_PULLEYMACHINE`, etc. Custom: UUID. |
| `{behavior_id}` | Integer 1-398 | Behavior tracker ID. Catalog has 308 active behaviors with IDs in this range (gaps where Whoop deleted experimental behaviors). |
| `{metric}` | Upper-snake string | Trend metric enum. 25 values: `HRV, RHR, RECOVERY, DAY_STRAIN, CALORIES, STEPS, AVERAGE_HR, HOURS_V_NEED, HOURS_V_NEEDED_PERCENT, TIME_IN_BED, SLEEP_PERFORMANCE, SLEEP_EFFICIENCY, SLEEP_CONSISTENCY, SLEEP_DEBT_POST, RESTORATIVE_SLEEP, HR_ZONES_1_3, HR_ZONES_4_5, RESPIRATORY_RATE, STRENGTH_ACTIVITY_TIME, STRESS, STRESS_DURING_SLEEP, STRESS_DURING_NON_STRAIN, VO2_MAX, BODY_COMPOSITION, WEIGHT`. |
| `{education_name}` | Upper-snake string | Feature-education flow name: `PAIRING_MODE_EDUCATION, ADVANCED_LABS_LH_CYCLE_RANGES, METABOLIC_HEALTH`, etc. |
| `{conversation_id}` | UUID | Whoop Coach conversation ID, server-assigned at create. |
| `{namespace}` | Upper-camel string | Notification namespace: `GPS, StressSummary, RecoveryReady`, etc. |

### Pattern 4: Pagination patterns

Three different pagination conventions across services:

**Offset + limit query params:**
```
GET /community-service/v1/communities/featured?offset=0&limit=20
GET /achievements-service/v1/progression?level=12&offset=0&limit=50
```

Response includes `{total_count, offset, records}`. The client paginates by incrementing offset.

**Opaque `next_token` cursor:**
```
GET /journal-service/v2/journals/behaviors?next_token=eyJsYXN0Ijo...
```

Response: `{records, next_token}`. Client echoes the token on the next call. Token is null when no more pages.

**Date-range filters:**
```
GET /community-service/v1/leaderboards/communities/41237/average/week/strain/day_strain?startDate=2026-05-17&endDate=2026-05-23
GET /weightlifting-service/v3/prs?startDate=2026-04-01&endDate=2026-05-23&offset=0
```

Some endpoints support both date ranges AND offset/limit.

**Date-in-path (no paging):**
```
GET /home-service/v1/deep-dive/recovery?date=2026-05-23
GET /journal-service/v2/journals/entries/user/date/2026-05-23
```

One day per request; no continuation.

### Pattern 5: Status code taxonomy

| Code | Frequency | Meaning |
|---|---|---|
| 200 | overwhelming majority | Success with body |
| 204 | ~40 occurrences | Success, no body. Used for PUT updates + DELETEs across the API. |
| 400 | ~15 occurrences | Client validation error. Response body shape: `{code, message[, location]}`. The `message` is server-controlled and reveals which field failed. The `location` is `"line N, column M"` of the JSON body. Real examples seen: `"Cannot deserialize value of type ContraceptionType from String 'IUD': not one of the values accepted for Enum class: [VAGINAL_RING, ARM_IMPLANT, HORMONAL_IUD, INJECTION, NONE, PILL, NON_HORMONAL_IUD, PATCH]"`, `"Valid birthday (YYYY-MM-DD) is required"`, `"User has no contraception status"`. |
| 401 | ~12 occurrences across services | JWT expired. The MCP catches these and triggers refresh, then retries. |
| 403 | 2 occurrences | Permission denied. Seen on `/community-service/v1/communities/{id}/status?online=false` after the user left that community. |
| 404 | ~25 occurrences | Three flavors: (a) no such entity, (b) feature not enabled for this user (e.g. `/growth-content-service/v1/advanced-labs/management/menu-item` for users without Advanced Labs), (c) leaderboard `/user/{id}` when the user has no data point in that window. The MCP catches 404 on optional sub-fetches (e.g. `whoop_leaderboard.user_row`) and returns `in_window: false` instead of throwing. |
| 409 | observed during testing | Resource conflict. Created activities or workouts in time ranges that overlap existing ones return 409. |
| 414 | 1 occurrence | URI Too Long. Seen on `/core-details-bff/v1/cardio-details?activityId={uuid}` once — almost certainly a client-side URL concatenation bug in the iOS app. |
| 422 | observed during testing | Body validation failed. Whoop sometimes returns 422 instead of 400 for "the request is structurally fine but our business logic says no". Examples: posting a workout with too-short duration, posting a profile PUT with too few fields. |
| 428 | 1 occurrence | Precondition Required. Seen on `/membership?useReplica=true` with a missing precondition header. The endpoint expects an `If-Match` or similar. |
| 500 | observed during testing | Server error. Whoop's behavior-impact endpoint returned 500 on a UUID that wasn't valid for that user — a server bug; should have been 404. |
| 5xx others | 0 observed | We haven't seen 502/503/504. |
| `None` | ~5 occurrences in dedup | mitmproxy didn't capture the response — connection dropped or the client retried before mitmproxy finished receiving. These are usually retried. |

### Pattern 6: Versioning

Many services run multiple concurrent versions. The pattern: higher version number = newer schema or added BFF layer. Older versions are rarely retired.

```
/coaching-service/        v1, v2     v2 added /sleepneed BFF
/behavior-impact-service/ v1, v2     v2 added header+footer+analytics_id
/core-details-bff/        v0, v1, v2 v0 used sport_id, v2 uses activity_internal_name
/health-service/          v1, v2     v1 = hormonal-insights, v2 = stress-bff
/journal-service/         v1, v2, v3 v1=prefs, v2=data, v3=BFF screen content
/membership-service/      v0, v1, v2, v3 progressive billing/management refinement
/onboarding-service/      v1, v2     v2 added /emails/check
/progression-service/     v2, v3     v2=weekly-plan, v3=exercise/trends BFF
/users-service/           v0, v1, v2 v0=PATCH preference, v1=goals/hidden-metrics/stealth/privacy, v2=bootstrap
/weightlifting-service/   v1, v2, v3 v1=exercise lookup, v2=catalog+writes, v3=BFF (PRs, library)
/auth-service/            v2, v3     v2=legacy user/password, v3=Cognito proxy
/community-service/       v1 only
/notification-service/    v1 only
/profile-service/         v1 only
```

The MCP picks the version that produces the cleanest data. For most reads we use v3 BFFs because they're the only place certain derived fields exist. For writes we prefer v2 data endpoints when available because they have more predictable bodies.

---

## Per-service endpoint reference

Every endpoint we observed, organized by service. For each: method + path, status codes seen, request body shape (when applicable), response shape, semantic notes about what the endpoint does, and known gotchas. Sizes are in bytes for the raw API response (before any projection).

### achievements-service

The gamification surface. Whoop awards achievements as the user accumulates streaks, hits PRs, or completes milestones. This service exposes only the read side — achievements are awarded server-side asynchronously after the user accomplishes something.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/achievements-service/v1/progression?level={level}` | 200 | Returns paginated achievements for the user's current level. Response is `{total_count, offset, records}` (11,660 B). `{level}` is the user's integer level. The "records" array contains achievement entries with title, description, progress percentage, and unlock state. Levels increase as the user maintains data streaks, sleeps consistently, hits goals, etc. |

Whoop sometimes opens a fullscreen modal when a new achievement unlocks — this same endpoint is hit on every app start so the iOS app can compare against locally-cached level state and show the "you unlocked X" overlay.

The MCP wraps this as part of `whoop_progress` (returns combined streaks + achievements).

### activities-service

Two distinct concerns: the live activity state machine (workout / sleep / idle / recovery) and the legacy `journals/behaviors` order list. The sport catalog also lives here.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/activities-service/v1/journals/behaviors/user` | 200 | Returns 176,630 B `{total_count, offset, records}` — the full list of journal behaviors with the user's per-behavior ordering preference. **Different from v2 catalog endpoint!** This is the user's display-order array. |
| PUT | `/activities-service/v1/journals/behaviors/user` | 204 | Body is a bare JSON array of behavior_tracker_id integers in display order. Two captures had `array[308]` and `array[309]`, matching catalog size ± deleted items. Reorders the journal's behavior toggles. The MCP doesn't wrap this directly — Brian's journal view stays the default order. |
| GET | `/activities-service/v1/journals/stats/user/{id}` | 200 | Per-behavior statistics (how many times tracked, last tracked date, etc.). 6,449 B `{total_count, offset, records}`. Calling with `/user/0` returns an empty record set (41 B) — `0` is the "any user" id. |
| GET | `/activities-service/v1/sports/history?countryCode=US` | 200 | 88,606 B array of 203 sport types localized to the country code. AU returned 88,608 B — slightly different bytes due to locale differences. Each sport has an id, name (localized), icon URL, and metadata. |
| GET | `/activities-service/v1/user-state` | 200 | 148 B response: `{latestMetricsProcessed, source, startAt, state, activity, trackedSleep}`. The realtime state machine. `state` is `"workout" \| "sleep" \| "idle" \| "recovery"`. `activity` is a nested object with `sport_id, sport_name, id` when state is workout. `startAt` is ISO datetime of state start. `latestMetricsProcessed` is the cursor of last metrics frame processed by the server. `trackedSleep` is `true` when the strap is currently asleep. |
| POST | `/activities-service/v1/user-state` | 200 | Body: `{"state": "workout"}` — sets current state manually. Used by iOS when the user taps "Start Workout" in the app to override auto-detection. Response shape matches GET. |
| GET | `/activities-service/v2/activity-types` | 200 | 54,998 B array of 197 activity-type records. This is the *canonical* sport/activity catalog used by the workout-creation flows. Differs from `/v1/sports/history` (which is the per-country localized list with 203 entries). The v2 catalog has fewer entries because some sports were merged or deprecated. |

The MCP exposes `whoop_live_state` (one tool) directly off `/activities-service/v1/user-state`. Other endpoints aren't wrapped because their data is either niche (`stats/user/0` is useless) or huge and not very actionable (sport catalog of 203 entries).

### advanced-labs-service

Whoop's "Advanced Labs" is a paid add-on that ships bloodwork via partner labs. This service hosts the BFF for the in-app shop and the post-purchase result viewer.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/advanced-labs-service/v1/advanced-labs` | 200 | 28,555 B BFF response: `{metadata, navigation_bar, sections, analytics, bottom_sticky_items, initially_selected_segment_id, attended_appointment_dialog}`. The main Advanced Labs landing page in the app. `sections` is a UI tree describing the booking flow + result viewer. |
| GET | `/advanced-labs-service/v1/product/pdp?panel=BASELINE&screenType=PURCHASE` | None | Response not captured (mitm missed it). `panel` enum observed: `BASELINE`. Other inferred: `HORMONE`, `FITNESS`. `screenType=PURCHASE` is the in-app upgrade flow. |

Not wrapped by the MCP — purely a commerce surface.

### ai-conversation-bff + ai-conversation-service

The Whoop Coach surface. The `-bff` returns conversation UI fragments (turns, messages, suggestions, render hints); the `-service` exposes the Coach-memory settings page.

| Method | Path | Status | Notes |
|---|---|---|---|
| POST | `/ai-conversation-bff/v1/conversation` | 200 | Creates a new conversation. Body shape: `{source_id, fingerprint, tracking_capabilities, chat_entrypoint_experience, args, source_type}`. Response: `{metadata: {id, fingerprint, source_type, source_id, title, turn_status, icon}, turns: [...], tag}`. The response auto-greets the user — `turns[0].messages[0].items[0].content.text` is the assistant's hello. |
| GET | `/ai-conversation-bff/v1/conversation/{conversation_id}/presentation/CARDIO_DETAILS` | 200 | 76 B `{proactive_animation}`. A small render hint for showing the conversation embedded inside a cardio activity-detail screen. Other presentation suffixes likely: `RECOVERY`, `STRAIN`, `SLEEP`, `HOME`. |
| GET | `/ai-conversation-bff/v1/conversation/{conversation_id}/suggestions` | 200 | 109 B `{suggestions}` — array of pill-shaped suggestion chips the user can tap to send. Suggestions are context-aware (different for sleep-deep-dive vs home). |
| POST | `/ai-conversation-bff/v1/conversation/{conversation_id}/turn` | 200 | Sends a user message. Body: `{role: "user", content: "yes sir", tracking_capabilities, is_suggestion: false}`. Response 312 B: `{id, turn_status, messages, turn_number, feedback}`. `id` is the turn UUID — used for the subsequent GET poll. |
| GET | `/ai-conversation-bff/v1/conversation/{conversation_id}/turn/{uuid}` | 200 | 189 B response with same shape — poll this until `turn_status` is `COMPLETE` or `messages[]` is non-empty. The Coach response text lives at `messages[].items[].content.text` (BFF rich-content shape), NOT `messages[].content` directly. |
| POST | `/ai-conversation-bff/v1/conversation/{conversation_id}/turn/{uuid}/seen` | 200 | Body: `{"ttfmt_ms": 5011}` — "time to first meaningful text" telemetry. The client reports how long it took to render the response. |
| GET | `/ai-conversation-service/v1/settings` | 200 | 1,687 B `{title, settings, footer}` — list of Coach setting toggles like "WHOOP_COACH_MEMORY". |
| PUT | `/ai-conversation-service/v1/settings` | 200 | Body: `{"active": false, "setting_key": "WHOOP_COACH_MEMORY"}`. Toggles a coach setting. Response 1,688 B same shape. |

**The fingerprint pattern.** The conversation's `fingerprint` is a deterministic cache key:

```
fingerprint = "CHAT_WITH_AGENT" + <context_marker> + "_" + <date>
```

Context markers observed:
- `TRENDS_SLEEP_EFFICIENCY` — opened from the sleep-efficiency trend page
- `TRENDS_HRV`, `TRENDS_RHR`, `TRENDS_RECOVERY`, `TRENDS_STRAIN`, `TRENDS_STRESS`, `TRENDS_SLEEP_PERFORMANCE` — similar for other trend pages
- `CARDIO_DETAILS_<activity_uuid>` — embedded in a cardio activity detail
- `STRESS_MONITOR_<date>` — opened from the stress page
- `WAKE_UP_REPORT_<date>` — opened from the morning wake-up report
- `HOME_DAY_RECAP_<date>` — opened from the home tab's daily summary

Same fingerprint = same conversation (Whoop reuses conversations when context matches). Different fingerprint = new conversation.

The MCP wraps `whoop_coach_ask` (real send + poll) and `whoop_coach_conversation` (read a specific turn). The async polling waits up to 30 × 1 second for the response.

### app-notifications-service

The in-app notification inbox (the bell icon's contents). Different from the OS push notification system.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/app-notifications-service/v1/app/notification-cards` | 200 | 22 B `{cards, count}` — the carousel of inbox notification cards. Cards are dismissable. |
| PUT | `/app-notifications-service/v1/app/notifications/{uuid}/expire` | 200 | Dismisses one inbox card. 1,231 B response: `{id, seen, expired, created_at, updated_at, app_notification_type, template_type, notification_title_key, notification_body_key, notification_title_metadata}`. The notification type + template_type identify the kind of notification; `notification_title_key` is an i18n key for the localized text. |

Not wrapped by the MCP — these notifications are user-facing and not high-value as a programmatic surface.

### auth-service

Already covered in detail under [Authentication](#authentication). The endpoints:

| Method | Path | Status | Notes |
|---|---|---|---|
| POST | `/auth-service/v3/whoop/` | 200/400/401/429 | Multiplexes 5 Cognito operations by request body shape: InitiateAuth (USER_PASSWORD_AUTH / REFRESH_TOKEN_AUTH), RespondToAuthChallenge (SMS_MFA / SOFTWARE_TOKEN_MFA), GetUser, JWE refresh (legacy). |
| GET | `/auth-service/v2/user` | 200 | Alt user lookup. Returns `{user}`. |
| OPTIONS | `/auth-service/v2/user` | 200 | CORS preflight (suggests this endpoint gets called from in-app web views too). |
| GET | `/auth-service/v2/whoop/password/requirements` | 200 | 395 B `{password_policies}` — the password policy used during signup. Includes min length, character class requirements, etc. |

### autopop-service

The "auto-populate" suggestion engine. Whoop's iOS app infers behaviors from HealthKit data (e.g. "you went for a run yesterday — log workout?") and shows them as one-tap suggestions in the journal. This endpoint accepts the user's acceptance of those suggestions.

| Method | Path | Status | Notes |
|---|---|---|---|
| PUT | `/autopop-service/v1/autopop/JOURNAL/{cycle_id}` | 204 | Marks the autopop suggestion for a journal as accepted. The `JOURNAL` segment is a category enum — others likely exist (e.g. `WORKOUT`) but only this was observed. `{cycle_id}` is the integer cycle ID for the day. No response body. |

Wrapped as `whoop_journal_autopop`. Irreversible — once accepted, the suggestion can't be un-accepted.

### behavior-impact-service

Correlation analysis: how journal behaviors (alcohol, caffeine, stress, meditation, etc.) affect downstream metrics (recovery, sleep, HRV). The data is computed server-side from the user's history.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/behavior-impact-service/v1/impact` | 200 | 13,886 B `{header, journal_enabled, cycle_id, tiles, metadata}` — main impact tab. `tiles` lists behaviors with their measured impact direction (helps recovery / hurts recovery). Requires the user to have logged a meaningful amount of journal data (weeks); on fresh accounts this returns nearly-empty. |
| GET | `/behavior-impact-service/v1/impact/journal-trends/{uuid}` | 200 | 6,099 B `{sections}` — trend chart for a single behavior over time. `{uuid}` is the behavior's impact-detail UUID (not the numeric `behavior_tracker_id`!). |
| GET | `/behavior-impact-service/v1/impact/journal-trends/{uuid}?endDate={date}` | 200 | 6,101 B same — bounded with end date. |
| GET | `/behavior-impact-service/v1/impact/journal-trends/{uuid}?startDate={date}` | 200 | 5,467 B same — bounded with start date. |
| GET | `/behavior-impact-service/v1/impact/summary-card/{date}` | 200 | 985 B `{impact_summary_card}` — daily impact summary for the home screen. "Your alcohol last night likely dropped recovery by X%". |
| GET | `/behavior-impact-service/v2/impact/details/{uuid}` | 200 | 2,663 B `{header, sections, footer, analytics_id, metadata}` — v2 deep-detail view for one behavior. The v2 adds `header` + `footer` + `analytics_id` wrapping vs v1's flat `sections`. |

**Critical:** the path placeholders are UUIDs (impact detail IDs), NOT numeric behavior_tracker_ids. To resolve the UUID for a given behavior, the iOS app reads it from `/journal-service/v3/journals/behaviors` (the BFF behavior list) — each behavior toggle there has `destination.parameters.detail_id` populated with the impact UUID. The MCP looks the UUID up the same way.

Note: on fresh accounts (testuser2 dummy), no behavior has ever been logged, so `destination.parameters.detail_id` is null and the impact endpoint returns 500. A populated account has logged behaviors over time, so his UUIDs are populated and the endpoint works.

Wrapped as `whoop_behavior_impact`.

### candidate-service

Apple HealthKit ingestion. The iOS app pushes HealthKit data (sleep, heart rate, steps, workouts, oxygen saturation, respiratory rate) into Whoop's backend via this service for accounts that have HealthKit sync enabled.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/candidate-service/v1/applehealthkit/events?token={n}&permissions=...` | 200 | 556 B response: `{token, sleep_samples, deleted_sleep_samples, workout_samples, deleted_workout_samples, resting_heart_rate_samples, deleted_resting_heart_rate_samples, respiratory_rate_samples, deleted_respiratory_rate_samples, oxygen_saturation_samples}`. The `token` query param is the client's sync cursor (last successful sync). The `permissions` query param is a comma-separated list of HealthKit permission identifiers: `HKCategoryTypeIdentifierSleepAnalysis, HKQuantityTypeIdentifierActiveEnergyBurned, HKQuantityTypeIdentifierHeartRate, HKQuantityTypeIdentifierOxygenSaturation, HKQuantityTypeIdentifierRespiratoryRate, HKQuantityTypeIdentifierRestingHeartRate, HKQuantityTypeIdentifierStepCount, HKWorkoutTypeIdentifier`. |

This is the **pull-based reconcile API**: client passes its last-seen token, server returns new + deleted samples + a new token. The actual sample *upload* happens elsewhere (likely as part of the protobuf `/metrics-service/v1/metrics` stream). Not wrapped by the MCP — only useful if you're building an iOS replacement.

### coaching-service

Whoop's coaching surfaces: the health monitor, the health report (lab-result narrative summary), the performance assessment (weekly/monthly/yearly progress evaluations), and the sleep need calculator that drives the Sleep Coach.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/coaching-service/v1/health/bff/monitor` | 200 | 8,444 B `{metadata, title, footer, items, analytics}` — the health monitor home tile (the "Health" card on the home screen, showing weekly trends in HRV / RHR / respiratory rate compared to baseline). |
| GET | `/coaching-service/v1/health/report` | 200/404 | Returns 404 if the user hasn't generated a health report yet. After POSTing to the same path, returns 200. |
| POST | `/coaching-service/v1/health/report` | 200 | Generates the user's first health report. Empty body; success returns the new report. |
| GET | `/coaching-service/v1/performance-assessment/{period}/data/{iso_timestamp}` | 200/404 | 249–254 B response: `{is_assessment_needed, has_assessment, total_recoveries, required_recoveries, recoveries_before_recent_cutoff, expected_assessment_during, next_assessment_during}`. `{period}` enum: `WEEK, MONTH, YEAR`. `{iso_timestamp}` is local ISO with TZ offset (`YYYY-MM-DDTHH:mm:ss.SSS-0700`). 404 means the period boundary hasn't passed yet. 13 distinct captures of this endpoint with different timestamps — each tab open refreshes the timestamp. |
| GET | `/coaching-service/v2/sleepneed` | 200 | 2,819 B `{turn_off_schedule_modal, turn_off_all_modal, chip_label_text_display, alarm_schedule_state, next_schedule_day_label, eligible_for_smart_alarms, need_breakdown, need_breakdown_formatted, recommended_time_in_bed_formatted, menstrual_coach_enabled}`. The Sleep Coach data source. `need_breakdown` is the structured `{baseline, debt, strain, nap_credit}` minutes object. `need_breakdown_formatted` is a pre-rendered narrative string. `recommended_time_in_bed_formatted` is `"8h 23m"` style display. `eligible_for_smart_alarms` is a boolean used to gate the smart-alarm screen. `menstrual_coach_enabled` is `true` only if the user has set up MCI. |

Wrapped as `whoop_performance_assessment` + `whoop_sleep_need`. Health monitor not wrapped (low value for a chat interface).

### commerce-service

In-app shop + membership pricing catalog.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/commerce-service/v1/mobile/shop/home?source=menu` | 200 | 68,672 B BFF: `{metadata, navigation_bar_text, cart, sections, country_selector}`. The mobile shop landing page. Massive response because it includes product catalog (straps, accessories, apparel) with image URLs + pricing. |
| GET | `/commerce-service/v2/join-flow/catalog/memberships?tier=PEAK&country=US&language=en` | 200 | 18,884 B `{memberships}`. The membership pricing catalog for signup. `tier` enum: `PEAK` observed; based on Whoop's public pricing page, others are `ONE` and `LIFE`. `country` is ISO-2; `language` is BCP-47. |

Not wrapped by the MCP.

### community-service

By far the largest service surface — 101 unique operations after dedup. Three major areas: community CRUD (create/join/leave/list communities), leaderboards (rank users in a community across metrics × windows), and chat token (issues a Stream/Pusher-style chat auth token).

#### Community CRUD

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/community-service/v1/communities/defaultImages` | 200 | 13,616 B `{banner_urls, avatar_urls}` — default images for new community creation. |
| GET | `/community-service/v1/communities/featured?includeOwnerDetails=true&offset=&limit=` | 200 | 7,176 B `{total_count, offset, records}` — featured discovery list. |
| GET | `/community-service/v1/communities/invites/pending?recipientId={user_id}&includeDetails=true` | 200 | 41 B (empty for users with no invites). |
| POST | `/community-service/v1/communities/join/{COMM-CODE}` | 200 | Body empty. Path codes seen: `COMM-0D8539, COMM-68073D`. Response 329 B: `{id, unread_count, deleted, online, member_type, notification_setting, created_at, updated_at, last_online, user_id}`. |
| GET | `/community-service/v1/communities/memberships?...` | 200 | 1,640-3,213 B `{total_count, offset, records}` — your communities + your rank in each. Query params: `userId, includeOwnerDetails, offset, limit, teamType, includeUserRank, leaderboardType, startDate, endDate, period`. `teamType` enum observed: `ALL, COMMUNITY` (others likely: `TEAM, BUSINESS`). `leaderboardType` enum: `strain, sleep, recovery`. |
| POST | `/community-service/v1/communities?includeOwnerDetails=true` | 200 | **multipart/form-data** with `Boundary-` delimiters. Fields: `name, shareStrain, shareRecovery, shareSleep, avatarUrl, bannerUrl`. Response 1,566 B: full community object. Note: this is one of only 2 multipart endpoints in the API — the other is the profile avatar PUT. |
| PUT | `/community-service/v1/communities/{id}` | 200 | JSON: `{about, avatar, banner, name, owner_id, private, share_recovery, share_sleep, share_strain}`. Updates an existing community. |
| PUT | `/community-service/v1/communities/{id}/chat?chatEnabled={bool}&teamType=COMMUNITY` | 200 | No body. Toggles chat for the community. |
| GET | `/community-service/v1/communities/{id}/members/details?excludeUser={user_id}&teamType=COMMUNITY&offset=&limit=` | 200 | Paginated member roster. |
| GET | `/community-service/v1/communities/{id}?userId=0&includeOwnerDetails=true` | 200 | 1,454 B full community object. `userId=0` is the "any user" lookup. |
| PUT | `/community-service/v1/communities/{id}/status?online={bool}` | 200/401/403 | Toggle online presence in a community. 403 if the user has left that community. |
| DELETE | `/community-service/v1/communities/{id}/leave?userId={user_id}` | 204 | Leaves the community. |

#### Chat token

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/community-service/v1/chat/token` | 200 | 285 B `{chat_token, user_id, channels}` — auth token for Whoop's chat backend (Stream/Pusher style). The `channels` array lists which chat channels the user has access to. |

#### Leaderboards

Templated path:

```
/community-service/v1/leaderboards/communities/{community_id}/<window>/<metric>/<stat>[/user/{user_id}][?filters]
```

| Window | Metric | Stat suffix |
|---|---|---|
| `{date}` (daily, ISO date in path) | `recovery` | `score` |
| `average/week` | `sleep` | `performance` |
| `average/month` | `strain` | `day_strain` |

Query params: `offset, limit, startDate, endDate, includeCompliance, complianceCutoff` (e.g. `70`), `teamType=COMMUNITY`.

Observed combinations — every (window × metric) pair tested:

| Window | Metric | List endpoint | Single-user endpoint |
|---|---|---|---|
| `{date}` | `recovery/score` | 200 | 200 / 404 |
| `{date}` | `sleep/performance` | 200 | 200 / 404 |
| `{date}` | `strain/day_strain` | 200 | 200 / 404 |
| `average/week` | `recovery/score` | 200 | 200 / 404 |
| `average/week` | `sleep/performance` | 200 | 200 / 404 |
| `average/week` | `strain/day_strain` | 200 | 200 / 404 |
| `average/month` | `recovery/score` | 200 | 200 / 404 |
| `average/month` | `sleep/performance` | 200 | 200 / 404 |
| `average/month` | `strain/day_strain` | 200 | 200 / 404 |

Response shapes:

**List:** `{name, average, last_updated_at, total_empty, total_compliant, total_non_compliant, total_count, offset, records}`

**Recovery user row:** `{score, hrv, rhr, first_name, last_name, avatar_url, rank, deleted, created_at, updated_at}`

**Sleep user row:** `{duration, performance, first_name, last_name, avatar_url, rank, deleted, created_at, updated_at, cycle_day_joined}`

**Strain user row (avg/week/month):** `{day_strain, calories, peak_activity, first_name, last_name, avatar_url, rank, deleted, created_at, updated_at}`

**Strain user row (`{date}`):** `{day_strain, calories, activity_strain, activities, first_name, last_name, avatar_url, rank, deleted, created_at}` — has extra `activity_strain` and `activities` breakdown.

**404 on `/user/{id}`** means "user has no data point in the leaderboard window" (didn't meet compliance, no recovery score that day, etc.). The list endpoint still returns 200 in those cases.

Communities observed in Brian's account: `12090, 36852, 36858, 41237, 67472`. The 41237 community had a member named "Whoop Team" (user_id 228741) — possibly internal staff. The 67472 community had a 403 on online status — Brian had left it.

Wrapped as `whoop_leaderboard` (single tool, dispatches on window + metric).

### context-hub-bff

A generic UI lifecycle coordinator. The iOS app fetches one of these when entering a context (coach-chat, profile, etc.) to know what to prefetch and how to set up the UI scaffold.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/context-hub-bff/v1/context-hub?analytics_source={source}` | 200 | 11,410-11,413 B `{content, type, refresh_behavior, prefetch_list, lifecycle_interactions}`. `analytics_source` enum: `coach-chat, profile` observed. Others inferred from UI flows. |

Not wrapped — pure UI coordination, no useful data.

### core-details-bff

Activity / cardio / strength workout detail screens. Three versions in use simultaneously.

| Method | Path | Status | Notes |
|---|---|---|---|
| POST | `/core-details-bff/v0/create-activity` | 200 | Body: `{sport_id: 1, gps_enabled: true, start_time: "2026-05-25T01:46:05.044Z", end_time: "2026-05-25T01:46:07.740Z"}`. Response 490 B: `{id, cycle_id, user_id, created_at, updated_at, version, during, timezone, timezone_offset, source}`. The "v0 with sport_id" shape works reliably; the MCP uses this. |
| POST | `/core-details-bff/v2/create-activity` | 400 | Body sent was malformed in the original capture (used `"May 25, 2026"` instead of ISO timestamps): `{"end_time":"May 25, 2026","gps_enabled":false,"start_time":"May 25, 2026","activity_internal_name":"skiing","garment_id":1}`. Response 286 B: `{code, message, location}`. The v2 endpoint accepts the same fields but with `activity_internal_name` (string, e.g. `"skiing"`) instead of `sport_id` (integer). v2 needs ISO timestamps too — the captured body was buggy. |
| GET | `/core-details-bff/v1/cardio-details?activityId={uuid}` | 200/414 | **~300 KB response!** `{metadata, link_workout_option_enabled, link_workout_cta_tile, title_bar, horizontal_stat, horizontal_stats, key_metric_carousel, graph_response, vow_response_string, bar_graph_container, tags, tags_v2, map, details_edit_components, whoop_coach_vow, onboarding_overlays, strain_breakdown, weightlifting_cardio_details, menu_options, additional_info_text, achievement_progress_card}`. The single richest endpoint per byte. 414 URI Too Long was seen once — almost certainly a one-off client bug. |
| DELETE | `/core-details-bff/v1/cardio-details?activityId={uuid}` | 204 | Deletes the activity. |
| GET | `/core-details-bff/v1/start-activity/strain` | 200 | 13,044 B `{cycle_metadata, stealth_mode_enabled}` — the pre-workout screen that shows your current day strain. |
| GET | `/core-details-bff/v2/activity-type/user-created` | 200/None | 1,330 B `array[5]` — the user's custom-defined activity types. |
| GET | `/core-details-bff/v2/prediction/{id}/activity` | 200 | 86 B `{items, divider_title, show_time_range}` — workout suggestions for the user based on a prediction ID. |

The 300 KB cardio-details response is decomposed by the MCP's `whoop_workout` projection:
- `title_bar.title_display` → sport name
- `details_edit_components.start_time_selector.initial_time` / `end_time_selector.initial_time` → ISO timestamps
- `horizontal_stat.stat_main_value_display` → activity strain
- `key_metric_carousel.key_metric_tile[]` by icon → calories, avg HR, max HR
- `bar_graph_container.heart_rate_zones[]` → 6 HR zone durations
- `graph_response.plots[*].plot.segments[*].points[]` → HR curve
- `weightlifting_cardio_details.weightlifting_exercises.exercise_summary_carousel.items[0].tonnage_display` → MSK total volume (in lbs, converted to kg)
- `strain_breakdown.msk_percent_display` → MSK intensity percentage

Each HR zone has an ID mapping to a zone index:
- `RESTORATIVE` → zone 0
- `VERY_LIGHT` → zone 1
- `LIGHT` → zone 2
- `MODERATE` → zone 3
- `HARD` → zone 4
- `MAX` → zone 5

The same `weightlifting_cardio_details.weightlifting_exercises.exercise_summary_carousel.items[]` array is also the source for `whoop_lift_history`'s **per-exercise aggregates**. Each item past the first (the first is the workout-summary row with `exercise_id: null`) has:
- `exercise_id` (e.g. `"LEGPRESS_PULLEYMACHINE"`)
- `title_display` (e.g. `"Leg Press"`)
- `subtitle_display` (e.g. `"5 Sets"` — parse as `\d+`)
- `tonnage_display` (e.g. `"9600"` — in lbs, parent has `tonnage_units_display: "lbs"`)
- `volume_display` (e.g. `"50"` — total reps)
- `achievement_icons` (e.g. `["BADGE_SILVER", "BADGE_BRONZE"]`)

**Per-set detail (set 1: 10 reps @ 200lbs, set 2: ...) is NOT in this endpoint** — Whoop only exposes per-exercise aggregates here. For per-set numbers, use `/weightlifting-service/v3/exercise/{id}/exercise_history` (wrapped as `whoop_lift_exercise`).

**Sport name filter (lift_history):** `/developer/v2/activity/workout` returns sport_name as `internal_name` (e.g. `weightlifting_msk` for Strength Trainer, `weightlifting` for manual weightlifting, `powerlifting`). None of these contain the substring "strength" — match with `/weight|strength|powerlift/i` to catch all three. This was fixed 2026-05-26 after `whoop_lift_history` was returning empty arrays for all real strength workouts.

Wrapped as `whoop_workouts` (list, uses `/developer/v2/activity/workout`), `whoop_workout` (single), `whoop_activity_create`, `whoop_activity_delete`, `whoop_lift_history` (filters list to strength sports + extracts per-exercise aggregates from each).

### device-config

Remote feature-flag service.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/device-config/v1/value` | 200 | 2 B `array[0]`. Empty in our capture — no feature flags set for the user. Other accounts may receive non-empty arrays. |

Not wrapped.

### enterprise-service

For accounts that belong to a Whoop Enterprise / Whoop For Business deployment.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/enterprise-service/v1/data-sharing` | 200 | 234 B `{title, subtitle, account_data_sharing_list, footer_text, display}` — lists organizations the user shares their data with (sports teams, employers, military units). |

Not wrapped — niche surface.

### entitlement-service

Feature flags / paid-tier gating. The single source of truth for what features the user can access.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/entitlement-service/v1/entitlements` | 200 | 2,509 B `{entitlements, context, tier_feature_map}`. `entitlements` is an object mapping feature names to boolean access flags. `tier_feature_map` shows which features are available at each tier (ONE / PEAK / LIFE). |
| PUT | `/entitlement-service/v1/entitlements/onboarding` | 200 | No body. Triggered during onboarding to refresh entitlements after the user picks a tier or completes payment. Response 1,951 B same shape. |

Not wrapped directly — entitlements are mostly internal. The MCP returns the membership status via `whoop_profile`.

### followers-service

Social graph — follower/following model. Distinct from communities (which are group-based). Followers are user-to-user.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/followers-service/v1/followers-home` | 200 | 7,849 B BFF: `{content, type, refresh_behavior, prefetch_list, lifecycle_interactions}` — the followers tab landing page. |
| GET | `/followers-service/v1/followers-home/manage` | 200 | 1,286 B same BFF shape — manage-followers screen. |
| GET | `/followers-service/v1/followers-home/manage/SHARING` | 200 | 2,100 B `{filters, items}` — sharing settings (which metrics you share with followers). `SHARING` is one of the manage-screen categories. Others likely: `FOLLOWERS, FOLLOWING, BLOCKED`. |
| GET | `/followers-service/v1/search` | 200 | 1,272 B BFF shape — follower-search screen. |
| GET | `/followers-service/v1/search/results` | 200 | 1,181 B `{search_place_holder_text, search_debounce_ms, loading_hint_text, analytic_event, items}` — search-result list. `search_debounce_ms` is the recommended debounce for the search input (typically 300-500). |

Not wrapped — the MCP doesn't expose social graph operations.

### growth-content-service

Marketing / upsell / onboarding content.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/growth-content-service/v1/advanced-labs/management/menu-item` | 404/401 | Returns 404 if the user hasn't purchased Advanced Labs. The 401 was likely a token-expiry race. |
| GET | `/growth-content-service/v1/in-app-welcome-screen/order-info-content` | 200 | 3,888 B `{image_name, header, description, menu_items, education_content, provisional_email, footer_buttons, cta}` — the post-purchase welcome screen content. |
| GET | `/growth-content-service/v1/payment-method/menu-item` | 200/401 | 425 B `{menu_item, payment_error_state_analytics_properties}` — the "manage payment method" menu item shown in settings. |

Not wrapped.

### health-service

Two distinct concerns: hormonal-insights settings (the MCI / women's-health setup flow) and the stress monitor BFF.

#### Hormonal insights (v1)

| Method | Path | Status | Notes |
|---|---|---|---|
| DELETE | `/health-service/v1/hormonal-insights/settings/mci` | 204 | Disables MCI (Menstrual Cycle Insights) entirely. |
| PUT | `/health-service/v1/hormonal-insights/settings/mci/survey` | 204 | Body: `{contraception_type, interest, last_period_date_range, removed_period_days, symptoms, typical_cycle_length}`. Sets up MCI. |

**Valid enums (server-validated; we discovered these by probing 400s):**

`contraception_type`:
```
NONE, PILL, ARM_IMPLANT, HORMONAL_IUD, NON_HORMONAL_IUD, PATCH, INJECTION, VAGINAL_RING
```

`interest`:
```
SUPPORT_REPRODUCTIVE_HEALTH_GOALS
OTHER_OR_NONE_OF_THE_ABOVE
MANAGE_HORMONAL_CONDITION
AVOID_PREGNANCY
```
(truncated in the 400 error message; there may be additional values.)

`symptoms` is an array of stringified behavior IDs that match the journal catalog: `["229", "177", "231", "227", "230"]`.

`typical_cycle_length` is integer days (default 28).

`last_period_date_range` is an array of `[YYYY, MM, DD]` triples for the most recent period.

`removed_period_days` is similar — for past periods the user wants to delete from the prediction model.

The MCP uses this to preflight the dummy account before testing `whoop_cycle` (which requires `contraception_type` set).

#### Stress monitor (v2)

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/health-service/v2/stress-bff/{date}` | 200/401 | **~1.5 MB response.** `{metadata, title, date_selector, show_connectivity_window, show_education, calibration_text_display, progress_stepper, loading_data, stress_state, vow}`. The full stress monitor BFF for a date. |
| GET | `/health-service/v2/stress-bff/{date}/calendar` | 200 | 2,820 B `{calendar_title_display, days_of_month}` — month picker for the stress tab. |
| POST | `/health-service/v2/stress-bff?timestamp=May%2024,%202026` | 404 | **Binary body!** Protobuf frames similar to `/metrics-service/v1/metrics`. 404 in all captures — this is probably a deprecated upload path. Real uploads happen via metrics-service. |

The stress endpoint is 1.5 MB because it includes the per-15-minute stress level timeline for the entire day plus calibration markers, education content, and the Whoop Coach "vow" narrative. The MCP's `whoop_stress` and `whoop_live_stress` extract just the timeline + current level.

`stress_state.timeline` is an array of `{started_at, ended_at, level}` objects, one per 15-minute window. `level` is null during "no data" windows (strap off, in a workout, etc.).

### health-tab-bff

The Health tab — a single home for HRV, RHR, respiratory rate, SpO2, skin temp trends + the live HR view when the strap is recording.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/health-tab-bff/v1/health-tab` | 200/401 | 29,141 B `{sections, analytics, show_live_hr, scroll_background_style}` — the Health tab UI. `show_live_hr` is a boolean that determines whether the live HR section is shown. |

The MCP's `whoop_live_hr` reads this and walks for a `LIVE_HR` / `HEART_RATE_LIVE` / `LIVE_HEART_RATE_TILE` section. When `show_live_hr` is false (the strap isn't actively recording), the tile is absent and `current_bpm` is null.

### home-service

The Home tab — every score, deep dive, and trends entry point.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/home-service/v1/calendar/overview?date={date}` | 200 | `{calendar_title_display, calendar_key, days_of_month}`. Month-view calendar with per-day score state. |
| GET | `/home-service/v1/calendar/recovery?date={date}` | 200 | Same shape — recovery-colored variant. |
| GET | `/home-service/v1/deep-dive/recovery/trends?date={date}` | 200 | 21,001 B `{sections}` — full recovery trends screen. |
| GET | `/home-service/v1/deep-dive/recovery?date={date}` | 200 | 4,655 B `{metadata, header, sections}` — recovery deep dive. The MCP wraps this as `whoop_recovery`. **Shape migrated May 2026** from GRAPHING_CARD tiles to `SCORE_GAUGE { id: "RECOVERY_SCORE_GAUGE" }` + `CONTRIBUTORS_TILE { id: "RECOVERY_CONTRIBUTORS_TILE" }` (with metrics for HRV / RHR / RESPIRATORY_RATE / SLEEP_PERFORMANCE / optional SPO2 / optional SKIN_TEMPERATURE). See [Pattern 2b](#pattern-2b-score_gauge--contributors_tile-may-2026-recovery--strain). |
| GET | `/home-service/v1/deep-dive/sleep/last-night?date={date}` | 200 | **848,428 B = 848 KB!** `{header_section, sub_header_section, sections}`. Full sleep stages + hypnogram + HR + HRV traces. The single biggest non-binary response in the API. The MCP wraps this as `whoop_sleep` and extracts ~500 B of clean data. |
| GET | `/home-service/v1/deep-dive/sleep/trends?date={date}` | 200 | 44,991 B `{sections}` — sleep trends. |
| GET | `/home-service/v1/deep-dive/sleep?date={date}` | 200 | 5,030 B `{metadata, header, sections}` — sleep summary (different from /last-night which is the wake-up recap). |
| GET | `/home-service/v1/deep-dive/strain/trends?date={date}` | 200 | 28,706 B `{sections}` — strain trends. |
| GET | `/home-service/v1/deep-dive/strain?date={date}` | 200 | 5,601 B `{metadata, header, sections}` — strain deep dive. Wrapped as `whoop_strain`. **Shape migrated May 2026** to `SCORE_GAUGE { id: "STRAIN_SCORE_GAUGE" }` + `CONTRIBUTORS_TILE { id: "STRAIN_CONTRIBUTORS_TILE" }` (metrics: HR_ZONES_1_3 / HR_ZONES_4_5 / STRENGTH_TRAINING_TIME / STEPS) + `ACTIVITY` items per workout. `calories`, `avg_hr_bpm`, `max_hr_bpm`, and per-zone granularity are no longer in this endpoint — fetch per-workout `/cardio-details` instead. |
| GET | `/home-service/v1/home?date={date}` | 200/401/None | 54,751 B `{metadata, header, pillars, day_one_transition}` — the full home payload. The biggest pillar is `OVERVIEW` containing `SCORE_GAUGE_STICKY` (with gauges for SLEEP, RECOVERY, STRAIN), a workout list, the journal home tile, and the weekly plan card. Wrapped as `whoop_today`. |
| GET | `/home-service/v1/tilt-view?date={date}` | 200 | **538,889 B = 539 KB!** `{graph, last_updated_timestamp, title, date_picker, analytics_metadata}` — the "tilt" landscape graph view (rotate your phone on a deep-dive screen for a wider chart). |
| GET | `/home-service/v1/widget/overview?widgetSize={SMALL,MEDIUM}` | 200/401/404 | 559 B `{strain_percentage_around, recovery_percentage_around, sleep_percentage_around, strain_string, strain_available, recovery_string, recovery_title, sleep_string, sleep_title, sleep_fill_style}` — iOS widget data. `widgetSize` enum: `SMALL, MEDIUM` (likely `LARGE` too). 404 when no data yet (fresh account). |
| GET | `/home-service/v2/home/dashboard/customize` | 200 | 7,186 B `{gauge_metrics, gauge_header, description, pinned_metrics_header, unpinned_metrics_header, pinned_metrics_section, unpinned_metrics_section, bottom_sheet_metrics}` — the dashboard customization screen. |

The **pillar** structure inside `/home?date=` is the canonical authoritative source for daily scores. Every pillar has:
- `type`: `OVERVIEW` (the only one we've seen — older versions had `RECOVERY, STRAIN, SLEEP`)
- `display_name`: same as type
- `sections`: array of typed UI sections

Inside the OVERVIEW pillar's sections, the `SCORE_GAUGE_STICKY` section contains:

```json
{
  "type": "SCORE_GAUGE_STICKY",
  "content": {
    "id": "SCORE_GAUGE_STICKY",
    "gauges": [
      {
        "title": "SLEEP",
        "id": "SLEEP_GAUGE_STICKY",
        "score_display": "83",
        "score_display_suffix": "%",
        "gauge_fill_percentage": 0.83,
        "progress_fill_style": "SLEEP",
        "destination": {"screen": "PILLAR_DEEP_DIVE", "parameters": {"pillar": "sleep", "date": "2026-05-23"}}
      },
      {
        "title": "RECOVERY",
        "score_display": "78",
        "score_display_suffix": "%",
        "progress_fill_style": "RECOVERY_HIGH"
      },
      {
        "title": "STRAIN",
        "score_display": "17.8",
        "score_display_suffix": null,
        "progress_fill_style": "STRAIN"
      }
    ]
  }
}
```

`progress_fill_style` encodes the recovery state band:
- `RECOVERY_HIGH` → GREEN (>=67%)
- `RECOVERY_MEDIUM` → YELLOW (34-66%)
- `RECOVERY_LOW` → RED (<34%)

The MCP's `projectToday` derives recovery state from this style, and `projectRecovery` derives it from the score band directly.

### hr-zones-service

Heart-rate zone configuration. Whoop computes default zones from max HR, but the user can override with custom ranges.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/hr-zones-service/v1/bff/zones` | 200/404 | 278 B `{zones, effective_timestamp, max_hr_entry_field}`. Returns 404 if not yet set. `zones` is an array of `{id, min, max}` for ZONE_1 through ZONE_5. `max_hr_entry_field` is a UI input field state with `value` (the user's max HR). |
| GET | `/hr-zones-service/v1/bff/settings` | 200 | 1,661 B `{screen_title, introduction, heart_rate_entry_row, default_hr_zones, manual_heart_rate_zones_form}`. The settings screen UI. |
| POST | `/hr-zones-service/v1/bff/custom` | 200 | Body: `{zones: [{max, id, min}], is_custom: true}`. Example: `{"zones":[{"max":186,"id":"ZONE_5","min":177},{"max":176,"id":"ZONE_4","min":164},{"max":163,"id":"ZONE_3","min":150},{"max":149,"id":"ZONE_2","min":137},{"max":136,"id":"ZONE_1","min":110}],"is_custom":true}`. Sets custom zones. Response 380 B `{zones, effective_timestamp, max_hr_entry_field}`. Zones must be exactly 5 entries. |
| POST | `/hr-zones-service/v1/maxhr` | 200 | Body: `{"max_heart_rate": 186}` — sets max HR, server auto-computes the 5 zones. |

Whoop's default zones formula appears to be percentage-of-max:
- Zone 1: 50-60%
- Zone 2: 60-70%
- Zone 3: 70-80%
- Zone 4: 80-90%
- Zone 5: 90-100%

When `is_custom: false`, the zones in the response are these percentages applied to the user's `max_heart_rate`. When `is_custom: true`, the zones are whatever the user set.

Wrapped as `whoop_hr_zones` + `whoop_hr_zones_set` (two modes: max_hr auto-zones or custom 5-zone array).

### integrations-bff

Third-party integrations: TrainingPeaks, Withings, Strava, etc. Most data is read-only (configuration screens for connecting/disconnecting); the actual data sync happens server-to-server.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/integrations-bff/v1/integrations/discovery` | 200 | 2,318 B `{integrations}` — list of available integrations. |
| GET | `/integrations-bff/v1/integrations/trainingpeaks/details` | 200 | 1,425 B `{id, reporting_key, background_image_url, icon_url, title_display, description_display, description_footnote, learn_more, connected, connected_status_display}`. |
| GET | `/integrations-bff/v1/integrations/withings/details` | 200 | 2,140 B same shape. |
| GET | `/integrations-bff/v1/integrations/{uuid}/details` | 200 | 1,819 B same shape — generic detail page for any integration. |

Strava lives separately under `/social-service/v1/strava/bff/settings`.

Not wrapped by the MCP — niche surface, and integrations are configured once and forgotten.

### journal-service

Three concurrent versions: v1 is the journal-enabled toggle, v2 is the data API (read entries + write entries + read catalog), v3 is the BFF for the editor screen + drafts + home tile + date picker.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/journal-service/v1/journals/preferences` | 200 | 111 B `{user_id, created_at, updated_at, journal_enabled}` — is the journal feature enabled. |
| PUT | `/journal-service/v1/journals/preferences` | 200 | Body: `{"journal_enabled": false}` — toggle journal on/off. |
| GET | `/journal-service/v2/journals/behaviors` | 200 | 66,646 B `{records, next_token}` — paginated catalog of all behaviors. The MCP's bundled `src/data/behaviors.ts` was built from this. |
| GET | `/journal-service/v2/journals/behaviors/user/{date}` | 200 | 13,156 B `array[16]` — the tracked-behaviors catalog the user has enabled for that date. **NOT the actual journal entries for the date**, despite the misleading path. The actual entries are at v3 drafts. |
| PUT | `/journal-service/v2/journals/entries/user/date/{date}` | 204 | Body: `{notes, tracker_inputs}`. `tracker_inputs` is an array of `{behavior_tracker_id, [answered_yes], [magnitude_input_label], [magnitude_input_value]}` objects. The body in the captures had 200+ entries — every tracked behavior for the date. |
| GET | `/journal-service/v3/journals/behaviors` | 200 | 73,571 B `{categories, title, grouped_toggles, current_category, button_title, confirmation_modal, search_title}` — BFF for the journal editor screen. The `grouped_toggles[0].toggles[]` array has every behavior with `destination.parameters.detail_id` UUIDs that reference behavior-impact endpoints. |
| GET | `/journal-service/v3/journals/date-picker/{date}` | 200 | 2,637 B `{items, left_calendar_display_icon, right_calendar_display_icon, today_cta, today_date}` — the date picker shown above the journal editor. |
| GET | `/journal-service/v3/journals/drafts/mobile/{date}` | 200 | 821 B `{integrations, journal: {tracked_behaviors[], user_id, cycle_id, journal_entry_id, notes, user_reviewed}, metadata, experiment_variant}` — auto-saved draft. **This is the authoritative endpoint for "what did the user log on this date".** |
| GET | `/journal-service/v3/journals/home-tile?date={date}` | 200 | 1,848 B `{tile}` — the journal card on the home tab. |

#### Tracker input shapes (4 variants)

Inside the `tracker_inputs` array, each entry has one of four shapes depending on the behavior's input type:

**Bare (just marked as "yes I did this"):**
```json
{"behavior_tracker_id": 80}
```

**Yes/no boolean:**
```json
{"behavior_tracker_id": 271, "answered_yes": true}
{"behavior_tracker_id": 43, "answered_yes": false}
```

**Magnitude (numeric value with a label):**
```json
{"behavior_tracker_id": 274, "answered_yes": true, "magnitude_input_label": "22", "magnitude_input_value": 22}
```

**Magnitude (with custom label):**
```json
{"behavior_tracker_id": 145, "magnitude_input_value": 1800, "magnitude_input_label": "1800 cal"}
```

The MCP's `whoop_journal_log` constructs `tracker_inputs` based on which input fields the caller provides:
- `{behavior_tracker_id}` alone → bare
- `{behavior_tracker_id, answered_yes}` → boolean
- `{behavior_tracker_id, magnitude_value, magnitude_label?}` → magnitude

### member-data-export-service

GDPR / CCPA data export.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/member-data-export-service/v1/member-data-export-details` | 200 | 461 B `{state, help_link_text_display, help_link, export_unavailable_section_icon, export_unavailable_section_headline_display, export_unavailable_section_body_display, screen_title_display, headline_display, body_display}` — the data export UI. The `state` field encodes "is an export currently being processed". |

Not wrapped. Triggering the actual export probably requires a separate POST that wasn't captured.

### membership + membership-service

Membership / billing / strap pairing / referrals. Sprawling — 34 ops + 8 on the bare `/membership` path.

#### Bare /membership

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/membership?useReplica={bool}` | 200/428/OPTIONS | 740 B `{userId, membershipStatus, expirationDate, canceledAt, cancelAtPeriodEnd, canUpgrade, nextBillDate, nextBillAmount, cardDigits, cardType}` — legacy bare membership endpoint. `useReplica` query param routes the read to a replica DB. 428 was seen once with `{code, message}` — likely missing an `If-Match` precondition header. |
| GET | `/membership/accessories/shop/auth` | 200/401 | 1,409 B `{url, title, subtitle}` — SSO URL for the accessories shop. 401 in some captures from token expiry race. |
| OPTIONS | `/membership/referrals` | 204 | CORS preflight (suggests this endpoint is called from in-app web views). |
| POST | `/membership/referrals` | 200 | Body: `{"source": "billing"}` → 167 B `{code, message, url}` — generates a referral link. |

#### /membership-service/v0

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/membership-service/v0/onboarding/info?flow=create-account&strapSerial={serial}&strapSignature={hash}` | 200 | 268 B `{require_credit_card, require_team_code, show_annual_upsell, family_plan, active_family_plan, paired_text_override, num_trial_months, strap_membership_status, membership_tier_type, is_used_strap}` — first call during signup after the user pairs a strap. `strapSerial` example: `5BG0021577`. `strapSignature` is a base64'd cryptographic signature proving the user has physical possession of the strap. |

#### /membership-service/v1 (16 endpoints)

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/billing/info` | 200/401/OPTIONS | 163 B billing summary |
| GET | `/billing/payment_method` | 200/401 | 148 B `array[1]` — card on file |
| GET | `/billing/whoop-pro/info` | 200/OPTIONS | 172 B Whoop Pro tier info |
| GET | `/family-plans-native/hub` | 200 | 3,150 B family plan management hub |
| GET | `/gift-content` | 200 | 812 B gift-membership content |
| GET | `/membership-management` | 200 | 3,120 B management screen |
| GET | `/membership-management/membership-and-billing` | 200 | 4,216 B same-ish |
| POST | `/membership-management/resume` | 204 | Body: `{billing_postal_code:null, payload:{sku, new_tier, promo_code}, payment_method_id:null, use_default_tax:false, promo_code:null}` — resume a canceled membership |
| GET | `/membership/native-account-header` | 400 | Feature gating issue — returns 400 even on healthy accounts |
| GET | `/membership?useReplica=true` | 200/OPTIONS | 676 B `{account_id, email, status, checkout_origin, customer_token, card_id, card_brand, card_last4, card_exp_month, card_exp_year}` — newer membership detail with payment method |
| GET | `/payment/public-stripe-key` | 200/401/404 | Stripe publishable key |
| GET | `/refer-a-friend/menu` | 200/401 | 1,033 B `{section_header, items}` |
| GET | `/straps` | 200/401 | 169 B `{last_seen_strap, ordered_strap, previous_straps}` |

#### /membership-service/v2

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/in-app-banners` | 200/401 | 1,896 B `{banners, overlay_card}` |
| GET | `/refer-a-friend/community` | 200 | 767 B `{header, header_style, items}` |
| GET | `/referral-content?source={Individual,Team}` | 200 | 204-402 B `{share_sheet_content, banner_content, raf_menu_item, raf_hub_content}`. `source` enum: `Individual, Team`. |
| GET | `/straps/pairing-adjustment?strapSerial={serial}&strapSignature={hash}` | 404 | Empty — checks if a paired strap needs alignment |
| POST | `/straps/pairing-adjustment` | 204 | Body: `{strap_signature, strap_serial}` |
| GET | `/upcycle/onboarding/finalizedContent` | 200 | 1,921 B upcycle (returning member) onboarding content |

#### /membership-service/v3

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/billing/info?useReplica=false` | 200/OPTIONS | 1,006 B `{next_bill_promo_amount_off, base_membership, add_ons}` — newest billing detail |

Not wrapped by the MCP except the membership field in `whoop_profile` (which pulls from bootstrap). Billing operations don't make sense via Claude.

### metrics-service

Pure telemetry. Sensor data and processing-cursor management.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/metrics-service/v1/consumerstats/mobile/highwatermark/min` | 200 | 40 B `{latestMetricsProcessed}` — the last processed cursor. |
| POST | `/metrics-service/v1/metrics` | 200/400/401 | **Binary protobuf body.** ~30-70 KB per upload. The captures show repeated invocations every few seconds during active recording. Body content (visualized): timestamped frames containing accelerometer XYZ floats, PPG samples, HR samples, with frame headers. The full schema would need protobuf reverse-engineering. |

The dedup snapshot has 20 unique copies of `/metrics`. Each unique body signature represents one captured snapshot of sensor data. Skipped by the MCP entirely — this is the firehose, not an API surface.

### notification-service

Push notification preferences + event tracking.

| Method | Path | Status | Notes |
|---|---|---|---|
| POST | `/notification-service/v1/notifications/events` | 200 | Body: `{notification_status: "OPENED", notification_type: "RefreshCoordinatorTrigger", source_id: "<uuid>"}`. Event-tracking endpoint for push-notification open/dismiss analytics. `notification_status` enum: `OPENED` observed. Others likely: `DISMISSED, RECEIVED, IGNORED`. `notification_type` enum: `RefreshCoordinatorTrigger` observed. |
| GET | `/notification-service/v1/notifications/user-settings/bff` | 200 | 437 B `{title, settings}` — the notification settings UI. |
| PUT | `/notification-service/v1/notifications/user-settings/block/namespace` | 200 | Body: `{"namespace": "StressSummary"}` — blocks notifications in a category. Response: `{user_id, blocked_namespaces}`. |
| DELETE | `/notification-service/v1/notifications/user-settings/block/namespace/{namespace}` | 200 | Unblocks. Namespaces seen: `GPS, StressSummary`. |

Not wrapped.

### onboarding-service

New-user flow — strap pairing, signup, profile setup, entitlement provisioning, feature-education tracking, overlay state.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/onboarding-service/v1/account/activate` | 200 | 17,519 B `{items, event_properties, experiment_properties}` — the onboarding step list |
| POST | `/onboarding-service/v1/account/activate` | 200 | Body: `{consents_accepted, marketing_opt_in, recommendation_opt_in, stripe_token, zip_code}`. Real example: `{"recommendation_opt_in":false,"zip_code":"95124","stripe_token":"tok_1TamGCHLc4GztXOmcneSQVRT","consents_accepted":true,"marketing_opt_in":false}`. Response 19 B `{subscribed}`. |
| GET | `/onboarding-service/v1/account/device-education` | 200 | 2,753 B strap usage tutorial |
| PUT | `/onboarding-service/v1/account/profile` | 200 | Body: `{birthday, gender, height, physiological_baseline, timezone_offset, unit_system, weight}`. Example: `{"height":71, "unit_system":"imperial", "timezone_offset":"-0700", "gender":"male", "weight":163, "physiological_baseline":"male", "birthday":"1994-02-09"}`. **Note: height is in INCHES (71 = 5'11") and weight in pounds for the v1 onboarding endpoint, even with `unit_system:"imperial"`. The profile-service PUT uses METERS and KG. Whoop is inconsistent.** |
| PUT | `/onboarding-service/v1/account/sign-up` | 204 | Body: `{admin_division, country, first_name, last_name, timezone_offset, username}`. Example: `{"last_name":"Carr","timezone_offset":"-0700","country":"US","username":"testuser2","first_name":"Josh","admin_division":"CA"}`. |
| GET | `/onboarding-service/v1/account/start-auth?fromLogin=true` | 200 | 36,947 B `{start_state, activation_bff}` — start of auth flow when already logged in |
| GET | `/onboarding-service/v1/account/start?email={email}&fromLogin=false` | 200 | 37,880 B same — anonymous start with email hint |
| GET | `/onboarding-service/v1/app/destination` | 200 | 33 B `{screen, parameters}` — where the app should navigate after launch |
| GET | `/onboarding-service/v1/feature-education-state?userId={id}` | 200 | 15,086 B with top-level keys that are feature names: `SEGMENTAL_BODY_COMPOSITION_EDUCATION, WHOOP 4.0 Feature: Sleep Coach with Haptic Alerts, DATA_STREAK_MILESTONE_UNLOCK_EDUCATION, Podcast 165: Dr. Shon Rowan on Pregnancy Exercise & HRV Study, METABOLIC_HEALTH, SLEEP, New WHOOP Feature: Menstrual Cycle Coaching, OVERLAY_HEALTH_TAB, ADVANCED_LABS_LH_CYCLE_RANGES, PREGNANCY_STORY`. The structure of each key's value indicates whether the user has dismissed the education modal. |
| PUT | `/onboarding-service/v1/feature-education-state?userId={id}` | 200 | Body: `{"feature_education_id": 379, "completed": true}` — marks a feature-education as completed. IDs seen: `379, 39999`. |
| GET | `/onboarding-service/v1/features/educations/onboarding/PAIRING_MODE_EDUCATION` | 200 | 15,710 B `{id, screens, created_at, updated_at, media_header, sticky_button, name, feature, enabled, deleted}` — the strap-pairing education content. |
| GET | `/onboarding-service/v1/features/educations/{education_name}` | 200 | 40,991 B same shape — generic education lookup. |
| GET | `/onboarding-service/v1/learn-more-carousel/bff/community?zoneId=America/Los_Angeles&cta=MORE` | 404 | Not available for this user's locale. |
| GET | `/onboarding-service/v1/overlay/all` | 200 | 15,586 B top-level keys are overlay names: `OVERLAY_HOME_DEEP_DIVES_STRAIN, OVERLAY_ACTIVITY_DETAILS_MSK_YOGA, OVERLAY_HEALTH_TAB, HEALTHSPAN_LABS_INTRODUCTION, OVERLAY_EXERCISE_PROGRESS, OVERLAY_ACTIVITY_DETAILS_MSK_BARRE, OVERLAY_STRENGTH_BUILDER_LIVE_SESSION, OVERLAY_HOME_DEEP_DIVES_SLEEP, OVERLAY_ACTIVITY_DETAILS_MSK_PILATES, OVERLAY_STRENGTH_BUILDER_WORKOUT_BUILDER` — the library of teach-me overlay screens. |
| GET | `/onboarding-service/v1/what-to-expect` | 200 | 16,134 B `{toolbar_title, title, subtitle, daily_progress, progress_indicator, items}` |
| GET | `/onboarding-service/v1/what-to-expect/entry-point` | 200/401 | 89 B `{title, body, icon, cta_location}` |
| POST | `/onboarding-service/v2/emails/check` | 200 | Body: `{"email_address": "you@example.com"}` → 33 B `{valid, dialog_info}` — check if an email is already registered. |

Not wrapped — onboarding is one-shot per account.

### privacy-service

Privacy / sharing preferences. Note that this is **split between two services** — privacy-service handles `searchable, mutual_community_sharing, allow_recommendation` and users-service handles the actual `searchable + mutual_community_sharing` PUT.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/privacy-service/v1/user_privacy_settings/` | 200 | 79 B `{searchable, mutual_community_sharing, allow_recommendation}`. **Note the trailing slash on the path!** Without it, the endpoint returns a different response. |
| PUT | `/privacy-service/v1/user_privacy_settings/allow-recommendation` | 200 | Body: `{"allow_recommendation": false}` — granular per-flag PUT. |

The matching PUT endpoints for `searchable` and `mutual_community_sharing` weren't captured, but the convention is clear (`/user_privacy_settings/searchable` and `/user_privacy_settings/mutual-community-sharing`). The users-service `/users/{id}/privacy` PUT handles `searchable` and `mutual_community_sharing` together.

Not wrapped.

### profile-service

User profile CRUD. Avatar upload + bio data + identity fields.

| Method | Path | Status | Notes |
|---|---|---|---|
| PUT | `/profile-service/v1/profile` | 200/400 | Body: 6 distinct shapes observed (different field combinations included). Example with everything: `{"email":"test2@example.com","height":1.777999997138977,"country":"US","birthday":"1997-02-09","state":"AL","weight":70.76040649414062,"city":"San Jose","first_name":"Joshhh","gender":"FEMALE","last_name":"Carr","physiological_baseline":"MALE","unit_system":"imperial"}`. **height and weight here are in METERS and KG** regardless of `unit_system` (which is just a display preference). 400 was seen when `country:"AS"` was sent with `state:"AL"` — invalid combination. The `gender` and `physiological_baseline` MUST be uppercase (MALE/FEMALE/NON_BINARY/PREFER_NOT) even though the bootstrap GET returns lowercase. **Birthday MUST be YYYY-MM-DD** — full ISO timestamps return 400 "Valid birthday (YYYY-MM-DD) is required". Partial PUTs with too few fields return 422 — Whoop expects a near-complete profile body. |
| PUT | `/profile-service/v1/profile/avatar` | 200 | **Raw PNG body** (~100 KB). The PNG magic bytes (`\x89PNG\r\n\x1a\n`) are sent as the body with `content-type: image/png`. Returns the updated profile. One of two endpoints in the entire API that doesn't use JSON (the other is community create, which is multipart). |
| GET | `/profile-service/v1/profile/bff` | 200 | 23,671 B `{profile_metadata, sections}` — Profile tab UI. |
| GET | `/profile-service/v1/profile/bff/edit` | 200 | 36,335 B `{avatar_url, first_name, last_name, username, email, city, country, state, member_since, age}` — Edit Profile screen. |

The MCP wraps `whoop_profile_update` which auto-trims birthday and accepts a near-complete body. The avatar PUT is not wrapped (no good way to pass a PNG via chat).

### progression-service

Strength Trainer exercise progressions + the weekly plan goal system.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/progression-service/v2/weekly-plan/home-tile/{date}` | 200 | 2,880 B `{tile}` — the weekly plan card on the home tab. |
| GET | `/progression-service/v2/weekly-plan/setup?screens=STRENGTH_TRAINING_TIME&editing=true` | 200 | 1,268 B `{plan_id, screens}` — plan setup screen. `screens` query param is the screen sequence to show. |
| PUT | `/progression-service/v2/weekly-plan/{uuid}/goal/target` | 204 | Body: `{"type": "STRENGTH_TRAINING_TIME", "target": 360}` — set a weekly goal target in minutes. `type` enum observed: `STRENGTH_TRAINING_TIME`. Inferred others: `WORKOUT_FREQUENCY, SLEEP_HOURS, RECOVERY_DAYS`. |
| GET | `/progression-service/v3/exercise/{exercise_id}?endDate={date}` | 200 | 10,412 B `{id, time_segments, segment_controller}` — single exercise progression with per-window data. Uses the same time_segments / named_segments hybrid shape as the trend endpoint. |
| GET | `/progression-service/v3/exercise?endDate={date}` | 200 | 24,913 B same shape — all exercises in one call. |
| GET | `/progression-service/v3/trends/{metric}?endDate={date}` | 200 | 118,399 B `{metadata, header_name_display, segment_controller, integrations_upsell, week_time_segment, month_time_segment, six_month_time_segment, no_data_name_display, no_data_subtext_name_display, metric_education}` — generic trends endpoint. `{metric}` is the 25-value enum (HRV, RHR, RECOVERY, ...). |

The MCP wraps `whoop_trend` (the 25-metric trend), `whoop_lift_progression` (single exercise), `whoop_weekly_plan` (was in v1 but cut from v2).

#### The metrics + segment shape

Both trend and progression endpoints have the same structural quirk that took the MCP three iterations to handle correctly:

**Top-level keys can be EITHER:**
- A flat `time_segments: [seg1, seg2, seg3]` array (older endpoints)
- Or named keys: `week_time_segment, month_time_segment, six_month_time_segment, year_time_segment`

**Each segment has:**
```json
{
  "date_picker": {"current_date_range_display": "May 17-23", "next_date_time": "...", "previous_date_time": "..."},
  "metrics": [
    {
      "trend_key": "HRV",
      "metric_name_display": "AVERAGE",
      "metric_value_display": "35",
      "metric_units_display": "ms",
      "trend_direction": "DOWN",
      "trend_style": "NEGATIVE",
      "trend_text_display": "10% vs. prior week",
      "current_metric_value": 35,
      "previous_metric_value": 39,
      "metric_change": -10
    }
  ],
  "graph": {"plots": [{"plot": {"segments": [{"points": [...]}]}}], ...},
  "vow": {...},
  "is_hidden": false
}
```

**Critical:** `metrics` is an **array**, not an object. The MCP originally treated it as `metrics.avg`, which failed silently because there's no `avg` key on an array. The fix: read `metrics[0].current_metric_value`.

Also: every point's `data_scrubber_details.value` is null. The numeric value is in `value_display` (string). Need to parse the string.

### research-service

Research opt-in studies — Whoop runs scientific studies that members can participate in.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/research-service/research-bff-service/v1/campaigns` | 200 | 3,373 B `{page_title_display, page_description_display, page_header_title, page_header_body, empty_state_text, campaign_sections, footer_text_display, footer_carousel}` — list of open research campaigns. |

The path has a redundant double-segment: `/research-service/research-bff-service/...`. This is because the outer path is the routing prefix and the inner is the actual BFF service name.

Not wrapped.

### sleep-service

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/sleep-service/v1/heart-rate/baseline` | 200 | Response body wasn't captured (mitm lost it). Likely returns `{sleeping_hr_baseline}` — the sleeping HR baseline value. |

The bulk of sleep data is served via `/home-service/v1/deep-dive/sleep/*`. This endpoint is a one-field utility lookup.

### smart-alarm-bff + smart-alarm-service

Smart Alarm CRUD. Two-layer architecture: `-bff` for the schedule UI, `-service` for global preferences + the strap event log.

#### smart-alarm-bff (v1)

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/smart-alarm-bff/v1/schedule/all` | 200 | 1,745 B `{all_alarm_schedule_label_display, alarm_schedule_list, alarm_schedule_footer, schedule_button_component, schedule_enabled, should_show_overlay, schedule_disabled_text, deleting_in_progress_modal, deleting_success_modal, delete_error_modal}` — schedule list page. |
| GET | `/smart-alarm-bff/v1/schedule/components/populated/{uuid}` | 200 | 4,013 B `{repeat_days, wake_mode, wake_time, sleep_goal, schedule_save_success_modal, schedule_saving_modal, schedule_save_error_modal}` — single schedule slot. |
| PUT | `/smart-alarm-bff/v1/schedule/{uuid}` | 200 | Body: `{alarm_mode, day_of_week_list, enabled, latest_wake_time, sleep_goal, time_zone_offset}`. Example: `{"sleep_goal":"","day_of_week_list":["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"],"time_zone_offset":"-0700","enabled":true,"latest_wake_time":"07:30:00","alarm_mode":"IN_THE_GREEN"}`. `alarm_mode` enum: `IN_THE_GREEN, EXACT_TIME_PEAK, EXACT_TIME_OPTIMIZE_SLEEP`. |

#### smart-alarm-service (v1)

| Method | Path | Status | Notes |
|---|---|---|---|
| PUT | `/smart-alarm-service/v1/alarm-schedule/disable` | 204 | No body — master disable for all schedules. |
| PUT | `/smart-alarm-service/v1/alarm-schedule/enable` | 204 | No body — master enable. |
| GET | `/smart-alarm-service/v1/smartalarm/preferences` | 200 | 601 B `{lower_time_bound, recovery_score_goal, sleep_score_goal, weekly_plan_goal, weekly_plan_sleep_hours_goal_in_minutes, weekly_plan_sleep_hours_goal, weekly_plan_goal_info, alarm_bounds, last_triggered_at, created_at}`. Note: `alarm_bounds` nests `{goal, upper, lower, enabled}` — the upper time bound + goal mode are NOT at top level. |
| PUT | `/smart-alarm-service/v1/smartalarm/preferences` | 200 | Body: `{default, enabled, goal, lower_time_bound, schedule_enabled, time_zone_offset, upper_time_bound, weekly_plan_goal}`. Two shapes observed — full and partial. `goal` enum: `EXACT_TIME_PEAK, EXACT_TIME_OPTIMIZE_SLEEP, IN_THE_GREEN`. |
| POST | `/smart-alarm-service/v1/smartalarm/wbl` | 204/401 | "WBL" = wake-by-log. Body: array of events `{timestamp, event_type, mobile_event_metadata}`. `event_type` enum: `PHONE_DISABLED_ALARM, PHONE_SET_ALARM_TIME, STRAP_DRIVEN_ALARM_SET`. `mobile_event_metadata` includes `strap_id, firmware_maxim_version, nordic_version, device_platform, device_os, device_model, is_strap_connected, is_using_battery_optimizers, is_ack_success`. |
| PUT | `/smart-alarm-service/v1/strap-status` | 200 | Body: `{"strap_driven_alarm_time": "2026-05-25T07:30:00.000-0700"}` — pushes the alarm time to the strap firmware. The iOS app does this on a delay after a schedule edit. |

The MCP wraps `whoop_smart_alarm` (read) + `whoop_smart_alarm_set` (write) with 4 modes (schedule / preferences / master_enable / master_disable). The strap-status push is NOT wrapped — the strap will pick up changes when the iOS app next syncs.

### social-service

Strava integration settings.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/social-service/v1/strava/bff/settings` | 200 | 1,749 B `{state, learn_more_display, learn_more_url, learn_more_icon, privacy_policy_display, privacy_policy_url, web_authorization_url, app_authorization_url, background_image_url, icon_url}` — Strava integration settings screen. The `state` indicates whether Strava is connected. |

Not wrapped.

### strap-location-service

Where on the body the strap is worn — wrist, bicep, calf, etc. Affects HR signal quality and metric thresholds.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/strap-location-service/v1/garment` | 200/401 | 2,791 B `array[12]` — list of supported garments (different bicep band variants, ankle band, the underwear variant, etc). Each entry has a name and image URL. |

Not wrapped.

### streaks-service

Data streaks (consecutive days of valid data).

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/streaks-service/v1/bff/streaks/data-streak` | 200 | 3,074 B `{title, celebration_media, lottie_url, image_url, today_streak_state, streak_value, title_subtitle, streak_subtitle, items, header_icon}` — data-streak detail screen. `today_streak_state` is one of `ACTIVE, MISSED, FROZEN, GRACE_PERIOD`. `streak_value` is the integer current streak length. `lottie_url` points to a Lottie animation JSON for the celebration overlay. |
| GET | `/streaks-service/v1/streaks/data-streak` | 200 | 308 B `{streak_value, streak_state, lottie_url, image_url, navigation, animation_accent_color, celebration_overlay}` — small streak widget for the home tab. |

The MCP previously wrapped `whoop_progress` (streaks + achievements); cut from v2.

### users-service

User-level settings, preferences, hidden metrics, stealth mode, and the bootstrap call.

#### v0

| Method | Path | Status | Notes |
|---|---|---|---|
| PATCH | `/users-service/v0/users/preference` | 200 | Body: `{"autoDetectWorkout": false}`. Response 502 B `{userId, autoDetectSleep, autoClassifyWorkout, autoDetectWorkout, computeDayStrain, performanceOptimizationAssessment, performanceOptimizationDayOfWeek, cyclesBetaTester, sleepCoachV2, user_id}`. **Note: the response has BOTH `userId` AND `user_id`** — an API bug. |

#### v1 (8 endpoints)

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/users-service/v1/goals/user/motivation` | 404 | Returns 404 if the user hasn't set a motivation goal. |
| GET | `/users-service/v1/hidden-metrics/{METRIC}` | 200 | 19 B `{is_hidden}`. Metrics seen: `BODY_COMP, HEALTHSPAN`. |
| POST | `/users-service/v1/hidden-metrics/{METRIC}` | 204 | Hide the metric. No body. |
| DELETE | `/users-service/v1/hidden-metrics/{METRIC}` | 204 | Unhide. |
| GET | `/users-service/v1/stealth-mode` | 200 | Empty body. **You cannot read the current state of stealth mode** via this endpoint — Whoop returns 200 with no payload. The user can set it but not read it (UI just doesn't show a state indicator). The MCP defaults to `stealth_mode: false` in `whoop_profile` as a result. |
| PUT | `/users-service/v1/stealth-mode` | 200 | Body: `{"enabled": true}`. |
| POST | `/users-service/v1/users/check/username` | 200 | Body: `{"username":"testuser2", "strap_serial":"5BG0021577", "strap_signature":"<hash>"}` — username availability check (signup only). The strap signature gates this so anonymous probes can't enumerate usernames. |
| POST | `/users-service/v1/users/preferences/time` | 200 | Body: `{"clock_format":"TWELVE_HOUR_FORMAT", "timezone":"America/Los_Angeles", "current_time":"2026-05-24T02:47:33.635+0000"}` → 218 B response. `clock_format` enum: `TWELVE_HOUR_FORMAT, TWENTY_FOUR_HOUR_FORMAT`. |
| PUT | `/users-service/v1/users/profile/offset` | 204 | Body: `{"timezone_offset": "-0700"}` — update the user's timezone offset. |
| GET | `/users-service/v1/users/{id}/preference` | 200 | 102 B `{user_id, auto_detect_sleep, auto_detect_workout, auto_classify_workout}` — read-only summary (subset of the v0 PATCH response). |
| PUT | `/users-service/v1/users/{id}/privacy` | 200 | Body: `{"mutual_community_sharing":false, "searchable":true}` → 155 B response with `{user_id, deleted, created_at, updated_at, searchable, mutual_community_sharing}`. |

#### v2

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/users-service/v2/bootstrap` | 200/401 | 1,209 B `{account, user, staff, teams, profile, membership, bio_data}` — **THE primary post-login bootstrap call.** Hit on every app start. Returns everything needed to render the initial state. |
| GET | `/users-service/v2/bootstrap/account` | 200 | 319 B `{id, username, email, type, can_upload_data, deidentified, concealed, disabled, tos_accepted, created_at}` — just the account sub-block. |
| OPTIONS | `/users-service/v2/bootstrap/account` | 200 | CORS preflight. |
| GET | `/users-service/v2/bootstrap/membership` | 200 | 38 B `{status, in_effect}` — just the membership sub-block. |
| OPTIONS | `/users-service/v2/bootstrap/membership` | 200 | CORS. |
| GET | `/users-service/v2/bootstrap/user` | 200 | 345 B `{id, first_name, last_name, country, created_at, updated_at, avatar_url, city, admin_division}` — just the user sub-block. |
| OPTIONS | `/users-service/v2/bootstrap/user` | 200 | CORS. |

The MCP wraps `whoop_profile` (composite over bootstrap + hidden-metrics + stealth), `whoop_hidden_metric` (write toggle), and `whoop_profile_update` (full PUT).

### vow-service

The "Vow" system rewrites structured data into narrative coach text. It's how Whoop's coach takes "you slept 7h 24m / your need was 8h 23m" and turns it into "You came up short on sleep last night. Try to get to bed an hour earlier tonight to make up for it."

| Method | Path | Status | Notes |
|---|---|---|---|
| POST | `/vow-service/v1/coaching/vows/sleepcoach?format=TWELVE_HOUR` | 200 | Body is the **entire `/coaching-service/v2/sleepneed` payload** echoed back as input. Response 132-136 B: `{header, key, text}` — a short narrative string. `format=TWELVE_HOUR` is a query param affecting time formatting in the response. |

Two distinct call shapes observed — one with `need_breakdown` for a heavy strain day (8h debt + 1h strain need), one for a normal day (8h baseline, 1m strain). The text comes back different.

Not wrapped — the MCP returns the structured sleep need data via `whoop_sleep_need` and lets Claude write its own narrative.

### weightlifting-service

The Strength Trainer. Exercise catalog, workout templates, workout logs, PRs.

#### v1 — Exercise lookup

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/weightlifting-service/v1/exercise/{exercise_id}` | 200 | 1,013 B `{training_types, instructions, muscle_groups, translated_muscle_groups, created_at, updated_at, custom_exercise_info, volume_input_value, volume_input_units, exercise_id}` — single exercise lookup. Exercise IDs are upper-snake-case with special characters preserved: `BENCHPRESS_BARBELL, ARNOLDPRESS_DUMBBELL, ASSISTED_PULL_UPS_(BAND), BAR-FACING_BURPEES_(LATERAL), BB_SOTS_PRESS`. |

#### v2 — Catalog + writes

| Method | Path | Status | Notes |
|---|---|---|---|
| POST | `/weightlifting-service/v2/custom-exercise` | 200 | Create a custom exercise. Body shape detailed below. |
| GET | `/weightlifting-service/v2/exercise` | 200 | **385 KB** — the entire exercise catalog. `{exercises, filter_options}`. 383 entries total (after dedup; 372 official + 11 custom-test exercises that leaked into the global catalog). The MCP's bundled `src/data/exercises.ts` was built from this, filtered to `custom_exercise: false`. |
| POST | `/weightlifting-service/v2/weightlifting-workout/activity` | 200 | Log a finished workout. Body shape detailed below. |
| GET | `/weightlifting-service/v2/workout-template/{id}` | 200 | 10,693 B `{parent_template_key, workout_template_key, name, workout_groups, is_draft, source}` — single template. |

#### v3 — BFF (PRs, library, exercise detail screens)

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/weightlifting-service/v3/exercise/{exercise_id}` | 200 | 3,506 B `{header, content, empty_state_card, metadata}` — exercise detail page. |
| GET | `/weightlifting-service/v3/exercise/{exercise_id}/exercise_history` | 200 | 9,812 B `{id, items, show_more, analytics_action}` — recent sessions for this exercise. |
| GET | `/weightlifting-service/v3/exercise/{exercise_id}/personal_records` | 200 | 6,858 B `{id, items, show_more, analytics_action}` — PR sessions for this exercise. |
| GET | `/weightlifting-service/v3/prs` | 200 | 10,463 B `{tiles, show_more, next_exercise_offset, next_end_date, next_start_date}` — all PRs across all exercises. Each tile has the exercise metadata + the PR value. |
| GET | `/weightlifting-service/v3/prs?startDate=&endDate=&offset=` | 200 | 10,633 B same shape with paging. |
| GET | `/weightlifting-service/v3/workout-library` | 200 | 16,790 B `{workout_library_title, whoop_workouts_title, my_workouts_title, my_workouts_ctatext, whoop_workouts_list, my_workouts_list, my_workouts_empty_state, my_progress, my_workouts_header_items, metadata}` — template library. `my_workouts_list` is user-saved templates, `whoop_workouts_list` is Whoop-provided ones. |
| POST | `/weightlifting-service/v3/workout-template` | 200 | Create or save-as template. Two body shapes: (a) `{name, workout_groups}` for new, (b) `{name, workout_groups, workout_template_key}` for save-as-existing. Response 7,502 B or up to ~425 KB depending on size. |

#### Custom exercise create body

```json
{
  "laterality": "BILATERAL",
  "exercise_type": "POWER",
  "trackable": false,
  "volume_input_format": "TIME",
  "exercise_id": "A7B422DC-DDAA-4D5D-AB9B-3ED7E1E7813F",
  "movement_pattern": "OTHER",
  "training_types": ["POWER"],
  "equipment": "MACHINE",
  "updated_at": "",
  "custom_exercise_info": {
    "linked_exercise": {
      "image_url": "https://dh6o7n168ts9.cloudfront.net/exercises/ASSAULT_AIRBIKE.jpg",
      "name": "Assault Bike",
      "exercise_id": "ASSAULT_AIRBIKE"
    }
  },
  "push_core_name": "ASSAULT_AIRBIKE",
  "instructions": ["aonnnc"],
  "name": "sonnn",
  "muscle_groups": ["SHOULDERS"],
  "created_at": ""
}
```

**Note:** `exercise_id` is client-generated as a UUID. The MCP uses `randomUUID().toUpperCase()`.

**Enums:**
- `laterality`: `BILATERAL, UNILATERAL_LEFT, UNILATERAL_RIGHT, ALTERNATING`
- `exercise_type`: `STRENGTH, POWER`
- `volume_input_format`: `REPS, TIME, WEIGHT`
- `movement_pattern`: `SQUAT, HINGE, HORIZONTAL_PRESS, VERTICAL_PRESS, HORIZONTAL_PULL, VERTICAL_PULL, LUNGE, OLYMPIC_LIFT, JUMP, OTHER`
- `training_types`: array of `STRENGTH, POWER, ENDURANCE, HYPERTROPHY` (typically just `[exercise_type]`)
- `equipment`: `MACHINE, DUMBBELL, BARBELL, BODY, OTHER, KETTLEBELL`
- `muscle_groups`: array of `CHEST, BACK, LEGS, ARMS, SHOULDERS, CORE, GLUTES, HAMSTRINGS, QUADS, CALVES, FULL_BODY`

#### Workout log body (the big one)

The captured body is 457 KB. Abridged structure:

```json
{
  "scaled_msk_strain_score": 0,
  "msk_total_volume_kg": 0,
  "msk_intensity_percent": 0,
  "during": "['2026-05-25T02:00:22.478Z','2026-05-25T02:02:50.050Z')",
  "raw_msk_strain_score": 0,
  "workout_groups": [
    {
      "workout_exercises": [
        {
          "sets": [
            {
              "during": "['2026-05-25T02:00:23.240Z','2026-05-25T02:00:23.380Z')",
              "msk_total_volume_kg": 0,
              "strap_location_laterality": "LEFT",
              "weight": 15,
              "strap_location": "1",
              "weightlifting_workout_set_id": "<UUID>",
              "number_of_reps": 2,
              "time_in_seconds": 22
            }
          ],
          "exercise_details": { /* full exercise object including image_url, video_url, instructions, created_at, updated_at */ }
        }
      ]
    }
  ]
}
```

**Critical details:**

- `during` is a **PostgreSQL range literal** with half-open interval syntax: `'[start_iso,end_iso)'`. Single quotes around the ISO timestamps inside square/round brackets.
- `workout_groups[]` is an array of supersets. Each contains an `workout_exercises[]` array of single exercises. Each contains a `sets[]` array.
- `workout_groups[].workout_exercises[].exercise_details` is the **full denormalized exercise** from the catalog. The MCP's `build_lift_body.ts` populates this from `EXERCISES_BY_ID`. **`created_at` and `updated_at` must be non-empty ISO timestamps** or the endpoint returns 422 silently (no error body).
- Each set has a client-generated `weightlifting_workout_set_id` UUID.
- `strap_location` is `"1"` for wrist, `"2"` for bicep, etc. (encoded as string).
- `strap_location_laterality` is `"LEFT" | "RIGHT" | "BOTH"`.
- `time_in_seconds` is only present for exercises with `volume_input_format: "TIME"` (like Assault Bike).
- Response 822 B: `{deleted, id, cycle_id, user_id, created_at, updated_at, version, during, timezone, timezone_offset, source, score_state, score_type, type, translated_type, source_id, activity_v1_id, weightlifting_workout_id, workout_template_id, name, pushcore_version, total_effective_volume_kg, raw_msk_strain_score, msk_intensity_percent, scaled_msk_strain_score, timezone_offset_from_model}`.

Wrapped as `whoop_lift_log`. Set timestamps default to a 100ms placeholder range per set; Whoop accepts this.

The MCP exposes `whoop_lift_prs, whoop_lift_exercise, whoop_lift_progression, whoop_lift_history, whoop_lift_library, whoop_lift_catalog, whoop_lift_log, whoop_lift_template_save, whoop_lift_custom_exercise`.

### widget-service

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/widget-service/v1/statistics/recovery` | 200/401 | 110 B `{icon, text, percentage_around, target_percentage_around, is_calibrating}` — small iOS widget recovery stat. |

Not wrapped — too low value.

### womens-health-service

MCI (Menstrual Cycle Insights), period tracking, hormonal coaching.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/womens-health-service/v1/hormonal-insights/onboarding` | 200 | 9,486 B `{initial_screen, screens}` — MCI onboarding flow content. |
| GET | `/womens-health-service/v1/hormonal-insights/settings` | 200 | 3,919 B `{navigation_bar_title, tiles, hormonal_insights_mode_drawer, contraception_type_drawer, pregnancy_due_date_drawer, switching_mode_dialog, switching_contraception_type_dialog, previous_pregnancies, disabling_dialog, goals_drawer}` — settings screen UI. |
| GET | `/womens-health-service/v1/menstrual-cycle-insights/calendar?date={date}` | 200 | 7,132 B `{date_picker, calendar, fab_menu}` — period calendar. |
| GET | `/womens-health-service/v1/menstrual-cycle-insights/cycles/edit?localDate={date}&source=CYCLE_CALENDAR` | 200 | 7,934 B `{navigation_title, title_display, description_display, button_title, month_picker, calendar, hiding_cycle_modal, editing_hidden_cycle_modal, editing_cycle_modal}` — cycle edit screen. |
| PUT | `/womens-health-service/v1/menstrual-cycle-insights/log` | 204 | Body: `{period_logs: [{period: {answered_yes, magnitude_input_value}, date: [Y,M,D], ovulation: {answered_yes, magnitude_input_value}}]}`. **Date encoded as a 3-element `[Y,M,D]` integer array.** Magnitudes are `null` for "no flow" and integer 1-5 for flow intensity. |
| GET | `/womens-health-service/v1/menstrual-cycle-insights?date={date}` | 200/400 | 37,346 B `{metadata, navigation_title, style, tiles, log_period_bottom_sheet, editing_hidden_cycle_modal}` — main MCI screen. **Returns 400 "User has no contraception status" if the user hasn't set up MCI via the survey first.** |
| GET | `/womens-health-service/v1/symptom-insights/log/symptoms?requestDate={date}` | 200 | 34,789 B `{navigation_bar, title, category_selector, style, primary_button}` — the symptom-logging UI. |
| POST | `/womens-health-service/v1/symptom-insights/log/symptoms?requestDate={date}` | 204 | Body: `{cervical_mucus, menstruation, tracker_inputs}`. Example: `{"menstruation":"light_flow", "cervical_mucus":"vaginal-discharge---egg-white", "tracker_inputs":[{"is_suggested":false,"behavior_tracker_id":217}, ...]}`. |

**Enums:**
- `menstruation`: `none, spotting, light_flow, medium_flow, heavy_flow`
- `cervical_mucus`: `vaginal-discharge---egg-white, vaginal-discharge---creamy, vaginal-discharge---sticky, vaginal-discharge---watery, vaginal-discharge---grey, none` (the triple-hyphen is the actual key format)

Wrapped as `whoop_cycle, whoop_cycle_log, whoop_symptom_log`.

---

## Enum reference

Every enum value observed across the captured traffic. When an endpoint says "must be one of [X, Y, Z]", these are the strings.

### Auth + cognito

`AuthFlow`: `USER_PASSWORD_AUTH, REFRESH_TOKEN_AUTH, USER_SRP_AUTH, ADMIN_NO_SRP_AUTH`
`ChallengeName`: `SMS_MFA, SOFTWARE_TOKEN_MFA, MFA_SETUP, NEW_PASSWORD_REQUIRED`
`TokenType`: `Bearer` (only)

### Recovery + sleep

`recovery_state` (derived from `progress_fill_style`):
- `RECOVERY_HIGH` → GREEN (>=67% recovery score)
- `RECOVERY_MEDIUM` → YELLOW (34-66%)
- `RECOVERY_LOW` → RED (<34%)

`sleep_stage` ID values (in BAR_GRAPH_CARD.heart_rate_zones for sleep):
- `AWAKE` (label "AWAKE")
- `LIGHT_SLEEP` (label "LIGHT")
- `SWS_SLEEP` (label "SWS (DEEP)")
- `REM_SLEEP` (label "REM")

`HR_zone` IDs (in cardio-details bar_graph_container.heart_rate_zones):
- `RESTORATIVE` → zone 0 (label "ZONE 0")
- `VERY_LIGHT` → zone 1 (label "ZONE 1")
- `LIGHT` → zone 2 (label "ZONE 2")
- `MODERATE` → zone 3 (label "ZONE 3")
- `HARD` → zone 4 (label "ZONE 4")
- `MAX` → zone 5 (label "ZONE 5")

### Trends

`metric` enum (25 values): `HRV, RHR, RECOVERY, DAY_STRAIN, CALORIES, STEPS, AVERAGE_HR, HOURS_V_NEED, HOURS_V_NEEDED_PERCENT, TIME_IN_BED, SLEEP_PERFORMANCE, SLEEP_EFFICIENCY, SLEEP_CONSISTENCY, SLEEP_DEBT_POST, RESTORATIVE_SLEEP, HR_ZONES_1_3, HR_ZONES_4_5, RESPIRATORY_RATE, STRENGTH_ACTIVITY_TIME, STRESS, STRESS_DURING_SLEEP, STRESS_DURING_NON_STRAIN, VO2_MAX, BODY_COMPOSITION, WEIGHT`

`trend_direction`: `UP, DOWN, EQUAL`
`trend_style`: `POSITIVE, NEGATIVE, NEUTRAL`

### Strength Trainer

`exercise_type`: `STRENGTH, POWER`
`volume_input_format`: `REPS, TIME, WEIGHT`
`movement_pattern`: `SQUAT, HINGE, HORIZONTAL_PRESS, VERTICAL_PRESS, HORIZONTAL_PULL, VERTICAL_PULL, LUNGE, OLYMPIC_LIFT, JUMP, OTHER`
`equipment`: `MACHINE, DUMBBELL, BARBELL, BODY, OTHER, KETTLEBELL`
`laterality`: `BILATERAL, UNILATERAL_LEFT, UNILATERAL_RIGHT, ALTERNATING, LEFT, RIGHT`
`muscle_groups` (array elements): `CHEST, BACK, LEGS, ARMS, SHOULDERS, CORE, GLUTES, HAMSTRINGS, QUADS, CALVES, FULL_BODY`
`strap_location`: `"1"` (wrist), `"2"` (bicep), `"3"` (calf), `"4"` (other) — values are strings
`strap_location_laterality`: `LEFT, RIGHT, BOTH`
`achievement_icon` (medal): `BADGE_GOLD, BADGE_SILVER, BADGE_BRONZE`

### Journal + women's health

`menstruation`: `none, spotting, light_flow, medium_flow, heavy_flow`
`cervical_mucus`: `vaginal-discharge---egg-white, vaginal-discharge---creamy, vaginal-discharge---sticky, vaginal-discharge---watery, vaginal-discharge---grey, none`
`contraception_type` (MCI survey): `NONE, PILL, ARM_IMPLANT, HORMONAL_IUD, NON_HORMONAL_IUD, PATCH, INJECTION, VAGINAL_RING`
`interest` (MCI survey, all 8 values confirmed by probing): `SUPPORT_REPRODUCTIVE_HEALTH_GOALS, OTHER_OR_NONE_OF_THE_ABOVE, MANAGE_HORMONAL_CONDITION, AVOID_PREGNANCY, GET_PREGNANT, MONITOR_PERIMENOPAUSE, TO_OPTIMIZE_MY_TRAINING, BETTER_UNDERSTAND_MY_BODY`
`magnitude_input_type` (inferred from input shape): `bare, boolean, magnitude`

### Profile

`gender`: `MALE, FEMALE, NON_BINARY, PREFER_NOT` (UPPERCASE required on PUT, returned lowercase on GET)
`physiological_baseline`: `MALE, FEMALE, AVERAGE`
`unit_system`: `imperial, metric` (lowercase)
`fitness_level`: `beginner, recreational_enthusiast, athlete, elite` (lowercase)

### Smart Alarm

`alarm_mode` (per schedule): `IN_THE_GREEN, EXACT_TIME_PEAK, EXACT_TIME_OPTIMIZE_SLEEP`
`goal` (in preferences/alarm_bounds): same three
`day_of_week_list`: array of `MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY`
`wbl event_type`: `PHONE_DISABLED_ALARM, PHONE_SET_ALARM_TIME, STRAP_DRIVEN_ALARM_SET`
`schedule_state` / `alarm_schedule_state` (from sleepneed response): `ACTIVE, INACTIVE, ALL_DISABLED`

### Activities / Workouts

`state` (in user-state response): `workout, sleep, idle, recovery` (lowercase)
`source` (workout origin): `user, auto_detected, healthkit, garmin, strava`
`score_state`: `pending, scored, no_data`
`score_type`: `CARDIO, MSK, OTHER`
`type` (workout type returned in lift_log receipt): `weightlifting_msk, cardio, manual`

### Notifications

`notification_status`: `OPENED, DISMISSED, RECEIVED, IGNORED` (inferred — only OPENED observed)
`notification_type`: `RefreshCoordinatorTrigger` (only observed; more exist)
Namespaces (for block/unblock, confirmed live from `/notification-service/v1/notifications/user-settings/bff`): `StressSummary` (DAILY STRESS SUMMARY), `GPS` (TRAVEL INSIGHTS), `CheckIn` (CHECK INS — coach reminders). The full settings response is at `tests/fixtures/notification_settings.json`. Other namespaces likely exist for users with different feature entitlements.

### Membership

`membershipStatus` (from /membership): `active, canceled, pending, lapsed`
`subscription_type` (from billing/info): `whoop_pro, base, family_member`
`tier_type` (from v0 onboarding): `ONE, PEAK, LIFE`
`source` (referral-content): `Individual, Team`
`flow` (v0 onboarding/info): `create-account, returning_member, upcycle`

### Community + leaderboards

`teamType`: `ALL, COMMUNITY, TEAM, BUSINESS` (last two inferred)
`leaderboardType`: `strain, sleep, recovery` (lowercase)
`window` (path segment): `{date}, average/week, average/month`
`metric` (path segment for leaderboards): `recovery, sleep, strain`
`stat` (path segment): `score, performance, day_strain`
`member_type`: `member, owner, admin` (inferred)
`online`: `true, false`

### Hidden metrics

`METRIC` (path segment for hidden-metrics): `BODY_COMP, HEALTHSPAN`

### Live HR

`hr_zone` (live HR tile): integer 0-5

---

## Templated path glossary

| Placeholder | Examples | Source |
|---|---|---|
| `{uuid}` | `5364dc07-c229-481f-b92f-0d7ee402fbbf`, `e87e1e80-8ba5-47ce-a1e7-bbcb3e5d142e` | Server-assigned for activities, journal entries, schedules. Client-generated (uppercase) for workout set IDs + custom exercise IDs. |
| `{id}` | `12090, 36852, 1520732784` | Numeric DB primary keys |
| `{date}` | `2026-05-23` | ISO YYYY-MM-DD, client uses local TZ |
| `{community_id}` | `12090, 36852, 36858, 41237, 67472` | Integer |
| `{user_id}` | `200001, 200002, 228741, 314986` | Integer, stable per account |
| `{exercise_id}` | `BENCHPRESS_BARBELL, ASSAULT_AIRBIKE, ASSISTED_PULL_UPS_(BAND)` | Upper-snake catalog ID OR UUID for custom |
| `{behavior_id}` | `1, 80, 145, 338, 397` | Integer 1-398 (308 active) |
| `{metric}` | `HRV, RHR, RECOVERY, STEPS, VO2_MAX` | 25-value enum |
| `{education_name}` | `PAIRING_MODE_EDUCATION, ADVANCED_LABS_LH_CYCLE_RANGES` | Upper-snake string |
| `{conversation_id}` | `5e0d4424-b31a-4a67-b06d-dfbf1030c0e9` | UUID, server-assigned at create |
| `{namespace}` | `GPS, StressSummary` | Upper-camel string |
| `{COMM-CODE}` | `COMM-0D8539, COMM-68073D` | Community invite code |
| `{period}` | `WEEK, MONTH, YEAR` | Performance assessment cadence |
| `{level}` | `1, 12, 42` | Achievement level integer |
| `{METRIC}` | `BODY_COMP, HEALTHSPAN` | Hidden-metric name (upper-snake) |

---

## Response shape patterns

### Pure-data response (no UI tree)

```json
{"score": 78, "hrv_ms": 42, "rhr_bpm": 68}
```

Examples: `/activities-service/v1/user-state`, `/users-service/v1/hidden-metrics/{METRIC}`, `/membership/accessories/shop/auth`.

### Paginated list

```json
{
  "total_count": 47,
  "offset": 0,
  "records": [...]
}
```

Examples: `/community-service/v1/communities/featured`, `/achievements-service/v1/progression`, `/activities-service/v1/journals/stats/user/{id}`.

### Cursor-paginated

```json
{
  "records": [...],
  "next_token": "<opaque>"
}
```

Examples: `/journal-service/v2/journals/behaviors`.

### Domain object with timestamps

```json
{
  "id": "<uuid>",
  "user_id": 200001,
  "created_at": "2026-05-23T07:35:46.220Z",
  "updated_at": "2026-05-23T15:35:33.560Z",
  "deleted": false,
  ...
}
```

The `created_at, updated_at, deleted` triplet is everywhere. So is `user_id`.

### PostgreSQL range field

```
"during": "['2026-05-23T07:35:46.220Z','2026-05-23T15:35:33.560Z')"
```

Half-open interval syntax. `[` includes the lower, `)` excludes the upper. Single quotes around ISO timestamps. We've seen both closed (`[a, b]`) and half-open (`[a, b)`) variants but `[a, b)` is overwhelmingly common.

Open-ended variant: `"['2026-05-23T07:35:46.220Z',)"` for in-progress cycles.

### BFF section/tile tree

```json
{
  "sections": [
    {"type": "HEADER", "content": {...}},
    {"type": "GRAPHING_CARD", "content": {"title": "RECOVERY", "graph": {...}}},
    {"type": "DETAILS_METRIC_TILES", "content": {"title": "WAKE EVENTS", ...}},
    ...
  ]
}
```

The `sections[]` array is sequential UI structure. Each entry has a `type` discriminator and a `content` payload whose shape varies by type.

### BFF wrapper pattern

```json
{
  "content": {...},
  "type": "...",
  "refresh_behavior": "...",
  "prefetch_list": [...],
  "lifecycle_interactions": {...}
}
```

Used by `followers-service` and `context-hub-bff`. Describes how the iOS app should fetch supporting data + handle lifecycle events.

---

## Status code taxonomy

Already covered under [Cross-cutting patterns](#cross-cutting-patterns). Summary:

| Code | Used for |
|---|---|
| 200 | success + body |
| 204 | success, no body (writes) |
| 400 | validation error (`{code, message, location}`) |
| 401 | JWT expired |
| 403 | permission denied (e.g. community you left) |
| 404 | not found / feature not provisioned / user has no leaderboard data |
| 409 | resource conflict (overlapping time ranges) |
| 414 | URI too long (one-off bug) |
| 422 | body validation (preferred over 400 for "structurally fine but business-rule no") |
| 428 | precondition required (missing `If-Match`) |
| 500 | server error (rare; behavior-impact 500'd on stale UUID) |

---

## Token cost analysis

Output bytes per endpoint, sorted by size. The MCP's projections drop most of this; the per-tool cost in the test runner is much lower than the raw API response.

| Bytes | Endpoint |
|---|---|
| **~1.5 MB** | `/health-service/v2/stress-bff/{date}` |
| **848 KB** | `/home-service/v1/deep-dive/sleep/last-night?date=` |
| **539 KB** | `/home-service/v1/tilt-view?date=` |
| **385 KB** | `/weightlifting-service/v2/exercise` (catalog) |
| **300 KB** | `/core-details-bff/v1/cardio-details?activityId=` |
| 176 KB | `/activities-service/v1/journals/behaviors/user` |
| 118 KB | `/progression-service/v3/trends/{metric}` |
| 88 KB | `/activities-service/v1/sports/history` |
| 74 KB | `/journal-service/v3/journals/behaviors` |
| 67 KB | `/journal-service/v2/journals/behaviors` (catalog) |
| 55 KB | `/activities-service/v2/activity-types` |
| 54 KB | `/home-service/v1/home?date=` |
| 45 KB | `/home-service/v1/deep-dive/sleep/trends?date=` |
| 41 KB | `/onboarding-service/v1/features/educations/{education_name}` |
| 37 KB | `/womens-health-service/v1/menstrual-cycle-insights?date=` |
| 37 KB | `/onboarding-service/v1/account/start-auth?fromLogin=true` |
| 35 KB | `/womens-health-service/v1/symptom-insights/log/symptoms?requestDate=` |
| 29 KB | `/health-tab-bff/v1/health-tab` |
| 29 KB | `/home-service/v1/deep-dive/strain/trends?date=` |
| 29 KB | `/advanced-labs-service/v1/advanced-labs` |
| 25 KB | `/progression-service/v3/exercise?endDate=` |
| 24 KB | `/profile-service/v1/profile/bff` |
| 21 KB | `/home-service/v1/deep-dive/recovery/trends?date=` |
| 17 KB | `/onboarding-service/v1/account/activate` |
| 16 KB | `/onboarding-service/v1/what-to-expect` |
| 16 KB | `/weightlifting-service/v3/workout-library` |
| 15 KB | `/onboarding-service/v1/feature-education-state` |
| 15 KB | `/onboarding-service/v1/overlay/all` |
| 13 KB | `/community-service/v1/communities/defaultImages` |
| 13 KB | `/core-details-bff/v1/start-activity/strain` |
| 13 KB | `/coaching-service/v1/health/bff/monitor` |
| 11 KB | `/progression-service/v3/exercise/{exercise_id}` |
| 11 KB | `/achievements-service/v1/progression` |
| 11 KB | `/context-hub-bff/v1/context-hub` |
| 10 KB | `/weightlifting-service/v2/workout-template/{id}` |
| 10 KB | `/weightlifting-service/v3/prs` |
| 10 KB | `/weightlifting-service/v3/exercise/{id}/exercise_history` |
| 8 KB | `/followers-service/v1/followers-home` |
| 7 KB | `/community-service/v1/communities/featured` |
| 7 KB | `/home-service/v2/home/dashboard/customize` |
| 7 KB | `/weightlifting-service/v3/exercise/{id}/personal_records` |
| 5 KB | `/home-service/v1/deep-dive/strain?date=` |
| 5 KB | `/home-service/v1/deep-dive/sleep?date=` |
| 5 KB | `/home-service/v1/deep-dive/recovery?date=` |
| 4 KB | `/membership-service/v1/membership-management/membership-and-billing` |
| 4 KB | `/growth-content-service/v1/in-app-welcome-screen/order-info-content` |
| 4 KB | `/weightlifting-service/v3/exercise/{exercise_id}` |
| 3 KB | `/streaks-service/v1/bff/streaks/data-streak` |
| 3 KB | `/research-service/research-bff-service/v1/campaigns` |
| 3 KB | `/membership-service/v1/family-plans-native/hub` |
| 3 KB | `/membership-service/v1/membership-management` |
| 3 KB | `/progression-service/v2/weekly-plan/home-tile/{date}` |
| 3 KB | `/coaching-service/v2/sleepneed` |
| 2 KB | (many more, omitted) |

The MCP projects the 848 KB sleep response down to ~500 chars (`whoop_sleep`). The 300 KB workout detail to ~500 chars (`whoop_workout`). The 118 KB trend to 500-12,000 chars depending on populated windows (`whoop_trend`). The 54 KB home to ~480 chars (`whoop_today`).

Reduction ratio across the API surface: typically **99%+**. Whoop's BFFs are extraordinarily verbose by design (they're shipping UI code, not data).

---

## Internal vocabulary glossary

Terms used inside Whoop's API responses that aren't externally documented.

- **BFF** — Backend For Frontend. An API endpoint that returns UI tree fragments instead of raw data. Whoop has many.
- **MSK** — Musculo-Skeletal. The Strength Trainer feature. `msk_intensity_percent` is how hard your muscles worked relative to capacity. `total_volume_kg` is the cumulative weight × reps. `scaled_msk_strain_score` is the strength-adjusted contribution to day strain.
- **MCI** — Menstrual Cycle Insights. Whoop's women's-health module. Must be configured before any cycle-related endpoint returns data.
- **Vow** — Whoop's narrative-text generation service. Takes structured numeric data and emits a "coach voice" sentence.
- **Cycle** — In Whoop's world, a "cycle" is a 24-hour period defined by the user's typical wake time, NOT a calendar day. It runs from wake yesterday to wake today. Most endpoints use `cycle_id` as their per-day index.
- **Pillar** — The three top-level health categories: Sleep, Recovery, Strain. The `/home` response groups data by pillar (though in newer captures we only see one OVERVIEW pillar containing all three as sub-tiles).
- **Strain Coach** — Whoop's coaching feature for advising on target day strain. Different from Sleep Coach.
- **Sleep Coach** — Whoop's bedtime recommendation feature, driven by `/coaching-service/v2/sleepneed`.
- **Whoop Coach** — Whoop's LLM-based chat assistant, accessed via `/ai-conversation-bff/`.
- **Wake Up Report** — Morning summary the iOS app shows after the user wakes up. Backed by the `/deep-dive/sleep/last-night` endpoint.
- **Tilt View** — When the user rotates the phone to landscape on a deep-dive screen, the iOS app fetches `/home-service/v1/tilt-view?date=` to get a wider chart layout.
- **Healthspan** — Whoop's "are you aging well" composite metric. Behind the HEALTHSPAN hidden-metric flag.
- **Body Comp** — Body composition (fat %, muscle %, etc.) from the Whoop scale integration. Behind the BODY_COMP flag.
- **Healthkit Token** — Apple HealthKit sync cursor (an integer). The iOS app holds this client-side and increments after each successful sync.
- **WBL** — Wake-By-Log. The Smart Alarm event telemetry log.
- **Stealth Mode** — Hides all metrics from the home tab; replaces them with a generic "checking in" UI. The user still earns data but doesn't see scores. Can be set but not read via the API.
- **Hidden Metric** — Per-metric visibility toggle. The user can hide Body Comp or Healthspan without going fully stealth.
- **Pushcore** — Whoop's exercise-classification engine. `push_core_name` is the canonical exercise ID it assigns to a detected lift (used for custom exercises that are alternate names for official ones).
- **Tonnage** — Strength workout total volume (sum of weight × reps across all sets). Reported in `lbs` units by default.
- **PR** — Personal Record. Whoop tracks PRs per exercise per rep-range and awards GOLD/SILVER/BRONZE medals on the top set.
- **Compliance** — In community leaderboards, "compliant" users are the ones with data points in the window. "Empty" users joined the community but have no data.

---

## Appendix A: Operation count by service

```
101  /community-service           Leaderboards + community CRUD + chat
 34  /membership-service          Billing + plans + straps + referrals
 23  /users-service               Bootstrap + preferences + hidden + stealth + privacy
 20  /onboarding-service          Signup + education + overlays
 20  /metrics-service             Protobuf sensor telemetry (skipped)
 20  /home-service                Home + calendars + deep dives
 20  /coaching-service            Health monitor + perf assessment + sleep need
 17  /weightlifting-service       Strength Trainer (catalog + writes + BFF)
 11  /smart-alarm-service         Schedules + preferences + WBL
 11  /health-service              Hormonal insights + stress BFF
 11  /activities-service          State machine + journals/behaviors + sport catalog
  9  /profile-service             Profile CRUD + avatar
  9  /journal-service             Journal v1/v2/v3
  9  /core-details-bff            Activity detail + create + start-strain
  8  /womens-health-service       MCI + symptom logging
  8  /membership                  Legacy bare /membership endpoints
  8  /auth-service                Cognito proxy + legacy v2 user
  6  /progression-service         Trends + weekly plan
  6  /behavior-impact-service     Behavior correlations
  6  /ai-conversation-bff         Whoop Coach
  5  /notification-service        Push prefs + event tracking
  5  /hr-zones-service            Zone CRUD
  5  /growth-content-service      Marketing content
  5  /followers-service           Social graph
  4  /integrations-bff            Third-party integrations
  3  /smart-alarm-bff             Schedule UI
  3  /ai-conversation-service     Coach settings
  2  /widget-service              iOS widgets
  2  /vow-service                 Narrative text generation
  2  /streaks-service             Data streaks
  2  /strap-location-service      Strap garments
  2  /privacy-service             Recommendation opt-in
  2  /health-tab-bff              Health tab UI
  2  /entitlement-service         Feature flags
  2  /context-hub-bff             UI lifecycle coordinator
  2  /commerce-service            In-app shop
  2  /candidate-service           HealthKit ingestion
  2  /app-notifications-service   In-app notification inbox
  2  /advanced-labs-service       Bloodwork
  1  /social-service              Strava settings
  1  /sleep-service               HR baseline
  1  /research-service            Research campaigns
  1  /member-data-export-service  GDPR export
  1  /enterprise-service          Enterprise sharing
  1  /device-config               Feature flags
  1  /autopop-service             Journal auto-populate
  1  /achievements-service        Achievement progression
---
419 unique operations total
```

---

## Appendix B: Bytes per endpoint (response payload, observed)

The largest 50 responses by byte size, in descending order. These are what the iOS app pulls. The MCP's projections reduce most by 99%+.

```
 1,529,442  /health-service/v2/stress-bff/{date}                                 (estimated 1.5MB, exact not captured)
   848,428  /home-service/v1/deep-dive/sleep/last-night?date={date}
   538,889  /home-service/v1/tilt-view?date={date}
   385,000  /weightlifting-service/v2/exercise                                   (385 KB exercise catalog)
   300,123  /core-details-bff/v1/cardio-details?activityId={uuid}
   176,630  /activities-service/v1/journals/behaviors/user
   118,399  /progression-service/v3/trends/{metric}?endDate={date}
    88,608  /activities-service/v1/sports/history?countryCode=AU
    88,606  /activities-service/v1/sports/history?countryCode=US
    73,571  /journal-service/v3/journals/behaviors
    68,672  /commerce-service/v1/mobile/shop/home?source=menu
    66,646  /journal-service/v2/journals/behaviors
    54,998  /activities-service/v2/activity-types
    54,751  /home-service/v1/home?date={date}
    44,991  /home-service/v1/deep-dive/sleep/trends?date={date}
    40,991  /onboarding-service/v1/features/educations/{education_name}
    37,880  /onboarding-service/v1/account/start?email=&fromLogin=false
    37,346  /womens-health-service/v1/menstrual-cycle-insights?date={date}
    36,947  /onboarding-service/v1/account/start-auth?fromLogin=true
    36,335  /profile-service/v1/profile/bff/edit
    34,789  /womens-health-service/v1/symptom-insights/log/symptoms?requestDate={date}
    29,141  /health-tab-bff/v1/health-tab
    28,706  /home-service/v1/deep-dive/strain/trends?date={date}
    28,555  /advanced-labs-service/v1/advanced-labs
    24,913  /progression-service/v3/exercise?endDate={date}
    23,671  /profile-service/v1/profile/bff
    21,001  /home-service/v1/deep-dive/recovery/trends?date={date}
    18,884  /commerce-service/v2/join-flow/catalog/memberships?tier=PEAK&country=US&language=en
    17,519  /onboarding-service/v1/account/activate
    16,790  /weightlifting-service/v3/workout-library
    16,134  /onboarding-service/v1/what-to-expect
    15,710  /onboarding-service/v1/features/educations/onboarding/PAIRING_MODE_EDUCATION
    15,586  /onboarding-service/v1/overlay/all
    15,086  /onboarding-service/v1/feature-education-state?userId={id}
    13,886  /behavior-impact-service/v1/impact
    13,616  /community-service/v1/communities/defaultImages
    13,156  /journal-service/v2/journals/behaviors/user/{date}
    13,044  /core-details-bff/v1/start-activity/strain
    11,660  /achievements-service/v1/progression?level={level}
    11,413  /context-hub-bff/v1/context-hub?analytics_source=profile
    11,410  /context-hub-bff/v1/context-hub?analytics_source=coach-chat
    10,693  /weightlifting-service/v2/workout-template/{id}
    10,633  /weightlifting-service/v3/prs?startDate=&endDate=&offset=
    10,463  /weightlifting-service/v3/prs
    10,412  /progression-service/v3/exercise/{exercise_id}?endDate={date}
     9,812  /weightlifting-service/v3/exercise/{exercise_id}/exercise_history
     9,486  /womens-health-service/v1/hormonal-insights/onboarding
     8,444  /coaching-service/v1/health/bff/monitor
     7,934  /womens-health-service/v1/menstrual-cycle-insights/cycles/edit
     7,849  /followers-service/v1/followers-home
```

---

## Appendix C: Endpoints not yet wrapped

The MCP wraps the high-value subset. These endpoints are documented but unwrapped — `whoop_raw` can hit any of them.

**Probably valuable, just not yet:**
- `/home-service/v1/calendar/overview` — already accessed via `whoop_calendar` but the wrapping is thin
- `/community-service/v1/communities` (POST, multipart/form-data) — create a community
- `/onboarding-service/*` — useful for fresh-strap signup flow
- `/membership-service/*` — billing / family plans / subscription management
- `/strap-location-service/v1/garment` — change which body part you wear the strap on
- `/social-service/v1/strava/bff/settings` — connect Strava
- `/integrations-bff/*` — TrainingPeaks, Withings, etc.
- `/research-service/research-bff-service/v1/campaigns` — opt into research studies
- `/member-data-export-service/v1/member-data-export-details` — request GDPR export
- `/notification-service/*` — fine-grained push preferences
- `/users-service/v0/users/preference` (PATCH) — toggle autoDetectSleep, autoClassifyWorkout, etc.
- `/users-service/v1/users/preferences/time` — set clock format + timezone
- `/profile-service/v1/profile/avatar` (PUT raw PNG) — upload a profile avatar
- `/advanced-labs-service/*` — bloodwork results (if subscribed)

**Probably skip:**
- `/metrics-service/v1/metrics` — binary protobuf sensor data; would require protobuf RE
- `/health-service/v2/stress-bff?timestamp=...` POST — deprecated binary upload path
- `/notification-service/v1/notifications/events` — analytics-only
- `/candidate-service/v1/applehealthkit/events` — only useful if mirroring iOS HealthKit
- All OPTIONS preflights — automatic CORS, not actionable
- `/device-config/v1/value` — empty array on this account
- `/firmware-service/*`, `/log-service/*`, `/mobile-metric-service/*`, `/gps-service/*` — pure telemetry, skipped from dedup
- `/auth-service/v3/whoop/` direct calls — auth happens via the MCP's TokenManager, not exposed as a tool

**Probably-deprecated:**
- `/health-service/v2/stress-bff?timestamp=...` (POST) — 404 in all captures; data goes via metrics-service binary stream now
- `/membership-service/v1/membership/native-account-header` — 400 on healthy accounts, looks broken

---

---

## BFF section / tile type taxonomy

Every `type` discriminator value observed across all captured responses, sorted by frequency. The `content` shape varies per type — example keys shown.

| Type | Count | Example `content` keys |
|---|---|---|
| `STANDARD` | 129 | (variable — used as a passthrough wrapper) |
| `LINE_PLOT` | 31 | (graph plot specification) |
| `EXERCISE_BREAKDOWN` | 16 | `number_of_columns, rows, table_titles, id` |
| `REGION_HIGHLIGHT` | 14 | (graph annotation overlay) |
| `GRAPHING_CARD` | 12 | `id, trends_cta, end_icon, destination, unlock_trends_card, icon, graph_legends, title, graph, sub_items, accessibility_label` |
| `DIVIDER` | 11 | `title, divider_type` |
| `BAR_PLOT` | 10 | (bar chart spec) |
| `CARDIO` | 10 | (activity-specific overlay) |
| `CARD_BUTTON` | 10 | `id, title, icon, icon_configuration, style, destination` |
| `KEY_STATISTIC` | 9 | `trend_key, title, current_value_display, thirty_day_value_display, state, icon` |
| `EXPANDABLE_CARD` | 8 | `icon_collapsed, icon_expanded, expanded, header_content, expanded_content, id` |
| `EXERCISE_RECORD_HEADER` | 8 | `achievement_icon, record_date, record_subtitle, record_title, id` |
| `TIME_MARKER` | 6 | (timestamp annotation on graphs) |
| `HEADER` | 6 | `id, title, subtitle, subtitle_end, cta, cta_state, icon, style, destination` |
| `DETAILS_GRAPHING_CARD` | 5 | `id, card_title, card_info, arrow_stat, graph_legends, card_content` |
| `ACTIVITY` | 5 | `is_gps_enabled, title, score_display, start_time_text, end_time_text, icon_url, secondary_icon_url, status` |
| `GRAPH` | 3 | `id, plane, plots, graph_title_display, graph_buttons` |
| `MILESTONE_CARD` | 3 | `id, title, subtitle, image_url, cta, navigation` |
| `PROGRESS_BAR` | 3 | (linear progress indicator) |
| `BAR_GRAPH_CARD` | 2 | `duration_title_display, duration_display, typical_range_title_display, heart_rate_zones` |
| `DETAILS_METRIC_TILES` | 2 | `title, icon, style, arrow_stat` |
| `COMPARISON_BARS` | 2 | `graph_type, bars, legend_entries` |
| `OVERLAY_PLOT` | 2 | (composite graph) |
| `SPLIT_CONTAINER` | 2 | `start_item, end_item` |
| `MINI_MONITOR` | 2 | `title, end_icon, body, destination` |
| `TREND_PLOT` | 2 | (trend graph spec) |
| `VIDEO` | 2 | (embedded video player) |
| `RECOVERY_IMPACTS_TILE` | 1 | `icon, title, subtitle, description, items, destination` |
| `HOME` | 1 | (pillar-type wrapper) |
| `HEALTH` | 1 | (pillar-type wrapper) |
| `COMMUNITY` | 1 | (pillar-type wrapper) |
| `PROFILE` | 1 | (pillar-type wrapper) |
| `SETTINGS` | 1 | (pillar-type wrapper) |
| `SCORE_GAUGE_STICKY` | 1 | `id, gauges, header_item` |
| `OVERVIEW` | 1 | (pillar-type wrapper) |
| `NOTIFICATIONS_WRAPPER_V2` | 1 | `architecture_mini_component, chat_entry_point` |
| `COACH_ENTRY_POINT` | 1 | `coach_pill, daily_outlook_tile` |
| `ITEMS_CARD` | 1 | `footer, header, items, footer_items, id` |
| `SLEEP` | 1 | (pillar-type wrapper) |
| `SLEEP_PLANNER_ALARM_CARD` | 1 | `height_style, waketime_subtitle, waketime_label_style, bedtime_period_display, waketime_period_display, cta_button_text` |
| `JOURNAL_HOME_TILE` | 1 | `path` |
| `WEEKLYPLAN_WRAPPER` | 1 | `architecture_mini_component, auto_expanded` |
| `STRESS_GRAPHING_CARD` | 1 | `icon, cta, last_updated_text, stress_graph_state, stress_graph_label, stress_graph_score` |
| `LOGO_NAV` | 1 | `url, destination` |
| `TITLE_ONLY` | 1 | (header with just a title) |
| `user`, `staff`, `teams`, `profile`, `membership`, `bio_data` | various | (bootstrap response shape) |

**Pillar types** (used in `/home-service/v1/home` pillar discriminator): `OVERVIEW, RECOVERY, SLEEP, STRAIN, HEALTH, COMMUNITY, PROFILE, SETTINGS, HOME`. Only `OVERVIEW` was seen in our capture; the others are inferred from BFF wrapper types.

**Plot types** inside `graph.plots[].plot`:
- `segments`: array of line segments, each with `points[]` (line plots)
- `bar_groups`: array of bar groups, each with `bars[]` (bar plots)
- `diagonal_points`: rare overlay
- `style`: visual style (RECOVERY, SLEEP, STRAIN, MSK, etc.)

### How to walk a BFF response

The MCP's `findFirst` / `findAll` helpers in `src/lib/walk.ts` do a recursive descent looking for nodes matching a predicate. The most common predicates:

- `findByType(node, "GRAPHING_CARD")` — find a section by exact type match
- `findAllByType(node, "GRAPHING_CARD")` — collect all
- `findCardByTitle(node, "VARIABILITY")` — find a GRAPHING_CARD whose `content.title` contains the substring (case-insensitive)
- `findDetailsCardByTitle(node, "HOURS OF SLEEP")` — same but for `DETAILS_GRAPHING_CARD.content.card_title`

The pattern for extracting today's value from a GRAPHING_CARD:

```ts
const card = findCardByTitle(raw, "HEART RATE VARIABILITY");
const label = latestGraphLabel(card);  // "42" (string)
const value = labelToNumber(label);    // 42 (number)
```

For bar plots (like the strain weekly bar chart):

```ts
const card = findCardByTitle(raw, "STRAIN");
const label = latestGraphLabel(card);  // walks bar_groups[last].top_label.label
// → "17.8"
```

For time-format labels:

```ts
const card = findCardByTitle(raw, "HR ZONES 1-3");
const label = latestGraphLabel(card);  // "1:41"
const ms = timeLabelToMs(label);       // 6060000
```

---

## Captured fixture response samples

For the seven highest-value endpoints, the actual JSON response — abridged to show structure. Full responses are in `tests/fixtures/*.json`.

### `/home-service/v1/home?date=` (`tests/fixtures/home.json`, 54,751 B)

```json
{
  "metadata": {
    "ai_context_metadata": {
      "is_wce_prefetch": true,
      "is_wce_enabled": true,
      "destination": {"screen": "AI_CHAT", "parameters": {...}}
    }
  },
  "header": {...},
  "pillars": [
    {
      "type": "OVERVIEW",
      "display_name": "OVERVIEW",
      "sections": [
        {
          "id": "...",
          "section_type": "COMPACT",
          "items": [
            {
              "type": "NOTIFICATIONS_WRAPPER_V2",
              "content": {
                "architecture_mini_component": {...},
                "chat_entry_point": {...}
              }
            }
          ]
        },
        {
          "section_type": "COMPACT",
          "items": [
            {
              "type": "SPLIT_CONTAINER",
              "content": {
                "start_item": {
                  "type": "SCORE_GAUGE_STICKY",
                  "content": {
                    "id": "SCORE_GAUGE_STICKY",
                    "gauges": [
                      {
                        "title": "SLEEP",
                        "id": "SLEEP_GAUGE_STICKY",
                        "score_display": "83",
                        "score_display_suffix": "%",
                        "gauge_fill_percentage": 0.83,
                        "progress_fill_style": "SLEEP",
                        "destination": {"screen": "PILLAR_DEEP_DIVE", "parameters": {"pillar": "sleep", "date": "2026-05-23"}}
                      },
                      {
                        "title": "RECOVERY",
                        "score_display": "78",
                        "score_display_suffix": "%",
                        "progress_fill_style": "RECOVERY_HIGH",
                        "destination": {"screen": "PILLAR_DEEP_DIVE", "parameters": {"pillar": "recovery"}}
                      },
                      {
                        "title": "STRAIN",
                        "score_display": "17.8",
                        "score_display_suffix": null,
                        "progress_fill_style": "STRAIN"
                      }
                    ]
                  }
                }
              }
            }
          ]
        },
        {
          "section_type": "NORMAL",
          "items": [
            {"type": "HEADER", "content": {"title": "TODAY'S ACTIVITIES", ...}},
            {
              "type": "ACTIVITY",
              "content": {
                "title": "STRENGTH TRAINER",
                "score_display": "17.7",
                "start_time_text": "9:49 AM",
                "end_time_text": "12:24 PM",
                "is_gps_enabled": false,
                "status": "scored"
              }
            }
          ]
        }
      ]
    }
  ],
  "day_one_transition": null
}
```

The MCP's `projectToday` walks this to extract: scores from SCORE_GAUGE_STICKY.gauges, workouts_count from ACTIVITY tiles. Recovery state is derived from `progress_fill_style`: `RECOVERY_HIGH` → GREEN, `RECOVERY_MEDIUM` → YELLOW, `RECOVERY_LOW` → RED.

### `/home-service/v1/deep-dive/recovery?date=` (`tests/fixtures/deep_dive_recovery.json`, 21,001 B)

```json
{
  "sections": [
    {
      "id": "...",
      "items": [
        {
          "type": "HEADER",
          "content": {"id": "RECOVERY_HEADER", "title": null, ...}
        }
      ]
    },
    {
      "section_type": "NORMAL",
      "items": [
        {
          "type": "GRAPHING_CARD",
          "content": {
            "id": "recovery",
            "title": "RECOVERY",
            "graph": {
              "id": "RECOVERY",
              "plots": [{
                "plot": {
                  "segments": [{
                    "points": [
                      {
                        "data_scrubber_details": null,
                        "graph_label": {"label": "78", "label_style": "RECOVERY"},
                        "position_x": 1,
                        "position_y": 0.78,
                        "style": "RECOVERY"
                      }
                    ]
                  }]
                }
              }],
              "graph_buttons": [...]
            },
            "accessibility_label": "Recovery score 78 percent"
          }
        },
        {
          "type": "GRAPHING_CARD",
          "content": {
            "id": "hrv",
            "title": "HEART RATE VARIABILITY",
            "graph": {
              "plots": [{
                "plot": {
                  "segments": [{
                    "points": [
                      {
                        "data_scrubber_details": {
                          "primary_contextual_display": "SUN, MAY 17",
                          "value": null,
                          "value_display": "32",
                          "unit_display": "ms"
                        },
                        "graph_label": {"label": "32"}
                      },
                      {"graph_label": {"label": "38"}, "data_scrubber_details": {...}},
                      {"graph_label": {"label": "45"}, "data_scrubber_details": {...}},
                      {"graph_label": {"label": "40"}, "data_scrubber_details": {...}},
                      {"graph_label": {"label": "39"}, "data_scrubber_details": {...}},
                      {"graph_label": {"label": "37"}, "data_scrubber_details": {...}},
                      {"graph_label": {"label": "42"}, "data_scrubber_details": {...}}
                    ]
                  }]
                }
              }]
            }
          }
        },
        {"type": "GRAPHING_CARD", "content": {"title": "RESTING HEART RATE", ...}},
        {"type": "GRAPHING_CARD", "content": {"title": "RESPIRATORY RATE", ...}},
        {"type": "GRAPHING_CARD", "content": {"title": "SLEEP PERFORMANCE", ...}}
      ]
    }
  ]
}
```

Five GRAPHING_CARDs total. The MCP's `projectRecovery` walks for each by title substring and extracts the latest point's `graph_label.label` as a number.

### `/home-service/v1/deep-dive/sleep/last-night?date=` (`tests/fixtures/deep_dive_sleep.json`, 848,428 B)

The biggest non-binary response. Top-level structure:

```json
{
  "header_section": {
    "id": null,
    "title": "Last Night's Sleep",
    "subtitle": "EDIT",
    "icon": "PENCIL",
    "style": "LARGE",
    "destination": {
      "screen": "ACTIVITY_EDIT",
      "parameters": {
        "activity_id": "e87e1e80-8ba5-47ce-a1e7-bbcb3e5d142e",
        "start_time": "2026-05-23T07:35:46.220Z",
        "end_time": "2026-05-23T15:35:33.560Z",
        "activity_score_type": "SLEEP",
        "internal_name": "sleep",
        "flow": "sleep_deep_dive",
        "is_deletable": true
      }
    }
  },
  "sub_header_section": {...},
  "sections": [
    {
      "items": [
        {
          "type": "DETAILS_GRAPHING_CARD",
          "content": {
            "id": "hours_of_sleep",
            "card_title": "HOURS OF SLEEP",
            "arrow_stat": [{
              "current_stat_text": "7:24",
              "historic_stat_text": "7:24",
              "trend_state": "EQUAL"
            }],
            "card_content": {...}
          }
        },
        {
          "type": "BAR_GRAPH_CARD",
          "content": {
            "duration_title_display": "DURATION",
            "duration_display": "7:59",
            "typical_range_title_display": "TYPICAL RANGE",
            "heart_rate_zones": [
              {
                "id": "AWAKE",
                "bar_graph_tile_title_display": "AWAKE",
                "bar_graph_tile_percentage_display": "7%",
                "bar_graph_tile_time_display": "0:35"
              },
              {
                "id": "LIGHT_SLEEP",
                "bar_graph_tile_title_display": "LIGHT",
                "bar_graph_tile_percentage_display": "55%",
                "bar_graph_tile_time_display": "4:13"
              },
              {
                "id": "SWS_SLEEP",
                "bar_graph_tile_title_display": "SWS (DEEP)",
                "bar_graph_tile_percentage_display": "16%",
                "bar_graph_tile_time_display": "1:21"
              },
              {
                "id": "REM_SLEEP",
                "bar_graph_tile_title_display": "REM",
                "bar_graph_tile_percentage_display": "22%",
                "bar_graph_tile_time_display": "1:50"
              }
            ]
          }
        },
        {
          "type": "DETAILS_GRAPHING_CARD",
          "content": {"card_title": "HOURS VS. NEEDED", "arrow_stat": [{"current_stat_text": "85%"}]}
        },
        {
          "type": "DETAILS_GRAPHING_CARD",
          "content": {"card_title": "SLEEP CONSISTENCY", "arrow_stat": [{"current_stat_text": "73%"}]}
        },
        {
          "type": "DETAILS_GRAPHING_CARD",
          "content": {"card_title": "SLEEP EFFICIENCY", "arrow_stat": [{"current_stat_text": "93%"}]}
        },
        {
          "type": "DETAILS_GRAPHING_CARD",
          "content": {"card_title": "SLEEP STRESS", "arrow_stat": [{"current_stat_text": "0%"}]}
        },
        {
          "type": "DETAILS_METRIC_TILES",
          "content": {"title": "RESTORATIVE SLEEP", ...}
        },
        {
          "type": "DETAILS_METRIC_TILES",
          "content": {"title": "WAKE EVENTS", ...}
        }
      ]
    }
  ]
}
```

`projectSleep`:
- `total_sleep_ms` from `DETAILS_GRAPHING_CARD[card_title=HOURS OF SLEEP].arrow_stat[0].current_stat_text` → `"7:24"` → `timeLabelToMs("7:24")` → `26640000`
- `time_in_bed_ms` from `BAR_GRAPH_CARD.duration_display` → `"7:59"` → `28740000`
- Each stage from `BAR_GRAPH_CARD.heart_rate_zones[id=*]` (note `heart_rate_zones` is misnamed — these are sleep stages)
- `started_at` / `ended_at` from `header_section.destination.parameters.start_time` / `end_time`

### `/home-service/v1/deep-dive/strain?date=` (`tests/fixtures/deep_dive_strain.json`, 28,706 B)

```json
{
  "sections": [
    {
      "items": [
        {
          "type": "GRAPHING_CARD",
          "content": {
            "title": "STRAIN",
            "graph": {
              "plots": [{
                "plot": {
                  "bar_groups": [
                    {"top_label": {"label": "15.8"}, "position_x": 0, "bars": [...]},
                    {"top_label": {"label": "4.8"}, "position_x": 0.167},
                    {"top_label": {"label": "4.5"}, "position_x": 0.333},
                    {"top_label": {"label": "8.6"}, "position_x": 0.5},
                    {"top_label": {"label": "4.3"}, "position_x": 0.667},
                    {"top_label": {"label": "12.6"}, "position_x": 0.833},
                    {"top_label": {"label": "17.8"}, "position_x": 1}
                  ]
                }
              }]
            }
          }
        },
        {"type": "GRAPHING_CARD", "content": {"title": "HR ZONES 1-3", ...}},
        {"type": "GRAPHING_CARD", "content": {"title": "HR ZONES 4-5", ...}},
        {"type": "GRAPHING_CARD", "content": {"title": "STEPS", ...}},
        {"type": "GRAPHING_CARD", "content": {"title": "CALORIES", ...}},
        {"type": "GRAPHING_CARD", "content": {"title": "STRENGTH ACTIVITY TIME", ...}}
      ]
    }
  ]
}
```

Each GRAPHING_CARD for strain uses BAR_GROUPS (not segments). Today's value is the rightmost bar's `top_label.label`. The MCP reads `bar_groups[last].top_label.label`.

### `/core-details-bff/v1/cardio-details?activityId=` (`tests/fixtures/cardio_details.json`, 300,123 B)

Top-level structure:

```json
{
  "metadata": {"ai_context_metadata": {...}},
  "link_workout_option_enabled": false,
  "link_workout_cta_tile": null,
  "title_bar": {
    "s3_icon_url": "https://s3-us-west-2.amazonaws.com/icons.whoop.com/mobile/activities/weightlifting.png",
    "title_display": "STRENGTH TRAINER",
    "subtitle_display": "9:49 AM to 12:24 PM"
  },
  "horizontal_stat": {
    "stat_main_value_display": "17.7",
    "stat_title_display": "ACTIVITY STRAIN",
    "stat_comparison_display": "12.3",
    "stat_trend_type": "POSITIVE"
  },
  "horizontal_stats": [...],
  "key_metric_carousel": {
    "title": "KEY STATISTICS",
    "subtitle": "VS. 30 DAY AVERAGE",
    "key_metric_tile": [
      {
        "key_metric_tile_icon": "DURATION",
        "key_metric_tile_title_display": "DURATION",
        "key_metric_tile_stat_value_display": "2:35",
        "key_metric_tile_suffix_display": ":38",
        "key_metric_tile_trend_display": "2:08:47",
        "key_metric_tile_trend_type": "POSITIVE"
      },
      {
        "key_metric_tile_icon": "CALORIES",
        "key_metric_tile_stat_value_display": "701",
        "key_metric_tile_suffix_display": "cals"
      },
      {
        "key_metric_tile_icon": "HEART_RATE",
        "key_metric_tile_title_display": "AVG HR",
        "key_metric_tile_stat_value_display": "123",
        "key_metric_tile_suffix_display": "bpm"
      },
      {
        "key_metric_tile_icon": "MAX_HEART_RATE",
        "key_metric_tile_title_display": "MAX HR",
        "key_metric_tile_stat_value_display": "171",
        "key_metric_tile_suffix_display": "bpm"
      }
    ]
  },
  "graph_response": {"plots": [{"plot": {"segments": [{"points": [/* HR curve */]}]}}]},
  "bar_graph_container": {
    "duration_title_display": "DURATION",
    "duration_display": "2:35:38",
    "heart_rate_zones": [
      {"id": "MAX", "bar_graph_tile_title_display": "ZONE 5", "bar_graph_tile_time_display": "0:00", "bar_graph_tile_percentage_display": "0%"},
      {"id": "HARD", "bar_graph_tile_title_display": "ZONE 4", "bar_graph_tile_time_display": "0:00", "bar_graph_tile_percentage_display": "0%"},
      {"id": "MODERATE", "bar_graph_tile_title_display": "ZONE 3", "bar_graph_tile_time_display": "0:04", "bar_graph_tile_percentage_display": "2%"},
      {"id": "LIGHT", "bar_graph_tile_title_display": "ZONE 2", "bar_graph_tile_time_display": "0:15", "bar_graph_tile_percentage_display": "9%"},
      {"id": "VERY_LIGHT", "bar_graph_tile_title_display": "ZONE 1", "bar_graph_tile_time_display": "1:21", "bar_graph_tile_percentage_display": "54%"},
      {"id": "RESTORATIVE", "bar_graph_tile_title_display": "ZONE 0", "bar_graph_tile_time_display": "0:54", "bar_graph_tile_percentage_display": "35%"}
    ]
  },
  "details_edit_components": {
    "start_time_selector": {"initial_time": "2026-05-23T16:49:15.964Z"},
    "end_time_selector": {"initial_time": "2026-05-23T19:24:54.924Z"}
  },
  "strain_breakdown": {
    "cardio_title_display": "CARDIO",
    "msk_title_display": "MUSCULAR",
    "msk_percent_display": "74%",
    "cardio_percent_display": "26%",
    "cardio_total_percent": 0.2571523605
  },
  "weightlifting_cardio_details": {
    "weightlifting_exercises": {
      "title_display": "EXERCISES",
      "tonnage_title_display": "TONNAGE",
      "tonnage_units_display": "lbs",
      "exercise_summary_carousel": {
        "total_number_of_items": 9,
        "items": [
          {
            "title_display": "8 Exercises",
            "subtitle_display": "29 Sets",
            "tonnage_display": "36720",
            "volume_display": "362",
            "volume_title_display": "TOTAL REPS"
          }
        ]
      }
    }
  },
  "achievement_progress_card": {...}
}
```

The MCP's `projectWorkout` walks 8+ fields here to emit a clean shape.

### `/progression-service/v3/trends/{metric}?endDate=` (`tests/fixtures/trend_hrv.json`, 116,971 B)

Top-level:

```json
{
  "metadata": {...},
  "header_name_display": "HEART RATE VARIABILITY",
  "segment_controller": {...},
  "week_time_segment": {
    "date_picker": {
      "current_date_range_display": "May 17-23",
      "next_date_time": "...",
      "previous_date_time": "..."
    },
    "metrics": [
      {
        "trend_key": "HRV",
        "metric_name_display": "AVERAGE",
        "metric_value_display": "35",
        "metric_units_display": "ms",
        "trend_direction": "DOWN",
        "trend_style": "NEGATIVE",
        "trend_text_display": "10% vs. prior week",
        "current_metric_value": 35,
        "previous_metric_value": 39,
        "metric_change": -10
      }
    ],
    "graph": {
      "plots": [
        {
          "plot": {
            "segments": [
              {
                "points": [
                  {
                    "data_scrubber_details": {
                      "primary_contextual_display": "SUN, MAY 17",
                      "value": null,
                      "value_display": "32",
                      "unit_display": "ms"
                    },
                    "graph_label": {"label": "32"}
                  },
                  // ... 6 more daily points
                ]
              }
            ]
          }
        }
      ]
    },
    "vow": {...},
    "is_hidden": false
  },
  "month_time_segment": {...},
  "six_month_time_segment": {...},
  "cardio_fitness_level": null
}
```

The critical detail: `metrics` is an **array**, not an object. Read `metrics[0].current_metric_value`, NOT `metrics.avg`.

### `/users-service/v2/bootstrap` (`tests/fixtures/bootstrap.json`, 1,209 B)

```json
{
  "account": {
    "id": 200001,
    "username": "briangao",
    "email": "you@example.com",
    "type": "ANY",
    "user_id": 200001
  },
  "user": {
    "id": 200001,
    "first_name": "brain",
    "last_name": "gao",
    "country": "US",
    "city": "San Jose"
  },
  "staff": false,
  "teams": [],
  "profile": {
    "user_id": 200001,
    "bio_data_id": 12345678,
    "height": 1.7779999971389,
    "weight": 70.760406494,
    "gender": "male",
    "unit_system": "imperial",
    "fitness_level": "recreational_enthusiast",
    "birthday": "1990-01-01T00:00:00.000Z",
    "created_at": "2024-XX-XX",
    "updated_at": "2024-XX-XX",
    "timezone_offset": "-0700",
    "physiological_baseline": null
  },
  "membership": {"status": "active", "in_effect": true},
  "bio_data": {
    "max_heart_rate": 200,
    "min_heart_rate": null,
    "resting_heart_rate": 55,
    "recovery_count": null
  }
}
```

The `profile.birthday` is full ISO datetime. The `gender` is lowercase. Both are quirks to handle (uppercase + YYYY-MM-DD on the PUT).

### Cardio-details for a NON-strength workout (`tests/fixtures/cardio_details_nonstrength.json`, 540,330 B)

For comparison with the strength workout above. A basketball game looks like:

```json
{
  "metadata": {"ai_context_metadata": {...}},
  "title_bar": {
    "s3_icon_url": "https://s3-us-west-2.amazonaws.com/icons.whoop.com/mobile/activities/basketball.png",
    "title_display": "BASKETBALL",
    "subtitle_display": "8:08 PM to 8:55 PM"
  },
  "horizontal_stat": {
    "stat_main_value_display": "11.6",
    "stat_title_display": "ACTIVITY STRAIN",
    "stat_comparison_display": "7.8",
    "stat_trend_type": "POSITIVE"
  },
  "key_metric_carousel": {
    "key_metric_tile": [
      {"key_metric_tile_icon": "CALORIES", "key_metric_tile_stat_value_display": "427", "key_metric_tile_suffix_display": "cals"},
      {"key_metric_tile_icon": "HEART_RATE", "key_metric_tile_stat_value_display": "145", "key_metric_tile_suffix_display": "bpm"},
      {"key_metric_tile_icon": "MAX_HEART_RATE", "key_metric_tile_stat_value_display": "188", "key_metric_tile_suffix_display": "bpm"},
      {"key_metric_tile_icon": "DURATION", "key_metric_tile_stat_value_display": "0:47", "key_metric_tile_suffix_display": ":15"}
    ]
  },
  "graph_response": { /* HR curve plots */ },
  "bar_graph_container": { /* HR zone breakdown */ },
  "details_edit_components": { /* start/end timestamps */ },
  "map": null,
  "strain_breakdown": null,
  "weightlifting_cardio_details": null,
  "tags": [...],
  "tags_v2": [...],
  "menu_options": [...]
}
```

Key differences vs the strength workout fixture:
- `title_bar.title_display` is the sport name (BASKETBALL, not STRENGTH TRAINER)
- `strain_breakdown` is **null** (no cardio/MSK split for non-strength)
- `weightlifting_cardio_details` is **null** (no exercises/sets)
- `map` is **null** if no GPS data was recorded (would be populated for runs/rides)
- DURATION tile differs: `0:47` (HH:MM) with suffix `:15` (seconds) — different formatting than the strength workout's `2:35` + `:38`

The MCP's `projectWorkout` handles both shapes — `msk: { is_strength_workout: false }` for non-strength, all MSK fields null.

### Stress BFF full response shape (`/health-service/v2/stress-bff/{date}`, ~1.3 MB)

This is the biggest single endpoint we wrap. Top-level structure:

```json
{
  "metadata": {...},
  "title": "STRESS",
  "date_selector": {...},
  "show_connectivity_window": true,
  "show_education": false,
  "calibration_text_display": null,
  "progress_stepper": {...},
  "loading_data": false,
  "stress_state": {
    "current_level": 1.2,
    "baseline_level": 1.5,
    "timeline": [
      {"started_at": "2026-05-25T07:00:00Z", "ended_at": "2026-05-25T07:15:00Z", "level": 0.8},
      {"started_at": "2026-05-25T07:15:00Z", "ended_at": "2026-05-25T07:30:00Z", "level": 1.1},
      ...  // ~96 entries (one per 15-min window across the day)
    ]
  },
  "vow": {"header": "...", "text": "Today's stress trended below your baseline..."}
}
```

The MCP's `projectStress` and `projectLiveStress` walk `stress_state.timeline` for the per-window stress levels. `calibration_text_display` non-null indicates the strap is still calibrating stress baselines.

The 1.3 MB size comes from the inline education content + the `vow` narrative; the actual stress data is well under 100 KB.

### `/weightlifting-service/v3/prs` (`tests/fixtures/lift_prs.json`, 10,463 B)

```json
{
  "tiles": [
    {
      "training_types": [],
      "instructions": ["Lie on the bench with your back and head resting..."],
      "muscle_groups": ["CHEST"],
      "translated_muscle_groups": "Chest",
      "created_at": "2022-03-03T19:45:51.740Z",
      "updated_at": "2025-09-25T14:07:28.273Z",
      "custom_exercise_info": null,
      "volume_input_value": "95",
      "volume_input_units": "lbs",
      "exercise_id": "BENCHPRESS_BARBELL",
      "name": "Bench Press - Barbell",
      "push_core_name": "BENCHPRESS_BARBELL",
      "trackable": true,
      "equipment": "BARBELL",
      "translated_equipment": "Barbell",
      "exercise_type": "STRENGTH",
      "laterality": "BILATERAL",
      "movement_pattern": "HORIZONTAL_PRESS",
      "translated_movement_pattern": "Horizontal Press",
      "deleted": false,
      "image_url": "https://dh6o7n168ts9.cloudfront.net/exercises/BENCHPRESS_BARBELL.jpg",
      "video_url": "https://dh6o7n168ts9.cloudfront.net/exercise-videos-temp/BENCHPRESS_BARBELL.mp4",
      "volume_input_format": "WEIGHT",
      "custom_exercise": false
    }
  ],
  "show_more": true,
  "next_exercise_offset": 10,
  "next_end_date": "...",
  "next_start_date": "..."
}
```

`volume_input_value` is a string ("95"), not a number. The MCP coerces via `asNumber()`.

---

## Captured request body samples (write endpoints)

The 14 canonical write bodies, captured from actual iOS app traffic. Used by the MCP's write tools as references for body shape.

### Activity create (v0 with sport_id)

```http
POST /core-details-bff/v0/create-activity HTTP/1.1
content-type: application/json
authorization: bearer <jwt>

{
  "start_time": "2026-05-25T01:54:40.715Z",
  "gps_enabled": false,
  "sport_id": 17,
  "end_time": "2026-05-25T01:54:53.777Z"
}
```

Response 490 B:
```json
{
  "id": "07546d55-1a7e-497f-a3b3-94a98285b1b9",
  "cycle_id": 1520732784,
  "user_id": 200002,
  "created_at": "2026-05-25T01:54:53.910+0000",
  "updated_at": "2026-05-25T01:54:53.910+0000",
  "version": 0,
  "during": "['2026-05-25T01:54:40.715Z','2026-05-25T01:54:53.777Z')",
  "timezone": "America/Los_Angeles",
  "timezone_offset": null,
  "source": "user"
}
```

### Activity create (v2 with activity_internal_name) — captured-but-broken

```http
POST /core-details-bff/v2/create-activity HTTP/1.1

{
  "end_time": "May 25, 2026",
  "gps_enabled": false,
  "start_time": "May 25, 2026",
  "activity_internal_name": "skiing",
  "garment_id": 1
}
```

Response 286 B (400 — body sent non-ISO timestamps):
```json
{"code": 400, "message": "Invalid start_time", "location": "line 1, column 31"}
```

### Journal entry save (full)

```http
PUT /journal-service/v2/journals/entries/user/date/2026-05-24 HTTP/1.1

{
  "notes": "",
  "tracker_inputs": [
    {"behavior_tracker_id": 1, "answered_yes": true},
    {"behavior_tracker_id": 2, "answered_yes": true},
    {"behavior_tracker_id": 26},
    {"behavior_tracker_id": 80, "magnitude_input_value": 22, "magnitude_input_label": "22 oz"},
    {"behavior_tracker_id": 274},
    {"behavior_tracker_id": 145, "magnitude_input_value": 1800, "magnitude_input_label": "1800 cal"},
    {"behavior_tracker_id": 165, "answered_yes": false}
    // ... up to 47 behaviors in the captured body
  ]
}
```

Response: 204 No Content.

### Strength workout log (abridged)

```http
POST /weightlifting-service/v2/weightlifting-workout/activity HTTP/1.1

{
  "scaled_msk_strain_score": 0,
  "msk_total_volume_kg": 0,
  "msk_intensity_percent": 0,
  "during": "['2026-05-25T02:00:22.478Z','2026-05-25T02:02:50.050Z')",
  "raw_msk_strain_score": 0,
  "name": "Wednesday Strength",
  "timezone": "America/Los_Angeles",
  "workout_groups": [
    {
      "workout_exercises": [
        {
          "sets": [
            {
              "during": "['2026-05-25T02:00:23.240Z','2026-05-25T02:00:23.380Z')",
              "msk_total_volume_kg": 0,
              "weight": 225,
              "number_of_reps": 5,
              "strap_location": "1",
              "strap_location_laterality": "LEFT",
              "weightlifting_workout_set_id": "0FB8E1AA-3D8F-4F1C-9F1E-XXXXXXXXXXXX"
            }
          ],
          "exercise_details": {
            "push_core_name": "BENCHPRESS_BARBELL",
            "name": "Bench Press - Barbell",
            "muscle_groups": ["CHEST"],
            "trackable": true,
            "image_url": "https://dh6o7n168ts9.cloudfront.net/exercises/BENCHPRESS_BARBELL.jpg",
            "video_url": "https://dh6o7n168ts9.cloudfront.net/exercise-videos-temp/BENCHPRESS_BARBELL.mp4",
            "updated_at": "2025-09-25T14:07:28.273Z",
            "created_at": "2022-03-03T19:45:51.740Z",
            "instructions": ["Lie on the bench..."],
            "exercise_type": "STRENGTH",
            "volume_input_format": "REPS",
            "deleted": false,
            "training_types": [],
            "translated_equipment": "Barbell",
            "translated_muscle_groups": "Chest",
            "translated_movement_pattern": "Horizontal Press",
            "equipment": "BARBELL",
            "exercise_id": "BENCHPRESS_BARBELL",
            "movement_pattern": "HORIZONTAL_PRESS",
            "laterality": "BILATERAL"
          }
        }
      ]
    }
    // ... more workout_groups for additional exercises
  ]
}
```

Response 822 B:
```json
{
  "deleted": false,
  "id": "2c425b12-5abe-4c50-9e40-67449993c78e",
  "cycle_id": 1523193713,
  "user_id": 200002,
  "created_at": "2026-05-25T17:34:45.226+0000",
  "version": 0,
  "during": "['2026-05-25T16:29:45.076Z','2026-05-25T16:34:45.076Z')",
  "timezone": "America/Los_Angeles",
  "source": "user",
  "score_state": "pending",
  "score_type": "CARDIO",
  "type": "weightlifting_msk",
  "translated_type": "Strength Trainer",
  "weightlifting_workout_id": "cc27c903-635f-49ca-af9c-e14ab47f4faa",
  "workout_template_id": null,
  "name": "Wednesday Strength",
  "total_effective_volume_kg": 326.92816,
  "raw_msk_strain_score": 0.0069470187,
  "msk_intensity_percent": 0.4,
  "scaled_msk_strain_score": 0.68879694
}
```

### Custom exercise create

```http
POST /weightlifting-service/v2/custom-exercise HTTP/1.1

{
  "created_at": "",
  "exercise_id": "A7B422DC-DDAA-4D5D-AB9B-3ED7E1E7813F",
  "laterality": "BILATERAL",
  "exercise_type": "STRENGTH",
  "updated_at": "",
  "push_core_name": "BENCHPRESS_BARBELL",
  "training_types": ["STRENGTH"],
  "custom_exercise_info": {
    "linked_exercise": {
      "name": "Bench Press - Barbell",
      "exercise_id": "BENCHPRESS_BARBELL",
      "image_url": "https://dh6o7n168ts9.cloudfront.net/exercises/BENCHPRESS_BARBELL.jpg"
    }
  },
  "trackable": true,
  "movement_pattern": "HORIZONTAL_PRESS",
  "instructions": ["Lie on the bench..."],
  "equipment": "BARBELL",
  "name": "Spoto Press",
  "volume_input_format": "REPS",
  "muscle_groups": ["CHEST"]
}
```

### MCI survey

```http
PUT /health-service/v1/hormonal-insights/settings/mci/survey HTTP/1.1

{
  "last_period_date_range": [[2026, 5, 15], [2026, 5, 20]],
  "contraception_type": "NONE",
  "interest": "SUPPORT_REPRODUCTIVE_HEALTH_GOALS",
  "removed_period_days": [],
  "symptoms": ["177", "227", "230"],
  "typical_cycle_length": 28
}
```

Note `symptoms` is an array of **stringified** behavior IDs, not integers. `last_period_date_range` is an array of `[Y, M, D]` integer arrays.

### Cycle log

```http
PUT /womens-health-service/v1/menstrual-cycle-insights/log HTTP/1.1

{
  "period_logs": [
    {
      "date": [2026, 5, 24],
      "period": {"answered_yes": false, "magnitude_input_value": null},
      "ovulation": {"answered_yes": true, "magnitude_input_value": null}
    }
  ]
}
```

### Symptom log

```http
POST /womens-health-service/v1/symptom-insights/log/symptoms?requestDate=2026-05-24 HTTP/1.1

{
  "menstruation": "light_flow",
  "cervical_mucus": "vaginal-discharge---egg-white",
  "tracker_inputs": [
    {"is_suggested": false, "behavior_tracker_id": 217},
    {"is_suggested": false, "behavior_tracker_id": 80}
  ]
}
```

### HR zones custom

```http
POST /hr-zones-service/v1/bff/custom HTTP/1.1

{
  "zones": [
    {"max": 186, "id": "ZONE_5", "min": 177},
    {"max": 176, "id": "ZONE_4", "min": 164},
    {"max": 163, "id": "ZONE_3", "min": 150},
    {"max": 149, "id": "ZONE_2", "min": 137},
    {"max": 136, "id": "ZONE_1", "min": 110}
  ],
  "is_custom": true
}
```

Response 380 B:
```json
{
  "zones": [...],
  "effective_timestamp": "2026-05-23T...",
  "max_hr_entry_field": {"value": 186, "title_display": "Max HR"}
}
```

### Max HR set

```http
POST /hr-zones-service/v1/maxhr HTTP/1.1

{"max_heart_rate": 186}
```

### Smart alarm schedule PUT

```http
PUT /smart-alarm-bff/v1/schedule/<uuid> HTTP/1.1

{
  "sleep_goal": "",
  "day_of_week_list": ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"],
  "time_zone_offset": "-0700",
  "enabled": true,
  "latest_wake_time": "07:30:00",
  "alarm_mode": "IN_THE_GREEN"
}
```

### Smart alarm preferences PUT

```http
PUT /smart-alarm-service/v1/smartalarm/preferences HTTP/1.1

{
  "default": false,
  "enabled": true,
  "goal": "EXACT_TIME_PEAK",
  "lower_time_bound": "06:30:00",
  "schedule_enabled": true,
  "time_zone_offset": "-0700",
  "upper_time_bound": "07:30:00",
  "weekly_plan_goal": 0
}
```

### Profile PUT (full body that works)

```http
PUT /profile-service/v1/profile HTTP/1.1

{
  "email": "test2@example.com",
  "first_name": "Josh",
  "last_name": "Carr",
  "city": "Sydney",
  "country": "AU",
  "birthday": "1997-02-09",
  "gender": "MALE",
  "physiological_baseline": "MALE",
  "weight": 70.76040649414062,
  "height": 1.777999997138977,
  "unit_system": "imperial"
}
```

Critical: birthday is `YYYY-MM-DD` (not ISO datetime), enums are UPPERCASE, weight is kg, height is m.

### Behaviors reorder

```http
PUT /activities-service/v1/journals/behaviors/user HTTP/1.1
content-type: application/json

[169, 42, 248, 250, 36, 386, 278, 78, 255, ...]  // 308-309 integer IDs in display order
```

A bare JSON array. The entire body is just the IDs in the order the user wants them shown in the journal editor.

---

## Discovery scripts

The actual reverse-engineering pipeline scripts, transcribed in full.

### `dump_combined.py` — the main dedup pipeline (203 lines)

Walks all 3 mitm captures, dedups by `(method, templated_path, body_signature, status_code)`, outputs into `/tmp/whoop_combined/`. Templates paths, redacts tokens, computes body signatures.

```python
"""Walk all 3 mitm captures. Dedup by (method, templated_path, body_keys, status).
Output deduplicated entries chunked for parallel agent analysis.
"""
import json
import re
import os
import sys
import hashlib
from mitmproxy.io import FlowReader

SOURCES = [
    ("flows.mitm", "phase1"),
    ("flows-phase8.mitm", "phase8a"),
    ("flows-phase8b.mitm", "phase8b"),
]

SKIP = (
    "/mobile-metric-service/", "/log-service/", "/gps-service/",
    "/firmware-service/", "/pip-metrics-service/", "/notification-service/v0/push/",
    "/feature-flags/flags/", "/experiment-service/", "/status-service/",
    "/configuration/v1/services/mobile", "/language-service/", "/tombstone-service/",
)

def templatize(p):
    p = re.sub(r"[?&]apiVersion=\d+", "", p).replace("?&", "?").rstrip("?")
    p = re.sub(r"/conversation/[^/?]+", "/conversation/{conversation_id}", p)
    p = re.sub(r"/exercise/[a-f0-9-]{36}", "/exercise/{exercise_id}", p, flags=re.IGNORECASE)
    p = re.sub(r"/exercise/[A-Z][A-Z0-9]*_[A-Z0-9_]+", "/exercise/{exercise_id}", p)
    p = re.sub(r"/exercise/[A-Z]{4,}(?=/|$|\?)", "/exercise/{exercise_id}", p)
    p = re.sub(r"/trends/[A-Z][A-Z0-9_]+", "/trends/{metric}", p)
    p = re.sub(r"/educations/[A-Z][A-Z0-9_]+", "/educations/{education_name}", p)
    p = re.sub(r"/experiments/name/[a-z][a-z0-9-]+", "/experiments/name/{name}", p)
    p = re.sub(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", "{uuid}", p, flags=re.IGNORECASE)
    p = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "{date}", p)
    p = re.sub(r"/\d{6,}", "/{id}", p)
    p = re.sub(r"endDate=\d{4}-\d{2}-\d{2}", "endDate={date}", p)
    p = re.sub(r"startDate=\d{4}-\d{2}-\d{2}", "startDate={date}", p)
    p = re.sub(r"date=\d{4}-\d{2}-\d{2}", "date={date}", p)
    p = re.sub(r"id=\d{6,}", "id={id}", p)
    p = re.sub(r"offset=\d+", "offset={offset}", p)
    p = re.sub(r"limit=\d+", "limit={limit}", p)
    p = re.sub(r"level=\d+", "level={level}", p)
    return p

def safe_body(req):
    raw = req.content or b""
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return raw.decode("latin-1")
        except Exception:
            return f"<binary {len(raw)} bytes>"

def redact(b):
    if not b:
        return b
    b = re.sub(r'("PASSWORD"\s*:\s*")[^"]+', r"\1<REDACTED>", b)
    b = re.sub(
        r'("(?:AccessToken|RefreshToken|IdToken|Session|SRP_A|PASSWORD_CLAIM_SIGNATURE|PASSWORD_CLAIM_SECRET_BLOCK)"\s*:\s*")[^"]+',
        r"\1<REDACTED>", b,
    )
    b = re.sub(r'("SMS_MFA_CODE"\s*:\s*")[^"]+', r"\1<REDACTED>", b)
    return b

def body_signature(body_text: str) -> str:
    """Compute a signature reflecting the SHAPE of the request body.
    JSON: sorted top-level keys. Binary: 'binary'. Empty: 'empty'."""
    if not body_text:
        return "empty"
    if body_text.startswith("<binary"):
        return "binary"
    try:
        parsed = json.loads(body_text)
        if isinstance(parsed, dict):
            return ",".join(sorted(parsed.keys()))
        if isinstance(parsed, list):
            return f"array[{len(parsed)}]"
        return type(parsed).__name__
    except Exception:
        return f"text:{hashlib.md5(body_text[:200].encode()).hexdigest()[:8]}"

seen = {}
seq_global = 0

for src_path, src_label in SOURCES:
    if not os.path.exists(src_path):
        continue
    with open(src_path, "rb") as f:
        for flow in FlowReader(f).stream():
            if not hasattr(flow, "request"):
                continue
            if "api.prod.whoop.com" not in flow.request.host:
                continue
            if any(s in flow.request.path for s in SKIP):
                continue
            seq_global += 1
            method = flow.request.method
            templ_path = templatize(flow.request.path)
            body = redact(safe_body(flow.request))
            sig = body_signature(body)
            status = flow.response.status_code if flow.response else None
            key = (method, templ_path, sig, status)
            if key in seen:
                continue
            if len(body) > 6000:
                body = body[:6000] + f" ...<{len(body)-6000} more>"
            resp_keys = []
            resp_size = 0
            if flow.response:
                try:
                    rb = safe_body(flow.response)
                    resp_size = len(flow.response.content or b"")
                    parsed = json.loads(rb) if rb else None
                    if isinstance(parsed, dict):
                        resp_keys = list(parsed.keys())[:10]
                    elif isinstance(parsed, list):
                        resp_keys = [f"array[{len(parsed)}]"]
                except Exception:
                    pass
            seen[key] = {
                "seq": seq_global, "src": src_label, "method": method,
                "path_template": templ_path, "actual_path": flow.request.path,
                "status": status, "body_sig": sig, "req_body": body,
                "resp_keys": resp_keys, "resp_size": resp_size,
            }

entries = sorted(seen.values(), key=lambda e: (e["path_template"].lstrip("/").split("/", 2)[0], e["path_template"], e["method"]))

# Write the full dump + chunks for parallel agent analysis
out_dir = "/tmp/whoop_combined"
os.makedirs(out_dir, exist_ok=True)
with open(os.path.join(out_dir, "all.txt"), "w") as f:
    for e in entries:
        f.write(f"#{e['seq']} [{e['src']}] {e['method']} {e['status']} {e['path_template']}\n")
        if e["req_body"]: f.write(f"  REQ ({e['body_sig']}): {e['req_body']}\n")
        if e["resp_keys"]: f.write(f"  RESP ({e['resp_size']}B): keys={e['resp_keys']}\n")
        f.write("\n")
chunks = 12
cs = (len(entries) + chunks - 1) // chunks
for i in range(chunks):
    chunk = entries[i * cs : (i + 1) * cs]
    with open(os.path.join(out_dir, f"chunk_{i+1:02d}.txt"), "w") as f:
        for e in chunk:
            f.write(f"#{e['seq']} [{e['src']}] {e['method']} {e['status']} {e['path_template']}\n")
            if e["req_body"]: f.write(f"  REQ ({e['body_sig']}): {e['req_body']}\n")
            if e["resp_keys"]: f.write(f"  RESP ({e['resp_size']}B): keys={e['resp_keys']}\n")
            f.write("\n")
```

### `heartbeat.py` — the silent-drop monitor (81 lines)

After Phase 8a was killed by an undetected Wi-Fi drop, this monitor polls the live flows file every 5 seconds and prints a warning if no new requests appear for >60s. Used during Phase 8b to make sure capture stays alive while we exercise the app.

```python
"""Heartbeat monitor for phase8b capture.
Polls the flows file every 5 seconds. Tracks:
- Total Whoop API requests
- Time since last request
- Last 3 unique paths captured (so we can see what app screen you're on)
Writes status to /tmp/whoop-mitm/heartbeat.log so the main agent can tail it."""
import time
import os
from datetime import datetime
from mitmproxy.io import FlowReader

FLOWS = "/tmp/whoop-mitm/phase8b-flows.mitm"
LOG = "/tmp/whoop-mitm/heartbeat.log"

def snapshot():
    if not os.path.exists(FLOWS) or os.path.getsize(FLOWS) == 0:
        return {"total": 0, "whoop": 0, "last_ts": None, "last_paths": []}
    total = 0
    whoop = 0
    last_ts = None
    last_whoop_paths = []
    try:
        with open(FLOWS, "rb") as f:
            for flow in FlowReader(f).stream():
                if not hasattr(flow, "request"):
                    continue
                total += 1
                ts = flow.request.timestamp_start
                if last_ts is None or ts > last_ts:
                    last_ts = ts
                if "api.prod.whoop.com" in flow.request.host:
                    whoop += 1
                    last_whoop_paths.append((ts, flow.request.path.split("?")[0]))
    except Exception as e:
        return {"error": str(e)}
    last_whoop_paths.sort(reverse=True)
    return {"total": total, "whoop": whoop, "last_ts": last_ts,
            "last_paths": [p for _, p in last_whoop_paths[:5]]}

with open(LOG, "w") as f:
    f.write(f"# heartbeat started {datetime.now().isoformat()}\n")

prev_total = 0
silent_since = None
while True:
    try:
        s = snapshot()
        now = time.time()
        line = []
        if "error" in s:
            line.append(f"[{datetime.now().strftime('%H:%M:%S')}] ERROR: {s['error']}")
        else:
            age = (now - s["last_ts"]) if s["last_ts"] else None
            age_str = f"{int(age)}s" if age is not None else "n/a"
            if s["total"] > prev_total:
                silent_since = None
            elif silent_since is None and prev_total > 0:
                silent_since = now
            silent_str = ""
            if silent_since is not None:
                silent_secs = int(now - silent_since)
                if silent_secs > 60:
                    silent_str = f"  ⚠️ NO NEW REQUESTS FOR {silent_secs}s — PROXY MAY BE DOWN"
            paths = " | ".join(p[-50:] for p in s["last_paths"][:3])
            line.append(
                f"[{datetime.now().strftime('%H:%M:%S')}] total={s['total']:4d} whoop={s['whoop']:4d} last_req={age_str:>5}{silent_str}"
            )
            if paths:
                line.append(f"  recent: {paths}")
            prev_total = s["total"]
        with open(LOG, "a") as f:
            f.write("\n".join(line) + "\n")
    except Exception as e:
        with open(LOG, "a") as f:
            f.write(f"[{datetime.now().strftime('%H:%M:%S')}] watcher error: {e}\n")
    time.sleep(5)
```

### How to run the pipeline yourself

1. Install mitmproxy: `pip install mitmproxy`
2. Start mitmproxy on your Mac: `mitmproxy --listen-port 8080 --set save_stream_file=/tmp/flows.mitm`
3. Install the mitmproxy CA cert on your iPhone (visit `mitm.it` in Safari while connected through the proxy)
4. Enable full trust in Settings → General → About → Certificate Trust Settings
5. Set iPhone Wi-Fi proxy to `Manual`, server = your Mac's local IP, port = 8080
6. Open the Whoop app, tap around, capture
7. Stop mitmproxy
8. Update `SOURCES` in `dump_combined.py` to point at your capture
9. Run: `python dump_combined.py`
10. Inspect `/tmp/whoop_combined/all.txt`

Important: **don't share the .mitm file**. It contains your access tokens, refresh tokens, and SMS MFA codes (the script redacts them in the text dump but the binary flows file is unredacted).

---

## Error message catalog

Specific error messages observed across the API, with the exact wire-level body text. Helpful when triaging a 4xx in the future.

### 400 errors

**Profile invalid country+state combo:**
```json
{"code": 400, "message": "Invalid state for country", "location": "line 1, column 73"}
```
Seen on `PUT /profile-service/v1/profile` with `country: "AS"` and `state: "AL"`.

**Profile invalid gender enum:**
```json
{"code": 400, "message": "Cannot deserialize value of type `com.whoop.users.models.v1.Gender` from String \"male\": not one of the values accepted for Enum class: [MALE, FEMALE, NON_BINARY, PREFER_NOT]"}
```
Seen on `PUT /profile-service/v1/profile` with lowercase `gender`. Whoop's GET returns lowercase, PUT requires uppercase.

**Profile invalid birthday:**
```json
{"code": 400, "message": "Valid birthday (YYYY-MM-DD) is required"}
```
Seen on `PUT /profile-service/v1/profile` with ISO datetime birthday like `"1990-01-01T00:00:00.000Z"`. The PUT only accepts date-only format.

**MCI invalid contraception_type:**
```json
{"code": 400, "message": "Cannot deserialize value of type `com.whoop.health.models.v1.hormonalinsights.ContraceptionType` from String \"IUD\": not one of the values accepted for Enum class: [VAGINAL_RING, ARM_IMPLANT, HORMONAL_IUD, INJECTION, NONE, PILL, NON_HORMONAL_IUD, PATCH]"}
```
Seen on `PUT /health-service/v1/hormonal-insights/settings/mci/survey`.

**MCI invalid interest:**
```json
{"code": 400, "message": "Cannot deserialize value of type `com.whoop.health.models.v1.hormonalinsights.settings.MCIInterest` from String \"TRACK_CYCLE\": not one of the values accepted for Enum class: [SUPPORT_REPRODUCTIVE_HEALTH_GOALS, OTHER_OR_NONE_OF_THE_ABOVE, MANAGE_HORMONAL_CONDITION, AVOID_PREGNANCY, ...]"}
```
(Truncated; there are at least 4 values.)

**Cycle endpoint requires contraception_type:**
```json
{"code": 400, "message": "User has no contraception status"}
```
Seen on `GET /womens-health-service/v1/menstrual-cycle-insights`. The user must run the MCI survey first.

**Create-activity malformed timestamps:**
```json
{"code": 400, "message": "Invalid start_time", "location": "line 1, column 31"}
```
Seen on `POST /core-details-bff/v2/create-activity` with `"May 25, 2026"`-style human dates. Must be ISO.

**Workout list limit too high:**
```json
{"errors": ["query param limit must be less than or equal to 25"]}
```
Seen on `GET /developer/v2/activity/workout?limit=50`. Cap is 25.

**Workout detail on pending activity:**
```json
{"code": 400, "message": "Cannot view activity details for a pending activity"}
```
Seen on `GET /core-details-bff/v1/cardio-details?activityId={just-created}`. Whoop hasn't computed the score yet; need to wait or query a different (scored) activity.

### 401 errors

**Access token expired:**
```json
{"__type": "NotAuthorizedException", "message": "Access Token has expired"}
```
Returned by the Cognito proxy on `GetUser` calls with stale tokens. The MCP's TokenManager catches this and refreshes.

**Refresh token expired:**
```json
{"__type": "NotAuthorizedException", "message": "Refresh Token has expired"}
```
After ~30 days. Re-bootstrap is required.

**Bad password:**
```json
{"__type": "NotAuthorizedException", "message": "Incorrect username or password."}
```

### 404 errors

**Feature not enabled:**
Empty body. Seen on `GET /growth-content-service/v1/advanced-labs/management/menu-item` for users without Advanced Labs.

**User not in leaderboard window:**
Empty body. Seen on `GET /community-service/v1/leaderboards/.../user/{user_id}` when the user has no data point in that window.

**Strap pairing already aligned:**
Empty body. Seen on `GET /membership-service/v2/straps/pairing-adjustment` when no adjustment is needed.

**Stress upload deprecated:**
Empty body. Seen on `POST /health-service/v2/stress-bff?timestamp=...`. The endpoint is likely deprecated; uploads happen via `/metrics-service/v1/metrics` now.

### 409 errors

**Workout time conflict:**
```
Client exception, status code: 409
```
Seen on `POST /weightlifting-service/v2/weightlifting-workout/activity` with a time range overlapping an existing workout.

### 422 errors

Body usually empty. Seen on:
- `POST /weightlifting-service/v2/weightlifting-workout/activity` when `exercise_details.created_at` or `updated_at` are empty strings.
- `PUT /profile-service/v1/profile` when the body is too partial (Whoop expects a near-complete profile).
- `POST /core-details-bff/v0/create-activity` when duration is < 1 minute.

### 428 errors

**Precondition missing:**
```json
{"code": 428, "message": "Precondition required"}
```
Seen once on `GET /membership?useReplica=true`. Likely missing an `If-Match` header.

### 500 errors

**Behavior impact for stale UUID:**
```
This is usually transient — try again in 30s.
```
Whoop returns 500 (not 404) on `GET /behavior-impact-service/v2/impact/details/{uuid}` when the UUID is from a different account or impact data has been purged. Should be a 404; isn't.

---

## Sports / activity-types catalog (197 entries)

Full list of sport / activity types from `GET /activities-service/v2/activity-types`. Each has an `internal_name` (canonical string ID), `display_name` (localized), `category` (muscular / cardiovascular / restorative / non-cardiovascular / sleep), `score_type` (CARDIO / RECOVERY / SLEEP), `has_gps` (whether the iOS app starts location tracking), and `msk_linkable` (whether the activity can be linked to a Strength Trainer session).

**Note:** the v2 catalog uses `internal_name` as the canonical ID. The v0 create-activity endpoint takes a numeric `sport_id` instead. The mapping between numeric `sport_id` and these `internal_name` strings is held client-side by the iOS app and not exposed via this API. Known IDs: sport_id 1 = running, 17 = manual. For others, see `/activities-service/v1/sports/history?countryCode=US` which returns 203 entries with a possibly-different shape.

**Categories observed:** muscular (32), cardiovascular (109), restorative (33), non-cardiovascular (21), sleep (2).

**`score_type` values:** CARDIO (162), RECOVERY (33), SLEEP (2).

**With GPS support:** 72 of 197.

**MSK-linkable:** 9 of 197 (these can be tied to a Strength Trainer workout).

#### cardiovascular (109)

| internal_name | display_name | score_type | GPS | MSK |
|---|---|---|---|---|
| `activity` | Activity | CARDIO | ✓ |  |
| `archery` | Archery | CARDIO |  |  |
| `assault-bike` | Assault Bike | CARDIO |  |  |
| `australian-football` | Australian Rules Football | CARDIO |  |  |
| `badminton` | Badminton | CARDIO |  |  |
| `ballet` | Ballet | CARDIO |  |  |
| `bartending` | Bartending | CARDIO |  |  |
| `basketball` | Basketball | CARDIO |  |  |
| `billiards` | Billiards | CARDIO |  |  |
| `bowling` | Bowling | CARDIO |  |  |
| `boxing` | Boxing | CARDIO |  |  |
| `caddying` | Caddying | CARDIO | ✓ |  |
| `cheeerleading ` | Cheerleading | CARDIO |  |  |
| `chess` | Chess | CARDIO |  |  |
| `cleaning` | Cleaning | CARDIO |  |  |
| `climber` | Vertical Climber | CARDIO |  |  |
| `commuting` | Commuting | CARDIO | ✓ |  |
| `cooking` | Cooking | CARDIO |  |  |
| `cross-country-skiing` | Cross Country Skiing | CARDIO | ✓ |  |
| `curling` | Curling | CARDIO |  |  |
| `cycling` | Cycling | CARDIO | ✓ |  |
| `dance` | Dance | CARDIO |  |  |
| `darts` | Darts | CARDIO |  |  |
| `dedicated_parenting` | Dedicated Parenting | CARDIO |  |  |
| `disc-golf` | Disc Golf | CARDIO | ✓ |  |
| `dj` | DJ | CARDIO | ✓ |  |
| `dog-walking` | Dog Walking | CARDIO | ✓ |  |
| `driving` | Driving | CARDIO | ✓ |  |
| `duathlon` | Duathlon | CARDIO | ✓ |  |
| `elliptical` | Elliptical | CARDIO |  |  |
| `fencing` | Fencing | CARDIO |  |  |
| `field-hockey` | Field Hockey | CARDIO |  |  |
| `football` | American Football | CARDIO |  |  |
| `freediving` | Freediving | CARDIO | ✓ |  |
| `gaelic-football` | Gaelic Football | CARDIO |  |  |
| `handball` | Handball | CARDIO |  |  |
| `hiking-rucking` | Hiking | CARDIO | ✓ |  |
| `hotdog-challenge` | Hot Dog Challenge | CARDIO | ✓ |  |
| `hurling-camogie` | Hurling/Camogie | CARDIO |  |  |
| `ice-hockey` | Ice Hockey | CARDIO |  |  |
| `ice-skating` | Ice Skating | CARDIO |  |  |
| `inline-skating` | Inline Skating | CARDIO | ✓ |  |
| `judo` | Judo | CARDIO |  |  |
| `jumping-rope` | Jumping Rope | CARDIO |  |  |
| `kickboxing` | Kickboxing | CARDIO |  |  |
| `lacrosse` | Lacrosse | CARDIO |  |  |
| `martial-arts` | Martial Arts | CARDIO |  |  |
| `motocross` | Motocross | CARDIO | ✓ |  |
| `motor-racing` | Motor Racing | CARDIO | ✓ |  |
| `mountain-biking` | Mountain Biking | CARDIO | ✓ |  |
| `mountaineering` | Mountaineering | CARDIO | ✓ |  |
| `muay-thai` | Muay Thai | CARDIO |  |  |
| `musical-performance` | Musical Performance | CARDIO |  |  |
| `netball` | Netball | CARDIO |  |  |
| `nordic-walking` | Nordic Walking | CARDIO | ✓ |  |
| `nursing-a-baby` | Nursing a Baby | CARDIO |  |  |
| `obstacle-course-racing` | Obstacle Course Racing | CARDIO | ✓ |  |
| `other` | Other | CARDIO | ✓ |  |
| `paddle-tennis` | Paddle Tennis | CARDIO |  |  |
| `paddleboarding` | Paddleboarding | CARDIO | ✓ |  |
| `padel` | Padel | CARDIO |  |  |
| `paintball` | Paintball | CARDIO | ✓ |  |
| `parkour` | Parkour | CARDIO | ✓ |  |
| `pickleball` | Pickleball | CARDIO |  |  |
| `poker` | Poker | CARDIO |  |  |
| `polo` | Polo | CARDIO | ✓ |  |
| `public-speaking` | Public Speaking | CARDIO |  |  |
| `pumping` | Pumping | CARDIO |  |  |
| `race-walking` | Race Walking | CARDIO | ✓ |  |
| `racquetball` | Racquetball | CARDIO |  |  |
| `refereeing` | Refereeing | CARDIO | ✓ |  |
| `roller-hockey` | Roller Hockey | CARDIO | ✓ |  |
| `rowing` | Rowing | CARDIO | ✓ |  |
| `rugby` | Rugby | CARDIO |  |  |
| `running` | Running | CARDIO | ✓ |  |
| `scootering` | Scootering | CARDIO | ✓ |  |
| `skateboarding` | Skateboarding | CARDIO | ✓ |  |
| `ski-touring` | Ski Touring | CARDIO | ✓ |  |
| `skydiving` | Skydiving | CARDIO | ✓ |  |
| `snowboarding` | Snowboarding | CARDIO | ✓ |  |
| `snowshoeing` | Snowshoeing | CARDIO | ✓ |  |
| `soccer` | Soccer | CARDIO |  |  |
| `spikeball` | Spikeball | CARDIO |  |  |
| `spin` | Spin | CARDIO |  |  |
| `sport_fishing` | Sport Fishing | CARDIO | ✓ |  |
| `sprint-training` | Sprint Training | CARDIO | ✓ |  |
| `squash` | Squash | CARDIO |  |  |
| `stadium-steps` | Stadium Steps | CARDIO | ✓ |  |
| `stairmaster` | Stairmaster | CARDIO |  |  |
| `stroller_jogging` | Stroller Jogging | CARDIO | ✓ |  |
| `stroller_walking` | Stroller Walking | CARDIO | ✓ |  |
| `surfing` | Surfing | CARDIO |  |  |
| `swimming` | Swimming | CARDIO | ✓ |  |
| `taekwondo` | Taekwondo | CARDIO |  |  |
| `tennis` | Tennis | CARDIO |  |  |
| `thrill-ride` | Thrill Ride | CARDIO | ✓ |  |
| `track-field` | Track & Field | CARDIO | ✓ |  |
| `trail-running` | Trail Running | CARDIO | ✓ |  |
| `trampoline` | Trampoline | CARDIO |  |  |
| `triathlon` | Triathlon | CARDIO | ✓ |  |
| `ultimate` | Ultimate Frisbee | CARDIO |  |  |
| `unicycling` | Unicycling | CARDIO | ✓ |  |
| `volleyball` | Volleyball | CARDIO |  |  |
| `water-polo` | Water Polo | CARDIO |  |  |
| `water-skiing` | Water Skiing | CARDIO | ✓ |  |
| `whoop_labs` | Whoop Labs | CARDIO | ✓ |  |
| `winter-biatholon` | Winter Biathlon | CARDIO | ✓ |  |
| `wrestling` | Wrestling | CARDIO |  |  |
| `yard-work` | Yard Work/Gardening | CARDIO |  |  |

#### muscular (32)

| internal_name | display_name | score_type | GPS | MSK |
|---|---|---|---|---|
| `baby_wearing` | Babywearing | CARDIO | ✓ |  |
| `barre` | Barre | CARDIO |  |  |
| `barre3` | Barre3 | CARDIO |  |  |
| `barrys` | Barry's | CARDIO |  | ✓ |
| `bodybuilding` | Bodybuilding | CARDIO |  | ✓ |
| `bouldering` | Bouldering | CARDIO | ✓ |  |
| `box-fitness` | Box Fitness | CARDIO |  | ✓ |
| `breakdancing` | Breakdancing | CARDIO |  |  |
| `canoeing` | Canoeing | CARDIO | ✓ |  |
| `f45-training` | F45 Training | CARDIO |  | ✓ |
| `firefighting` | Firefighting | CARDIO | ✓ |  |
| `functional-fitness` | Functional Fitness | CARDIO |  | ✓ |
| `hiit` | HIIT | CARDIO |  | ✓ |
| `hot-yoga` | Hot Yoga | CARDIO |  |  |
| `jiu-jitsu` | Jiu Jitsu | CARDIO |  |  |
| `kayaking` | Kayaking | CARDIO | ✓ |  |
| `kiteboarding` | Kite Boarding | CARDIO |  |  |
| `manual-labor` | Manual Labor | CARDIO | ✓ |  |
| `pilates` | Pilates | CARDIO |  |  |
| `powerlifting` | Powerlifting | CARDIO |  | ✓ |
| `reformer-pilates` | Reformer Pilates | CARDIO |  |  |
| `rock-climbing` | Rock Climbing | CARDIO | ✓ |  |
| `rucking` | Rucking | CARDIO | ✓ |  |
| `sculpt-yoga` | Sculpt Yoga | CARDIO |  |  |
| `snow-shoveling` | Snow Shoveling | CARDIO | ✓ |  |
| `solidcore` | solidcore | CARDIO |  |  |
| `toddler_wearing` | Toddlerwearing | CARDIO | ✓ |  |
| `wakeboarding` | Wakeboarding | CARDIO | ✓ |  |
| `weightlifting` | Weightlifting | CARDIO |  | ✓ |
| `weightlifting_msk` | Strength Trainer | CARDIO |  | ✓ |
| `wheelchair-pushing` | Wheelchair Pushing | CARDIO | ✓ |  |
| `yoga` | Yoga | CARDIO |  |  |

#### non-cardiovascular (21)

| internal_name | display_name | score_type | GPS | MSK |
|---|---|---|---|---|
| `baseball` | Baseball | CARDIO |  |  |
| `circus-arts` | Circus Arts | CARDIO |  |  |
| `coaching` | Coaching | CARDIO |  |  |
| `cricket` | Cricket | CARDIO |  |  |
| `diving` | Diving | CARDIO |  |  |
| `gaming` | Gaming | CARDIO |  |  |
| `golf` | Golf | CARDIO | ✓ |  |
| `gymnastics` | Gymnastics | CARDIO |  |  |
| `high-stress-work` | High Stress Work | CARDIO |  |  |
| `horseback-riding` | Horseback Riding | CARDIO | ✓ |  |
| `operations-flying` | Operations - Flying | CARDIO | ✓ |  |
| `operations-medical` | Operations - Medical | CARDIO | ✓ |  |
| `operations-tactical` | Operations - Tactical | CARDIO | ✓ |  |
| `operations-water` | Operations - Water | CARDIO | ✓ |  |
| `sailing` | Sailing | CARDIO | ✓ |  |
| `skiing` | Skiing | CARDIO | ✓ |  |
| `softball` | Softball | CARDIO |  |  |
| `stage-performance` | Stage Performance | CARDIO |  |  |
| `table-tennis` | Table Tennis/Ping Pong | CARDIO |  |  |
| `walking` | Walking | CARDIO | ✓ |  |
| `watching-sports` | Watching Sports | CARDIO |  |  |

#### restorative (33)

| internal_name | display_name | score_type | GPS | MSK |
|---|---|---|---|---|
| `accupuncture` | Acupuncture | RECOVERY |  |  |
| `air-compression` | Air Compression | RECOVERY |  |  |
| `air-compression-normatec` | Air Compression (Normatec) | RECOVERY |  |  |
| `breathwork` | Breathwork | RECOVERY |  |  |
| `bright-light-therapy` | Bright Light Therapy | RECOVERY |  |  |
| `chiropractor` | Chiropractor | RECOVERY |  |  |
| `cold-shower` | Cold Shower | RECOVERY |  |  |
| `contrast-therapy` | Contrast Therapy | RECOVERY |  |  |
| `cuddling_with_child` | Cuddling with Child | RECOVERY |  |  |
| `fishing` | Fishing | RECOVERY | ✓ |  |
| `foam_rolling` | Foam Rolling | RECOVERY |  |  |
| `hot_tub` | Hot Tub | RECOVERY |  |  |
| `ice-bath` | Ice Bath | RECOVERY |  |  |
| `increase_alertness` | Increase Alertness | RECOVERY |  |  |
| `increase_relaxation` | Increase Relaxation | RECOVERY |  |  |
| `infrared-sauna` | Infrared Sauna | RECOVERY |  |  |
| `knitting` | Knitting | RECOVERY |  |  |
| `massage-therapy` | Massage Therapy | RECOVERY |  |  |
| `meditation` | Meditation | RECOVERY |  |  |
| `non-sleep-deep-rest` | Non-Sleep Deep Rest | RECOVERY |  |  |
| `other-recovery` | Other - Recovery | RECOVERY |  |  |
| `percussive-massage` | Percussive Massage | RECOVERY |  |  |
| `percussive-massage-hypervolt` | Percussive Massage (Hypervolt) | RECOVERY |  |  |
| `playing_with_child` | Playing with Child | RECOVERY |  |  |
| `qigong` | QiGong | RECOVERY |  |  |
| `red_light_therapy` | Red Light Therapy | RECOVERY |  |  |
| `restorative-yoga` | Restorative Yoga | RECOVERY |  |  |
| `sauna` | Dry Sauna | RECOVERY |  |  |
| `sound-healing` | Sound Healing | RECOVERY |  |  |
| `steam-room` | Steam Room | RECOVERY |  |  |
| `stretching` | Stretching | RECOVERY |  |  |
| `tai-chi` | Tai Chi | RECOVERY |  |  |
| `warm-bath` | Warm Bath | RECOVERY |  |  |

#### sleep (2)

| internal_name | display_name | score_type | GPS | MSK |
|---|---|---|---|---|
| `nap` | Nap | SLEEP |  |  |
| `sleep` | Sleep | SLEEP |  |  |

---

## Feature-education flags (159 entries)

Every UPPER_SNAKE_CASE key returned by `GET /onboarding-service/v1/feature-education-state?userId=`. These represent first-time-user education modals that the app shows once and remembers. Setting one to `completed: true` via PUT prevents it from showing again.

```
ADVANCED_LABS_BRINGING_OWN
ADVANCED_LABS_EARLY_ACCESS_ONBOARDING
ADVANCED_LABS_ESTRADIOL_CYCLE_RANGES
ADVANCED_LABS_FAILED_TESTS
ADVANCED_LABS_FROM_BLOOD_DRAW
ADVANCED_LABS_FSH_CYCLE_RANGES
ADVANCED_LABS_LH_CYCLE_RANGES
ADVANCED_LABS_LINKING_BIOMARKERS
ADVANCED_LABS_ONBOARDING
ADVANCED_LABS_SPECIALIZED_PANELS_ONBOARDING
ADVANCED_LABS_SPECIALIZED_PANELS_WHAT_WE_MEASURE
ADVANCED_LABS_TEST_INFORMATION
ADVANCED_LABS_UNDERSTANDING_RESULTS
ADVANCED_LABS_UPLOADS_ONLY_ONBOARDING
ADVANCED_LABS_WHAT_WE_MEASURE
ALARM_SCHEDULING
ALARM_SCHEDULING_PLANNER
ARRHYTHMIA_EDUCATION
ARRHYTHMIA_FTU_EDUCATION
ARRHYTHMIA_FTU_HARVARD_EDUCATION
ARRHYTHMIA_INAPP
BIOMARKERS_WHOOP_DATA
BIOMARKER_DEEP_DIVE
CHARGE_EDUCATION
CHARGE_EDUCATION_50
CLINICIAN_REVIEWED_INSIGHTS
COACH_EVERYWHERE_DAY_ZERO
COACH_ONBOARDING
COACH_ONBOARDING_V2
COGNITIVE_PERFORMANCE
COMMUNITY_FOLLOWERS_ONBOARDING
COMMUNITY_ONBOARDING
COMPLETE_PICTURE_OF_YOUR_HEALTH
CONTEXT_HUB_EDUCATION
CUSTOMIZE_JOURNAL
CUSTOMIZE_JOURNAL_50
CUSTOM_EXERCISE_EDUCATION
CYCLE_STATS_EDUCATION
DATA_STREAK_EDUCATION
DATA_STREAK_EXPLAINER_PAGE
DATA_STREAK_MILESTONE_UNLOCK_EDUCATION
DATA_STREAK_MILESTONE_UNLOCK_EDUCATION_FIRST_TIME
DATA_STREAK_MILESTONE_UNLOCK_EDUCATION_REGULAR
DAY_ONE_TRANSITION
DEVICE_SETUP_STORY
ECG_EDUCATION
ECG_INAPP
EXERCISE_PROGRESS_EDUCATION
HEALTHSPAN_FITNESS_INAPP
HEALTHSPAN_INAPP
HEALTHSPAN_INAPP_15_DAY_UNLOCK
HEALTHSPAN_LABS_INTRODUCTION
HEALTHSPAN_ONBOARDING
HEALTHSPAN_SLEEP_INAPP
HEALTHSPAN_STRAIN_INAPP
HEART_HEALTH
HORMONAL_BALANCE
HORMONAL_BC_EDUCATION
HOW_TO_WEAR_EDUCATION
HOW_TO_WEAR_EDUCATION_50
HOW_WHOOP_COACH_WORKS_EDUCATION
HR_ZONES_EDUCATION_DETAILED_EXPLANATION
HR_ZONES_EDUCATION_WHY_CHANGE
INFLAMMATION
INTEGRATION_TEST
INTRADAY_JOURNAL_ONBOARDING
INTRADAY_JOURNAL_ONBOARDING_WITH_YESTERDAY
KOALA_ROLLOUT_EDUCATION
MCI_GRAPH_IN_APP
METABOLIC_HEALTH
NEW_HOME_INTRODUCTION
NUTRIENT_STATUS
OPTIMAL_BEDTIME_RECS_EDUCATION
OVERLAY_ACHIEVEMENTS_PROFILE
OVERLAY_ACTIVITY_DETAILS_MSK_BARRE
OVERLAY_ACTIVITY_DETAILS_MSK_PILATES
OVERLAY_ACTIVITY_DETAILS_MSK_SOLIDCORE
OVERLAY_ACTIVITY_DETAILS_MSK_YOGA
OVERLAY_COACH_EVERYWHERE
OVERLAY_CREATE_CUSTOM_EXERCISE_ANDROID
OVERLAY_CREATE_CUSTOM_EXERCISE_IOS
OVERLAY_DEVICE_SETTINGS_CHARGE_EDUCATION
OVERLAY_EXERCISE_PROGRESS
OVERLAY_EXERCISE_PROGRESS_EMPTY
OVERLAY_HEALTH_TAB
OVERLAY_HOME_DEEP_DIVES_RECOVERY
OVERLAY_HOME_DEEP_DIVES_SLEEP
OVERLAY_HOME_DEEP_DIVES_STRAIN
OVERLAY_STRENGTH_BUILDER_ACTIVITY_DETAILS
OVERLAY_STRENGTH_BUILDER_ACTIVITY_DETAILS_50
OVERLAY_STRENGTH_BUILDER_EXERCISE_LIBRARY
OVERLAY_STRENGTH_BUILDER_EXERCISE_LIBRARY_50
OVERLAY_STRENGTH_BUILDER_EXERCISE_VIEW
OVERLAY_STRENGTH_BUILDER_HOME
OVERLAY_STRENGTH_BUILDER_HOME_50
OVERLAY_STRENGTH_BUILDER_LIVE_SESSION
OVERLAY_STRENGTH_BUILDER_LIVE_SESSION_50
OVERLAY_STRENGTH_BUILDER_WORKOUT_BUILDER
OVERLAY_STRENGTH_BUILDER_WORKOUT_BUILDER_50
PAIRING_MODE_EDUCATION
PERSONALIZED_ACTION_PLAN
PHYSICAL_FITNESS
PREGNANCY_IN_APP
PREGNANCY_STORY
PREGNANCY_STORY_50
PREGNANCY_STORY_V2
QUARTERLY_RELEASE_ANNOUNCEMENTS_Q2_2026
QUARTERLY_RELEASE_ANNOUNCEMENTS_Q2_2026_ROW
QUATERLY_RELEASE_ANNOUNCEMENTS_Q2_2026
QUATERLY_RELEASE_ANNOUNCEMENTS_Q2_2026_ROW
RECOVERY_EDUCATION
SAGE_EDUCATION
SAGE_ONBOARDING
SAVE_JOURNAL
SAVE_JOURNAL_50
SEGMENTAL_BODY_COMPOSITION_EDUCATION
SLEEP
SLEEP_EDUCATION
SLEEP_EDUCATION_PLANNER
SLEEP_EDUCATION_V2
SLEEP_PLANNER_SCREEN
SP_BIOMARKERS_WHOOP_DATA
START_TRACKING_STEPS_WITH_WHOOP
STEPS_EDUCATION
STRAIN_EDUCATION
STRAIN_EDUCATION_V2
STRAIN_VS_RECOVERY
STRENGTH_TRAINING_TIME
STRENGTH_TRAINING_TIME_EXCLUDE_ACTIVITIES
STRESS_MONITOR
STRESS_MONITOR_STORY
STRESS_MONITOR_STORY_50
SYMPTOM_INSIGHTS_ONBOARDING
TRACK_YOUR_HEALTH
TRIAL_INFORMATION
WEIGHTLIFTING_EDUCATION
WEIGHTLIFTING_MSK_STORY
WEIGHTLIFTING_MSK_STORY_50
WEIGHT_CUSTOMIZE_TRENDS_EDUCATION
WEIGHT_CUSTOMIZE_TRENDS_EDUCATION_2
WEIGHT_TRENDS_EDUCATION
WELCOME_SCREEN_EDUCATION_FREE_TRIAL
WELCOME_SCREEN_EDUCATION_RETURN
WELCOME_SCREEN_EDUCATION_WHAT_TO_EXPECT
WHOOP_COACH_DATA_PRIVACY
WHOOP_COACH_DATA_PRIVACY_V2
WHOOP_COACH_RELEASE_NOTES
WHOOP_COACH_RELEASE_NOTES_V2
WHOOP_COACH_RELEASE_NOTES_V2.5
WHOOP_COACH_RELEASE_NOTES_V3.0
WHOOP_COACH_RELEASE_NOTES_V3.1
WHOOP_COACH_RELEASE_NOTES_V4.0
WHOOP_COACH_RELEASE_NOTES_V5.0
WHOOP_COACH_RELEASE_NOTES_V5.1
WHOOP_COACH_RELEASE_NOTES_V5.2
WHOOP_COACH_RELEASE_NOTES_V5.3
WIDGET_ONBOARDING_ANDROID
WIDGET_ONBOARDING_IOS
WU
```

---

## Feature-education content articles (141 entries)

The same endpoint also returns human-readable article titles representing in-app educational content (blog posts, podcasts, study writeups). These are content references, not feature flags.

```
10 Ways to Increase Your Heart Rate Variability (HRV)
12 Sleep Myths Debunked and One That May Be True
12 Tips & Benefits to Running in Cold Weather
13 Tips to Create a Nightly Routine to Sleep Better
4 Post-Marathon Tips for Faster Recovery
5 Cold Therapy Benefits + How to Try It
5 Vital Signs and How to Track Them
8 Features That Make WHOOP The Best Fitness Tracker For 2023
8 Tips for Running in Hot Weather
9 Reasons Why Your Heart Rate is High on Easy Runs
A Case Study at St. Paul’s: The Ability of WHOOP to Transform High School Sleep Habits
A Doctor's Heart Rate While Saving a Life & Combating Stress in the Intensive Care Unit
App Update: New Sleep Details Page
Ask Us Anything: WHOOP Strain
Average Resting Heart Rate for Women: What’s Normal & Why You Should Track It
Average Sleep by Age, Day of Week, Country & Much More
Benefits of Hydration and Tips to Stay Hydrated
Can You Get Too Much REM Sleep? Are You Getting Enough?
CrossFit Games Legend Rich Froning Talks Workouts, Recovery & Career Longevity
Deep Sleep vs. REM Sleep: What are the Differences?
Doctor Explains Sleep Deprivation and How it Affects HRV
Does Exercise Help Period Cramps? FAQs About Menstruation
Does Magnesium Before Bed Improve Your Sleep?
Drew Manning AMA: Diet, Workouts & Losing Weight at 40
Everything You Need to Know About Heart Rate Variability (HRV)
Everything You Want to Know About Sleep & Tracking It with WHOOP
Football Hangovers on Valentine's Day: Breaking Down the Data
Four Easy Steps to Boost Your Night-Time Workout
Heart Rate Recovery: Why it's a Sign of Fitness & How to Improve it
Here’s Why Every Runner Should Use WHOOP
How Blood Pressure Insights Work
How Does WHOOP Recovery Work?
How Does WHOOP Strain Work?
How Golfer Rory Mcllroy Stays On Top of His Game with Performance Coach Ro Sharma
How Long Does Alcohol Stay in Your System and What Does it Do to It?
How Much More Do We Sleep and Drink Around the Holidays?
How Much Sleep Do Adults Need?
How Much Sleep Do I Need? The WHOOP Sleep Coach Has the Answer
How Often Should You Run to Optimize Training?
How Physical Activity Increases Dopamine
How Sleep Affects Weight Loss
How Strenuous is the Tour de France? Plus Other Biometric Data Insights
How to Rethink Anxiety: It Can Be a Sign Your Body is Ready to Perform!
How to Sleep Better at Night Naturally (and with Supplements)
How whoop measures blood pressure
Impact of Marijuana on Sleep, Resting Heart Rate & HRV
Impact of Stress on HRV, Resting Heart Rate & Recovery
International Rugby Stars Conor Murray & Anthony Watson Unlocking Performance with WHOOP
Introducing Strength Trainer: A New Way to Quantify The Impact of Your Strength Training
Journaling Can Benefit Your Sleep and HRV
Leveraging WHOOP Technology to Predict COVID-19 Risk
Lionel Sanders’ Heart Rate, Strain, Sleep & Recovery Data from Ironman 70.3 Victory
Murph Challenge Tips from CrossFit’s Haley Adams and Noah Ohlsen
Muscles to Strengthen for Golf & Exercises to Improve Your Swing
Naps: Ideal Length, Benefits and Reducing Sleep Need
New WHOOP 4.0 Metric: Blood Oxygen Monitoring
New WHOOP 4.0 Metric: Skin Temperature
New WHOOP Feature: Menstrual Cycle Coaching
New WHOOP Study Reveals the Relationship between Sleep Consistency and Mental Health
Patrick Mahomes: The Data Behind an NFL Season with WHOOP
Podcast 102: Respiratory Rate Research & Pro Golfer Scott Stallings on COVID
Podcast 131: Understanding Stress and How it Affects Sleep Performance & Cognitive Functioning
Podcast 143: Endurance Coach Chris Hinshaw on Increasing Aerobic Capacity and Managing Intensity
Podcast 145: The Science of Sleep with Dr. Meeta Singh
Podcast 147: Understanding Metabolic Health with Dr. Casey Means
Podcast 148: The Science of Recovery with Dr. Robin Thorpe
Podcast 157: Dr Hazel Wallace Talks Nutrition and Habit Formation
Podcast 158: The Science of Strain with Dr. Andy Walshe
Podcast 164: Dr. Allison Brager on Health Effects of Sleep Deprivation
Podcast 165: Dr. Shon Rowan on Pregnancy Exercise & HRV Study
Podcast 179: Dr. Samer Hattar on Circadian Health & Light Exposure
Podcast 195: Dr. Andrew Huberman On Reducing Stress, Sleeping Better, and Optimizing Your Health
Podcast 199: Shift Work, Jet Lag, and Changes to Your Circadian Rhythms with Dr. Greg Potter
Podcast 200: How Exercise Improves Cognitive Function & Longevity with Dr. Tommy Wood
Podcast 204: How to Break and Build Habit Loops with Dr. Jud Brewer
Podcast 215: Introducing Stress Monitor, A New Way to Measure & Manage Stress
Podcast 219: Behind the Development of The All-New Strength Trainer
Podcast 222: The Rise of Zone 2 Training and Why It's Essential for Training
Podcast 228: Listener Questions on HRV, Fasting, and the Impact of Vices on Performances
Podcast 229: A Behavioral Psychologist's Tips to Identifying and Managing Stress Styles with Dr. Jemma King
Podcast 230: Pro Cyclist Alison Jackson On Her Uncharted Path To The Podium
Podcast 231:
Podcast 232: Everything to Know About Zone 2 Training from a Sports Scientist
Podcast 233: Resistance Training Tips from a Champion Bodybuilder Brad Schoenfeld
Podcast No. 29: Heart Rate Variability (HRV), with Kristen Holmes and Emily Capodilupo
Podcast No. 48: Understanding the Science of Tracking Calories
Podcast No. 50: Holiday Hacks--Travel Better, Eat Smarter, Reduce Stress
Podcast No. 96: Nutrition Insights with Performance Chef Dan Churchill
Positive Impact of Eating Fruits and Vegetables on Strain, Recovery & Resting Heart Rate
Pregnancy Study Shows Benefits of Exercise, Useful Trends in HRV & RHR
Pregnancy is an Endurance Event & WHOOP is Helping Me Track It
Purpose, Efficacy, Control: Track Mental Health in WHOOP Journal
Recovery Tips from Leading WHOOP Members
Resting Heart Rate: What’s Normal, Why It’s a Sign of Fitness, How to Improve It
Sleep Coach Update: Incorporating Menstrual Cycle Phase for Increased Accuracy
Sleep Consistency: Why We Track it and How Do You Compare?
Sleep Hygiene Tips from CrossFit's "Sleep Queen" Brooke Wells
Spending Time Outdoors Can Increase Your Next-Day Recovery
Target the Anaerobic Heart Rate Zone: Benefits and Exercise
The Benefits of Cardio vs. Strength Training
The Benefits of Mindfulness & How to Practice It
The Benefits of Mouth Taping for Sleep
The Benefits of a No-Sound Alarm to Improve How You Wake Up
The Best Stretches to Do Before Running
The Misconceptions on Women's Physiology: What's Your Story?
The Science of Calorie Tracking
The Three Types of Stress—and How to Find Relief
The Truth About the Fat Burning Heart Rate Zone
Three Types of Stress—and How to Find Relief
Track Macronutrients to Be More Efficient with Your Shopping & Nutrition
US Ski Coach Mike Day Talks Training with WHOOP
Understanding 4 Types of Strength Training
Understanding Circadian Rhythm & Benefits of Maintaining It with Sleep Consistency
Understanding Pregnancy with Groundbreaking New Research & Pregnancy Coaching
Understanding Respiratory Rate: What it Is, What's Normal & Why You Should Track It
Understanding your reading
WHOOP 4.0 Feature: Sleep Coach with Haptic Alerts
WHOOP Announces Scientific Advisory Council to Advance Its Mission to Unlock Human Performance
WHOOP Feature: The Health Monitor
WHOOP Features Support Reproductive Health Through All Life Stages
WHOOP Pregnancy Data: Trends in Resting Heart Rate, HRV, Strain, Sleep & More
WHOOP Study Tracks Professional Cyclists In First of Its Kind Continuous Race Monitoring
WHOOP and Hyperice Partner to Enhance Understanding of Recovery
What Causes an Increased Respiratory Rate?
What Does an Infection Do to Your Respiratory Rate?
What Impact Do Seasonal Allergies Have on Your Sleep, Recovery, HRV & Respiratory Rate?
What is Active Recovery? 7 Active Recovery Workouts
What is Blood Oxygen, What Are Normal Levels & How to Measure It
What is Non-Sleep Deep Rest (NSDR) + How it Impacts Performance
What is Sleep Debt & How Do You Catch Up on Sleep?
What is a Good HRV? It Varies for Everyone
What is blood pressure?
What is the Aerobic Heart Rate Zone and How Do You Target it?
What’s More Strenuous Than the Tour de France?
What’s a Normal Heart Rate for My Age?
Why Sleep is Crucial for Your Mental Health
Why WHOOP Doesn't Count Steps
Why You Should Work Out During Your Period
Why Zone 2 Training is the Secret to Unlocking Peak Performance
Why does it matter?
advanced_labs_video
```

---

## Overlay catalog (22 entries)

Every overlay name returned by `GET /onboarding-service/v1/overlay/all`. Overlays are the full-screen teach-me modals shown the first time the user opens specific screens.

```
COACH_ONBOARDING_V2
HEALTHSPAN_LABS_INTRODUCTION
OVERLAY_ACTIVITY_DETAILS_MSK_BARRE
OVERLAY_ACTIVITY_DETAILS_MSK_PILATES
OVERLAY_ACTIVITY_DETAILS_MSK_SOLIDCORE
OVERLAY_ACTIVITY_DETAILS_MSK_YOGA
OVERLAY_COACH_EVERYWHERE
OVERLAY_CREATE_CUSTOM_EXERCISE_ANDROID
OVERLAY_CREATE_CUSTOM_EXERCISE_IOS
OVERLAY_DEVICE_SETTINGS_CHARGE_EDUCATION
OVERLAY_EXERCISE_PROGRESS
OVERLAY_EXERCISE_PROGRESS_EMPTY
OVERLAY_HEALTH_TAB
OVERLAY_HOME_DEEP_DIVES_RECOVERY
OVERLAY_HOME_DEEP_DIVES_SLEEP
OVERLAY_HOME_DEEP_DIVES_STRAIN
OVERLAY_STRENGTH_BUILDER_ACTIVITY_DETAILS
OVERLAY_STRENGTH_BUILDER_EXERCISE_LIBRARY
OVERLAY_STRENGTH_BUILDER_EXERCISE_VIEW
OVERLAY_STRENGTH_BUILDER_HOME
OVERLAY_STRENGTH_BUILDER_LIVE_SESSION
OVERLAY_STRENGTH_BUILDER_WORKOUT_BUILDER
```

---

## Full journal behavior catalog (308 entries)

Every behavior in `src/data/behaviors.ts`. The ID is the canonical `behavior_tracker_id` used in `tracker_inputs`. The `internal_name` is what appears in Whoop's URLs and analytics.



### Drugs & Medication (24)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 3 | Marijuana | Used marijuana? | `marijuana` |
| 5 | Tobacco | Used tobacco in any form? | `tobacco` |
| 9 | Anti-Anxiety Medication | Took anti-anxiety medication? | `anti-anxiety-medication` |
| 10 | Anti-Inflammatory Drugs (e.g. Ibuprofen) | Took an anti-inflammatory drug (NSAIDs)? | `anti-inflammatory-drugs` |
| 11 | Prescription Pain Medication | Took prescription pain medication? | `prescription-pain-medication` |
| 12 | Prescription Sleep Medication | Took prescription sleep medication? | `prescription-sleep-medication` |
| 63 | Blood Pressure Medication | Took blood pressure medication? | `blood-pressure-medication` |
| 67 | COVID-19 Vaccination (Dose #1) | Received dose #1 of COVID-19 vaccination? | `covid-19-vaccination-dose-1` |
| 68 | COVID-19 Vaccination (Dose #2) | Received dose #2 of COVID-19 vaccination? | `covid-19-vaccination-dose-2` |
| 103 | Chemotherapy | Received chemotherapy? | `chemotherapy` |
| 112 | COVID-19 Vaccination (Booster) | Received booster of COVID-19 vaccination? | `covid-19-vaccination-booster` |
| 129 | Radiation Therapy | Received radiation therapy? | `radiation-therapy` |
| 134 | AD(H)D Medication | Took AD(H)D medication? | `adhd-medication` |
| 175 | Weight-Loss Medication | Took weight-loss medication? | `weight-loss-medication` |
| 203 | GLP-1 | Took a GLP-1? | `glp-1` |
| 204 | Ketamine | Took Ketamine? | `ketamine` |
| 205 | LSD | Took LSD (lysergic acid diethylamide)? | `lsd` |
| 206 | Psilocybin | Took Psilocybin (Magic Mushrooms)? | `psilocybin` |
| 207 | Nicotine | Consumed nicotine? | `nicotine` |
| 263 | Allergy Medication | Took allergy medication? | `allergy-medication` |
| 334 | SSRI Medication | Took SSRI medication? | `ssri_medication` |
| 336 | Beta Blockers | Took beta blocking medication? | `beta_blockers` |
| 338 | Accutane | Took Accutane? | `accutane` |
| 339 | Ivabradine | Took Ivabradine? | `ivabradine` |

### Health & Symptoms (44)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 40 | Injury | Have an injury or wound? | `injury` |
| 41 | Sickness | Feeling sick or ill? | `sickness` |
| 56 | COVID-19 Symptoms | Experiencing COVID-19 symptoms? | `covid-19-symptoms` |
| 80 | Bloating | Experienced bloating? | `bloating` |
| 81 | Hot Flash During Sleep | Had a hot flash while sleeping? | `hot-flashes` |
| 93 | Energy Level | Felt energized throughout the day? | `energy-level` |
| 97 | Seasonal Allergies | Experienced seasonal allergies? | `seasonal-allergies` |
| 122 | Fever | Experiencing a fever? | `fever` |
| 144 | Monkeypox Symptoms | Experiencing monkeypox symptoms? | `monkeypox-symptoms` |
| 177 | Headache | Experienced a headache? | `headache` |
| 178 | Migraine | Experienced a migraine? | `migraine` |
| 210 | Acne | Experienced acne? | `acne` |
| 211 | Fatigue | Experienced fatigue? | `fatigue` |
| 214 | Muscle/Body Aches | Experienced muscle or body aches? | `muscle/body-aches` |
| 215 | Back Pain | Experienced back pain? | `back-pain` |
| 216 | Heartburn | Experienced heartburn? | `heartburn` |
| 217 | Gas | Experienced excessive gas? | `gas` |
| 218 | Constipation | Experienced constipation? | `constipation` |
| 219 | Vomiting | Experienced vomiting? | `vomiting` |
| 220 | Food Cravings | Experienced food cravings? | `food-cravings` |
| 221 | Brain Fog | Experienced brain fog? | `brain-fog` |
| 232 | Hot Flashes During the Day | Experienced hot flashes during the day? | `hot-flashes-during-day` |
| 233 | Temperature Sensitivity | Felt unusually sensitive to temperature changes? | `temperature-sensitivity` |
| 235 | Night Sweats | Noticed night sweats disrupting sleep? | `night-sweats` |
| 236 | Forgetfulness | Experienced memory lapses or forgetfulness? | `forgetfulness` |
| 240 | Joint Pain or Stiffness | Experienced joint pain or stiffness? | `joint-pain-or-stiffness` |
| 241 | Hair Thinning/Loss | Noticed thinning hair or hair loss? | `hair-thinning-loss` |
| 242 | Skin Changes | Noticed skin changes, like dryness or sensitivity? | `skin-changes` |
| 244 | Heart Palpitations | Experienced heart palpitations today? | `heart-palpitations` |
| 246 | Tingling / Numbness | Experienced tingling or numbness in extremities? | `tingling-numbness` |
| 247 | Dizzy / Lightheadedness | Felt dizzy or lightheaded today? | `dizzy-lightheadedness` |
| 264 | Nightmare | Had a nightmare? | `nightmare` |
| 333 | Bowel Movements | Experienced bowel movements? | `bowel_movements` |
| 348 | Tinnitus | Experienced Tinnitus? | `tinnitus` |
| 363 | Soreness | Experienced muscle soreness? | `soreness` |
| 364 | Congestion | Felt congested? | `congestion` |
| 365 | Indigestion | Experienced indigestion? | `indigestion` |
| 366 | Dialysis | Received dialysis treatment? | `dialysis` |
| 367 | Concussion | Felt concussed? | `concussion` |
| 368 | Food Sensitivity | Experienced food sensitivity? | `food_sensistivity` |
| 388 | Chills | Experienced chills? | `chills` |
| 389 | Diarrhea | Experienced diarrhea? | `diarrhea` |
| 390 | Dry Skin | Is your skin drier than usual? | `dry_skin` |
| 391 | Nausea | Experienced nausea? | `nausea` |

### Hormonal Health (43)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 43 | Menstruation | Menstruating? | `menstruation` |
| 45 | Pregnancy | Pregnant? | `pregnancy` |
| 79 | Ovulation | Ovulating? | `ovulation` |
| 82 | Menstrual Cramps | Experiencing menstrual cramps? | `menstrual-cramps` |
| 123 | Conception | Trying to conceive? | `conception` |
| 124 | Perimenopause | Experiencing symptoms of perimenopause? | `perimenopause` |
| 125 | Postmenopause | Experiencing symptoms of postmenopause? | `postmenopause` |
| 128 | Luteinizing Hormone (LH) Test | Took a Luteinizing hormone test? | `luteinizing-hormone-test` |
| 184 | Pumping | Breast milk pumping? | `pumping` |
| 212 | Breast Growth | Noticed breast growth? | `breast-growth` |
| 222 | Vaginal Spotting | Noticed vaginal spotting? | `vaginal-spotting` |
| 223 | Vaginal Discharge - Creamy | Noticed vaginal discharge is creamy? | `vaginal-discharge---creamy` |
| 224 | Vaginal Discharge - Egg White | Noticed vaginal discharge has egg white consistency? | `vaginal-discharge---egg-white` |
| 225 | Vaginal Discharge - Grey | Noticed vaginal discharge is grey? | `vaginal-discharge---grey` |
| 226 | Vaginal Discharge - Sticky | Noticed vaginal discharge is sticky? | `vaginal-discharge---sticky` |
| 227 | Vaginal Dryness | Experienced vaginal dryness? | `vaginal-dryness` |
| 228 | Increased Libido | Experienced increased libido? | `increased-libido` |
| 229 | Decreased Libido | Experienced decreased libido? | `decreased-libido` |
| 230 | Mood Swings | Experienced mood swings? | `mood-swings` |
| 231 | Pelvic Pain | Experienced pelvic pain? | `pelvic-pain` |
| 237 | Sleep Quality Decline | Experienced reduced sleep quality due to menopausal symptoms? | `sleep-quality-decline` |
| 238 | Painful Intercourse | Had discomfort or pain during intercourse? | `painful-intercourse` |
| 239 | Urinary Symptoms | Experienced urinary symptoms (e.g., urgency or incontinence)? | `urinary-symptoms` |
| 243 | Breast Tenderness | Experienced breast tenderness? | `breast-tenderness` |
| 245 | Body Odor Changes | Noticed changes in body odor today? | `body-odor-changes` |
| 248 | Cycle Irregularity | Experienced cycle irregularity or missed periods? | `cycle-irregularity` |
| 249 | HRT | Used combination hormone replacement therapy (HRT)? | `hrt` |
| 250 | Progesterone | Took progesterone supplements or injections? | `progesterone` |
| 251 | Progesterone Creams | Took over-the-counter progesterone creams? | `progesterone-creams` |
| 252 | Estrogen | Took estrogen-only supplements or patches? | `estrogen` |
| 253 | Vaginal Estrogen Cream | Used vaginal estrogen creams? | `vaginal-estrogen-cream` |
| 254 | Vaginal Estrogen Rings | Used vaginal estrogen rings? | `vaginal-estrogen-rings` |
| 255 | Vaginal Estrogen Tablets | Used vaginal estrogen tablets? | `vaginal-estrogen-tablets` |
| 256 | Testosterone Supplements | Took testosterone supplements? | `testosterone-supplements` |
| 257 | Anti-Androgen | Took anti-androgen medication (e.g., Spironolactone)? | `anti-androgen` |
| 258 | Testosterone Gel/Cream | Used testosterone gel or cream? | `testosterone-gel-cream` |
| 259 | Gabapentin | Used gabapentin for menopausal symptoms? | `gabapentin` |
| 260 | Clonidine | Used clonidine for menopausal symptoms, e.g. hot flashes? | `clonidine` |
| 261 | Thyroid Medication | Took thyroid medication to manage hormonal imbalances? | `thyroid-medication` |
| 262 | DHEA | Took DHEA supplements for adrenal support? | `dhea` |
| 396 | Vaginal Discharge - Watery | Noticed vaginal discharge is watery? | `vaginal-discharge---watery` |
| 397 | Cervical Mucus: Pink, Brown, or Tan | Is your cervical mucus pink, brown, or tan? | `cervical_mucus_pink_brown_or_tan` |
| 398 | No Menstrual Flow | Experienced period but no menstrual flow? | `no_menstrual_flow` |

### Lifestyle (33)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 1 | Alcohol | Have any alcoholic drinks? | `alcohol` |
| 2 | Caffeine | Consumed caffeine? | `caffeine` |
| 4 | Sexual Activity | Engaged in sexual activity? | `sexual-activity` |
| 7 | Air Travel | Traveled on a plane? | `air-travel` |
| 42 | Parenting | Parenting an infant? | `parenting` |
| 44 | Nursing | Nursing? | `nursing` |
| 50 | Intermittent Fasting | Followed an intermittent fasting diet? | `intermittent-fasting` |
| 54 | Masturbation | Masturbated? | `masturbation` |
| 55 | Relationship Status | Single? | `relationship-status` |
| 60 | Caregiving | Cared for the health of another? | `caregiving` |
| 78 | Nursing Infant | Nursing an infant? | `nursing-infant` |
| 83 | Ramadan | Observing Ramadan? | `ramadan` |
| 98 | On-Call Shift | Worked an on-call shift? | `on-call-shift` |
| 99 | Night Shifts | Worked the night shift? | `night-shifts` |
| 100 | Work Late | Worked late? | `work-late` |
| 101 | Jet Lag | Experienced jet lag? | `jet-lag` |
| 102 | Work Commute | Commuted to work? | `work-commute` |
| 117 | Work Calls | Spent time on work video calls? | `work-calls` |
| 118 | Remote Work | Worked from home? | `remote-work` |
| 120 | Outdoor Time | Spend time outdoors? | `outdoor-time` |
| 132 | Family and Friends | Connected with family and/or friends? | `family-and-friends` |
| 152 | Vacation | Took a vacation day? | `vacation` |
| 172 | Parenting Sick Child | Parenting a sick child? | `parenting-sick-child` |
| 186 | Feeding Baby at Night | Woke up for a nighttime feed? | `feeding-baby-at-night` |
| 196 | Shared Bedroom With Child | Shared a sleeping space with a child? | `shared-bedroom-with-child` |
| 295 | Standing Desk | Used standing desk? | `standing-desk` |
| 349 | Video Games | Played video games? | `video_games` |
| 350 | Car or Train travel | Travelled in a car or train? | `car_or_train_travel` |
| 351 | Social Media | Used social media? | `social_media` |
| 369 | Blood Donation | Donated blood? | `blood_donation` |
| 370 | Plasma Donation | Donated plasma? | `plasma_donation` |
| 371 | Platelet Donation | Donated platelets? | `platelet_donation` |
| 372 | Camping | Camped outdoors? | `camping` |

### Mental Wellbeing (28)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 46 | Stress | Experienced stress? | `stress` |
| 64 | Purpose | Felt a sense of purpose? | `purpose` |
| 65 | Control | Felt you had control over your life? | `control` |
| 66 | Efficacy | Felt you had the resources/skills needed to complete your daily goals? | `efficacy` |
| 92 | Emotional/Mental State | Felt emotionally and mentally stable? | `emotional-mental-state` |
| 94 | Motivation | Felt motivated? | `motivation` |
| 95 | Irritability | Felt Irritable? | `irritability` |
| 96 | Therapy Session | Had a therapy session? | `therapy` |
| 116 | Gratitude | Expressed gratitude? | `gratitude` |
| 119 | Journaling | Journaled your thoughts? | `journaling` |
| 121 | Social Fulfillment | Felt socially fulfilled? | `social-fulfillment` |
| 130 | Make Progress | Made progress on an important goal? | `make-progress` |
| 131 | Learning | Learned something interesting or important? | `learning` |
| 133 | Spirituality | Engaged in spiritual practice? | `spirituality` |
| 135 | Anxiety | Felt nervous or anxious? | `anxiety` |
| 136 | Positivity | Feel generally positive about the future? | `positivity` |
| 137 | Depression | Felt depressed or down? | `depression` |
| 208 | Threat | Faced threats? | `threat` |
| 209 | Challenge | Faced challenges? | `challenge` |
| 266 | Socially drained | Felt socially drained? | `socially-drained` |
| 273 | Solo time | Had some solo time? | `solo-time` |
| 352 | Relationship Stress | Experienced stress in a relationship? | `relationship_stress` |
| 374 | Loneliness | Experienced loneliness? | `loneliness` |
| 386 | Flow State | Experienced flow state? | `flow_state` |
| 392 | Overwhelm | Feeling overwhelmed? | `overwhelm` |
| 393 | Reduced Motivation | Experienced reduced motivation? | `reduced_motivation` |
| 394 | Social Withdrawal | Experienced social withdrawal? | `social_withdrawal` |
| 395 | Trouble Concentrating | Having trouble concentrating? | `trouble_concentrating` |

### Nutrition (41)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 14 | Meat | Consumed meat? | `meat` |
| 15 | Paleo Diet | Following a paleo diet? | `paleo-diet` |
| 16 | Vegetarian Diet | Following a vegetarian diet? | `vegetarian-diet` |
| 51 | Ketogenic Diet | Followed a ketogenic diet? | `ketogenic-diet` |
| 57 | Hydration | Hydrated sufficiently? | `hydration` |
| 84 | Fruits and Vegetables | Consumed fruits and/or vegetables? | `fruits-and-veggies` |
| 85 | Carbohydrates | Consumed carbohydrates? | `carbohydrates` |
| 86 | Clean Eating | Avoided processed foods? | `clean-eating` |
| 87 | Gluten-Free Diet | Following a gluten-free diet? | `gluten-free-diet` |
| 88 | Dairy | Consumed dairy? | `dairy` |
| 89 | Protein | Consumed protein? | `protein` |
| 90 | Added Sugar | Consumed added sugar? | `added-sugar` |
| 91 | Fats | Consumed fats? | `fats` |
| 113 | Kosher Diet | Following a kosher diet? | `kosher-diet` |
| 114 | Dairy-Free Diet | Following a dairy-free diet? | `dairy-free-diet` |
| 115 | Vegan Diet | Following a vegan diet? | `vegan-diet` |
| 141 | Snacking | Snacked in between meals? | `snacking` |
| 145 | Calories | Tracked your calories? | `calories` |
| 167 | Sodium | Consumed sodium? | `sodium` |
| 168 | Fiber | Consumed fiber? | `fiber` |
| 169 | Magnesium | Consumed magnesium? | `magnesium` |
| 170 | Calcium | Consumed calcium? | `calcium` |
| 267 | Lunch  | Ate lunch? | `lunch` |
| 268 | Dinner  | Ate dinner? | `dinner` |
| 269 | Breakfast  | Ate breakfast? | `breakfast` |
| 270 | Morning Snack  | Ate a morning snack? | `morning-snack` |
| 271 | Afternoon Snack  | Ate an afternoon snack? | `afternoon-snack` |
| 272 | Evening Snack  | Ate an evening snack? | `evening-snack` |
| 274 | Plant-based protein | Ate plant-based protein? | `plant-based-protein` |
| 275 | Restaurant | Ate at a restaurant? | `restaurant` |
| 276 | Home-cooked | Ate home-cooked food? | `home-cooked` |
| 277 | Takeout | Ate takeout? | `takeout` |
| 297 | Herbal Tea | Drank herbal tea? | `herbal-tea` |
| 298 | Post meal walk | Walked after a meal? | `post-meal-walk` |
| 300 | Chicken/Poultry | Consumed chicken/poultry? | `chicken-poultry` |
| 301 | Beans | Consumed beans? | `beans` |
| 302 | Tofu  | Consumed tofu? | `tofu` |
| 303 | Nuts | Consumed nuts? | `nuts` |
| 304 | Ate before workout | Ate before workout? | `ate-before-workout` |
| 375 | Halal Diet | Following a Halal diet? | `halal_diet` |
| 387 | Dark Chocolate | Consumed dark chocolate? | `dark_chocolate` |

### Recovery (35)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 18 | Acupuncture | Received acupuncture therapy? | `acupuncture` |
| 20 | Cupping | Received cupping therapy? | `cupping` |
| 23 | Massage Therapy | Received massage therapy? | `massage-therapy` |
| 24 | Meditation | Meditated? | `meditation` |
| 25 | Sensory Deprivation | Used a sensory deprivation tank? | `sensory-deprivation` |
| 26 | Stretching | Spent time stretching? | `stretching` |
| 48 | Ice Bath | Took an ice bath? | `ice-bath` |
| 49 | Cryotherapy | Used cryotherapy treatment? | `cryotherapy` |
| 52 | Sauna | Used a sauna? | `sauna` |
| 53 | Steam Room | Used a steam room? | `steam-room` |
| 62 | Breathwork | Practiced breathwork? | `breathwork` |
| 69 | Hyperbaric Chamber | Used a hyperbaric chamber? | `hyperbaric-chamber` |
| 70 | Red Light Therapy | Received red light therapy? | `red-light-therapy` |
| 71 | Physical Therapy | Received physical therapy? | `physical-therapy` |
| 72 | Chiropractor | Visited the chiropractor? | `chiropractor` |
| 126 | Recovery | Felt recovered? | `recovery` |
| 127 | Compression Therapy | Did compression therapy? | `compression-therapy` |
| 155 | Cold Shower | Took a cold shower? | `cold-shower` |
| 157 | Hot Tub | Spent time in a hot tub? | `hot-tub` |
| 163 | Zone 2 Cardio | Did Zone 2 cardio? | `zone-2-cardio` |
| 278 | Warm Bath | Took a warm bath? | `warm-bath` |
| 296 | Vagus nerve stimulation | Used device for vagus nerve stimulation? | `vagus-nerve-stimulation` |
| 353 | Grounding or Earthing | Practiced grounding or earthing? | `grounding_or_earthing` |
| 354 | Foam Roller | Used a foam roller for muscle tension? | `foam_roller` |
| 355 | Inversion Table | Used an inversion table? | `inversion_table` |
| 356 | Percussive Massage | Used a percussive massager (e.g., Hypervolt, Theragun)? | `percussive_massage` |
| 357 | Contrast Therapy | Practiced contrast therapy (hot/cold)? | `contrast_therapy` |
| 358 | Infrared PEMF Mat | Used an infrared PEMF Mat? | `infrared_pemf_mat` |
| 359 | Sound bath | Participated in a sound bath? | `sound_bath` |
| 360 | Cooling Pad | Used a cooling pad for muscle recovery? | `cooling_pad` |
| 361 | Heating Pad | Used a heating pad for muscle recovery? | `heating_pad` |
| 376 | Rest Day | Took a rest day? | `rest_day` |
| 377 | Epsom Salt Bath | Took a bath with epsom salts? | `epsom_salt_bath` |
| 378 | Grounding Sheet | Slept with a grounding or earthing sheet? | `grounding_sheet` |
| 379 | Aromatherapy | Used aromatherapy/essential oils for relaxation? | `aromatherapy` |

### Sleep & Circadian Health (33)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 6 | Late Meal | Ate food close to bedtime? | `late-meal` |
| 8 | Device (e.g. Phone) in Bed | Viewed a screen device in bed? | `device-in-bed` |
| 27 | Blue-Light Blocking Glasses | Wore blue-light blocking glasses before bed? | `blue-light-blocking-glasses` |
| 28 | Read in Bed | Read (non-screened device) while in bed? | `read-in-bed` |
| 31 | Shared Bed | Shared your bed? | `shared-bed` |
| 32 | Sleep Mask | Wore a sleep mask? | `sleep-mask` |
| 33 | Sleep in Own Bed | Slept in the same bed as usual? | `same-bed` |
| 34 | Sound Machine (e.g. white noise) | Listened to noise while asleep? | `sound-machine` |
| 58 | CPAP Machine | Did you utilize a CPAP Machine? | `cpap-machine` |
| 59 | Sleep at High Altitude | Did you sleep at Altitude? | `sleep-at-high-altitude` |
| 61 | Ear Plugs | Wore ear plugs to bed? | `ear-plugs` |
| 73 | Weighted Blanket | Used a weighted blanket while sleeping? | `weighted-blanket` |
| 74 | Nasal Strip | Wore a nasal strip while sleeping? | `nasal-strip` |
| 75 | Humidifier | Used a humidifier while sleeping? | `humidifier` |
| 76 | Dog in Bedroom | Had a dog in the room while sleeping? | `dog-in-bedroom` |
| 77 | Cat in Bedroom | Had a cat in the room while sleeping? | `cat-in-bedroom` |
| 138 | Morning Sunlight | Saw direct sunlight upon waking up? | `morning-sunlight` |
| 139 | Artificial Light | Saw artificial light upon waking up? | `artificial-light` |
| 140 | Sunset | Watched the sunset? | `sunset` |
| 142 | Dim lights | Dimmed your lights after sunset? | `dim-lights` |
| 143 | Daylight Eating | Ate all your meals during daylight hours? | `daylight-eating` |
| 164 | Mouth Tape | Wore mouth tape while sleeping? | `mouth-tape` |
| 165 | Blue-Light Blocking Glasses (WHOOP Evening Lenses) | Wore blue-light blocking glasses (WHOOP Evening Lenses) | `blue-light-blocking-glasses-whoop-evening` |
| 166 | Blue-Light Blocking Glasses (WHOOP All-Day Lenses) | Wore blue-light blocking glasses (WHOOP All-Day Lenses)? | `blue-light-blocking-glasses-whoop-all-day` |
| 174 | Sleep in Dark Room | Slept in a dark room? | `sleep-in-dark-room` |
| 179 | Hot Shower Before Bed | Took a hot shower before bed? | `hot-shower-before-bed` |
| 180 | Mouthguard | Wore a mouthguard while sleeping? | `mouthguard` |
| 299 | Snoring (Partner) | Did your partner snore? | `snoring-partner` |
| 362 | Sleep Disruption | Experienced a sleep disruption? | `sleep_disruption` |
| 381 | Child in Bedroom | Slept with a child in your bedroom? | `child_in_bedroom` |
| 382 | Nightguard or Retainer | Slept with a nightguard or retainer? | `nightguard_or_retainer` |
| 383 | Loud Sleep environment | Slept in a loud environment? | `loud_sleep_environment` |
| 385 | Body Pillow | Used a body pillow? | `body_pillow` |

### Supplements (27)

| ID | Title | Question | internal_name |
|---|---|---|---|
| 35 | CBD | Used CBD oil in any form? | `cbd` |
| 36 | Magnesium Supplement | Took a magnesium supplement? | `magnesium-supplement` |
| 37 | Melatonin | Took a melatonin supplement? | `melatonin` |
| 104 | Creatine | Took creatine? | `creatine` |
| 105 | Fish Oil | Took fish oil? | `fish-oil` |
| 106 | Multivitamin | Took a multivitamin? | `multivitamin` |
| 107 | Probiotic | Took a probiotic? | `probiotic` |
| 108 | Turmeric | Took turmeric? | `turmeric` |
| 109 | Vitamin B-12 | Took vitamin B-12? | `vitamin-b-12` |
| 110 | Vitamin C | Took vitamin C? | `vitamin-c` |
| 111 | Vitamin D | Took vitamin D? | `vitamin-d` |
| 158 | Zinc | Took a zinc supplement? | `zinc` |
| 159 | Calcium Supplement | Took a calcium supplement? | `calcium-supplement` |
| 181 | AG1 - Foundational Nutritional Supplement | Did you drink AG1? | `ag1` |
| 185 | Prenatal Vitamins | Took prenatal supplement(s)? | `prenatal-vitamins` |
| 187 | Postnatal Vitamins | Took postnatal supplement(s)? | `postnatal-vitamins` |
| 202 | Electrolytes | Took electrolyte supplements? | `electrolytes` |
| 265 | Ashwaganda | Took ashwaganda? | `ashwaganda` |
| 305 | Omega 3 Supplement | Took omega 3 supplement? | `omega-3-supplement` |
| 340 | Iron | Took Iron supplements? | `iron` |
| 341 | Valerian | Took Valerian supplement for sleep? | `valerian` |
| 342 | Tart Cherry Juice | Drank tart cherry juice? | `tart_cherry_juice` |
| 343 | L-theanine | Took L-theanine supplements? | `l-theanine` |
| 344 | Rhodiola Rosea | Took rhodiola rosea extract? | `rhodiola_rosea` |
| 346 | Alpha-lipoic acid (ALA) supplement | Took Alpha-lipoic acid (ALA) supplements? | `alpha_lipoic_acid` |
| 347 | Levothyroxine | Took Levothyroxine medication? | `levothyroxine` |
| 384 | Adaptogen Mushrooms | Took adaptogen mushrooms? | `adaptogen_mushrooms` |

---

## Full Strength Trainer exercise catalog (372 entries)

Every exercise in `src/data/exercises.ts`. `exercise_id` is the upper-snake-case identifier used in workout logs and the catalog endpoint. Grouped by primary muscle group.

### ARMS (27)

| exercise_id | Name | Equipment | Movement | Laterality |
|---|---|---|---|---|
| `BICEPCURL_BARBELL` | Bicep Curl - Barbell | Barbell | Other | BILATERAL |
| `BICEPCURL_DUMBBELL` | Bicep Curl - Dumbbell | Dumbbell | Other | BILATERAL |
| `BICEPCURL_PULLEYMACHINE` | Bicep Curl - Cable | Machine | Other | BILATERAL |
| `CONCENTRATIONCURLLEFT_DUMBBELL` | Concentration Curl - L - Dumbbell | Dumbbell | Other | LEFT |
| `CONCENTRATIONCURLRIGHT_DUMBBELL` | Concentration Curl - R - Dumbbell | Dumbbell | Other | RIGHT |
| `CURL_EZCURLBAR` | Bicep Curl - Seated - Barbell | Barbell | Other | BILATERAL |
| `DB_ZOTTMAN_CURL` | DB Zottman Curl | Dumbbell | Other | BILATERAL |
| `DRAGCURL_BARBELL` | Bicep Curl - Drag - Barbell | Barbell | Other | BILATERAL |
| `EZ_BAR_BICEP_CURL` | EZ Bar Bicep Curl | Barbell | Other | BILATERAL |
| `FLOOR_TRICEP_DIPS` | Floor Tricep Dips | Bodyweight | Vertical Press | BILATERAL |
| `HAMMERCURL_DUMBBELL` | Hammer Curl - Dumbbell | Dumbbell | Other | BILATERAL |
| `INTEGRATION_TEST_EXERCISEfdbdf7b7-f403-4e63-ba48-f8163e494083` | Updated integration test name | Barbell | Hinge | ALTERNATING |
| `LYINGTRICEPSEXTENSION_DUMBBELL` | Tricep Extension - Supine Lying - Dumbbell | Dumbbell | Other | BILATERAL |
| `OVERHEADSLAM_MEDBALL` | Overhead Slam - Med Ball | Medicine Ball | Other | BILATERAL |
| `PREACHER_CURL_MACHINE` | Preacher Curl Machine | Machine | Other | BILATERAL |
| `PREACHERCURL_EZCURLBAR` | Preacher Curl | Barbell | Other | BILATERAL |
| `REVERSECURLS_BARBELL` | Reverse Curls - Barbell | Barbell | Other | BILATERAL |
| `ROPETRICEPSPUSHDOWN_PULLEYMACHINE` | Triceps Pulldown - Rope | Machine | Other | BILATERAL |
| `SINGLEARMSEATEDTRICEPSEXTENSIONLEFT_DUMBBELL` | Triceps Extension - Single Arm Seated - L - Dumbbell | Dumbbell | Other | LEFT |
| `SINGLEARMSEATEDTRICEPSEXTENSIONRIGHT_DUMBBELL` | Triceps Extension - Single Arm Seated - R - Dumbbell | Dumbbell | Other | RIGHT |
| `SKI_ERG` | Ski Erg | Other | Vertical Pull | BILATERAL |
| `SKULLCRUSHER_BARBELL` | Skull Crusher - Flat Bench - Barbell | Barbell | Other | BILATERAL |
| `STANDINGTRICEPEXTENSION_DUMBBELL` | Standing Triceps Extension - Dumbbell | Dumbbell | Other | BILATERAL |
| `TRICEPDIP_DIPBAR` | Dip | Bodyweight | Vertical Press | BILATERAL |
| `TRICEPKICKBACKLEFT_DUMBBELL` | Tricep Kickback - Single Arm - L - Dumbbell | Dumbbell | Other | LEFT |
| `TRICEPKICKBACKRIGHT_DUMBBELL` | Tricep Kickback - Single Arm - R - Dumbbell | Dumbbell | Other | RIGHT |
| `TRICEPPUSHDOWN_PULLEYMACHINE` | Tricep Extension - Standing - Rope - Pulley Machine | Machine | Other | BILATERAL |

### BACK (36)

| exercise_id | Name | Equipment | Movement | Laterality |
|---|---|---|---|---|
| `ASSISTED_PULL_UPS_(BAND)` | Assisted Pull Ups (Band) | Other | Vertical Pull | BILATERAL |
| `ASSISTED_PULL_UPS_(MACHINE)` | Assisted Pull Ups (Machine) | Machine | Vertical Pull | BILATERAL |
| `BACKEXTENSION_GLUTEHAMMACHINE` | Back Extensions | Machine | Hinge | BILATERAL |
| `BENCHPULL_BARBELL` | Bench Pull - Barbell | Barbell | Horizontal Pull | BILATERAL |
| `BENTKNEESINVERTEDROW_BARBELL` | Inverted Row - Bent Knee - Barbell | Barbell | Horizontal Pull | BILATERAL |
| `BENTOVERROW_BARBELL` | Bent Over Row - Barbell | Barbell | Horizontal Pull | BILATERAL |
| `BENTOVERROW_DUMBBELL` | Bent Over Row - Dumbbell | Dumbbell | Horizontal Pull | BILATERAL |
| `CHESTTOBARPULLUPS` | Pull Ups - Chest to Bar | Bodyweight | Vertical Pull | BILATERAL |
| `DB_GORILLA_ROW` | DB Gorilla Row | Dumbbell | Horizontal Pull | ALTERNATING |
| `FEETONBENCHINVERTEDROW` | Inverted Row - Feet on Bench | Bodyweight | Horizontal Pull | BILATERAL |
| `GOODMORNING_BARBELL` | Good Morning - Barbell | Barbell | Hinge | BILATERAL |
| `INCLINEDROW_DUMBBELL` | Incline Row - Dumbbell | Dumbbell | Horizontal Pull | BILATERAL |
| `INCLINEDROW_PULLEYMACHINE` | Incline Row - Machine | Machine | Horizontal Pull | BILATERAL |
| `INVERTEDROW_RINGS` | Inverted Row - Rings | Other | Horizontal Pull | BILATERAL |
| `INVERTEDROW_TRX` | Inverted Row - Straight Leg - TRX | Other | Vertical Pull | BILATERAL |
| `KB_GORILLA_ROW` | KB Gorilla Row | Kettlebell | Horizontal Pull | ALTERNATING |
| `LATPULLDOWNBACK_PULLEYMACHINE` | Lat Pull Down - Behind Neck | Machine | Vertical Pull | BILATERAL |
| `LATPULLDOWNFRONT_PULLEYMACHINE` | Lat Pull Down - Front | Machine | Vertical Pull | BILATERAL |
| `MUSCLEUPS` | Muscle Ups | Bodyweight | Vertical Pull | BILATERAL |
| `NARROWGRIPLATPULLDOWNFRONT_PULLEYMACHINE` | Lat Pull Down - Narrow Grip | Machine | Vertical Pull | BILATERAL |
| `NEUTRALGRIPPULLUPS` | Pull Up - Neutral Grip | Bodyweight | Vertical Pull | BILATERAL |
| `ONEARMBENTOVERROWLEFT_PULLEYMACHINE` | Single Arm Bent Over Row - L - Cable | Machine | Horizontal Pull | LEFT |
| `ONEARMBENTOVERROWRIGHT_PULLEYMACHINE` | Single Arm Bent Over Row - R - Cable | Machine | Horizontal Pull | RIGHT |
| `ONEARMROWLEFT_DUMBBELL` | Row - Single Arm - L - Dumbbell | Dumbbell | Horizontal Pull | LEFT |
| `ONEARMROWRIGHT_DUMBBELL` | Row - Single Arm - R - Dumbbell | Dumbbell | Horizontal Pull | RIGHT |
| `OVERHANDGRIPPULLUPS` | Pull Up | Bodyweight | Vertical Pull | BILATERAL |
| `PULLOVER_DUMBBELL` | Bench Pullover - Dumbbell | Dumbbell | Other | BILATERAL |
| `ROPE_CLIMBS_(LEGLESS)` | Rope Climbs (Legless) | Other | Vertical Pull | ALTERNATING |
| `SEATEDROW_PULLEYMACHINE` | Seated Row | Machine | Horizontal Pull | BILATERAL |
| `STANDINGROW_PULLEYMACHINE` | Standing Row - Cable | Machine | Horizontal Pull | BILATERAL |
| `STRAIGHTARMPULLDOWN_PULLEYMACHINE` | Straight Arm Pull Down | Machine | Other | BILATERAL |
| `TBARROW_BARBELL` | T-Bar Row - Barbell | Barbell | Horizontal Pull | BILATERAL |
| `UNDERHANDGRIPBENTOVERROW_BARBELL` | Bent Over Row - Underhand Grip - Barbell | Barbell | Horizontal Pull | BILATERAL |
| `UNDERHANDGRIPPULLUPS` | Chin Up | Pull Up Bar | Vertical Pull | BILATERAL |
| `WIDEGRIPLATPULLDOWNBACK_PULLEYMACHINE` | Lat Pull Down - Wide Grip Behind Neck | Machine | Vertical Pull | BILATERAL |
| `WIDEGRIPLATPULLDOWNFRONT_PULLEYMACHINE` | Lat Pull Down - Wide Grip Front Pull | Machine | Vertical Pull | BILATERAL |

### CHEST (23)

| exercise_id | Name | Equipment | Movement | Laterality |
|---|---|---|---|---|
| `BENCHFLY_DUMBBELL` | Bench Fly - Dumbbell | Dumbbell | Other | BILATERAL |
| `BENCHPRESS_BARBELL` | Bench Press - Barbell | Barbell | Horizontal Press | BILATERAL |
| `BENCHPRESS_DUMBBELL` | Bench Press - Dumbbell | Dumbbell | Horizontal Press | BILATERAL |
| `BENCHPRESS_PULLEYMACHINE` | Machine Chest Press | Machine | Horizontal Press | BILATERAL |
| `BENCHPRESS_SMITHMACHINE` | Smith Machine Bench Press | Machine | Horizontal Press | BILATERAL |
| `BENCHPRESSWITHPAUSE_BARBELL` | Bench Press - Pause - Barbell | Barbell | Horizontal Press | BILATERAL |
| `CHESTDIP_DIPBAR` | Chest Dip | Other | Vertical Press | BILATERAL |
| `CHESTFLY_PULLEYMACHINE` | Machine Chest Flys | Machine | Other | BILATERAL |
| `CLOSE_GRIP_CHEST_PRESS_-_BARBELL` | Close Grip Chest Press - Barbell | Barbell | Horizontal Press | BILATERAL |
| `CONBENCHPRESS_BARBELL` | Bench Press - Concentric - Barbell | Barbell | Horizontal Press | BILATERAL |
| `DB_SINGLE_ARM_CHEST_PRESS` | DB Single Arm Chest Press | Dumbbell | Horizontal Press | ALTERNATING |
| `DECLINEBENCHPRESS_BARBELL` | Bench Press - Decline - Barbell | Barbell | Horizontal Press | BILATERAL |
| `HAND-RELEASE_PUSH-UPS` | Hand-Release Push-Ups | Bodyweight | Vertical Press | BILATERAL |
| `INCLINEBENCHPRESS_BARBELL` | Bench Press - Incline - Barbell | Barbell | Horizontal Press | BILATERAL |
| `INCLINEBENCHPRESS_DUMBBELL` | Bench Press - Incline - Dumbbell | Dumbbell | Horizontal Press | BILATERAL |
| `INCLINEDBENCHPRESS_SMITHMACHINE` | Smith Machine Incline Bench Press | Machine | Horizontal Press | BILATERAL |
| `LYINGCHESTTHROW_MEDBALL` | Supine Lying Chest Throw - Med Ball | Medicine Ball | Other | BILATERAL |
| `NARROWGRIPBENCHPRESS_BARBELL` | Bench Press - Narrow Grip - Barbell | Barbell | Horizontal Press | BILATERAL |
| `PUSHUP_CLASSIC` | Push Up | Bodyweight | Horizontal Press | BILATERAL |
| `STANDINGCABLECROSSOVER_PULLEYMACHINE` | Standing Cable Crossover | Machine | Horizontal Press | BILATERAL |
| `STANDINGCHESTTHROW_MEDBALL` | Standing Chest Throw - Med Ball | Medicine Ball | Other | BILATERAL |
| `WIDEGRIPBENCHPRESS_BARBELL` | Bench Press - Wide Grip - Barbell | Barbell | Horizontal Press | BILATERAL |
| `WIDEGRIPINCLINEBENCHPRESS_BARBELL` | Bench Press - Incline - Wide Grip - Barbell | Barbell | Horizontal Press | BILATERAL |

### CORE (50)

| exercise_id | Name | Equipment | Movement | Laterality |
|---|---|---|---|---|
| `BICYCLE_CRUNCHES` | Bicycle Crunches | Bodyweight | Other | ALTERNATING |
| `CRUNCHES_BODYWEIGHT` | Crunches | Bodyweight | Other | BILATERAL |
| `DB_RUSSIAN_TWIST` | DB Russian Twist | Dumbbell | Other | ALTERNATING |
| `DEADBUG` | Deadbug | Bodyweight | Other | BILATERAL |
| `FRONTPLANKELBOW` | Front Plank | Bodyweight | Other | BILATERAL |
| `GHD_SIT-UPS` | GHD Sit-Ups | Machine | Other | BILATERAL |
| `HALFKNEELINGCABLEPALLOFPRESSLEFT_PULLEYMACHINE` | Half Kneeling Cable Pallof Press - L | Machine | Other | LEFT |
| `HALFKNEELINGCABLEPALLOFPRESSRIGHT_PULLEYMACHINE` | Half Kneeling Cable Pallof Press - R | Machine | Other | RIGHT |
| `HALFKNEELINGCABLEROTATIONLEFT_PULLEYMACHINE` | Half Kneeling Cable Rotation - L | Machine | Other | LEFT |
| `HALFKNEELINGCABLEROTATIONRIGHT_PULLEYMACHINE` | Half Kneeling Cable Rotation - R | Machine | Other | RIGHT |
| `HALFKNEELINGCABLEVERTICALPALLOFPRESSLEFT_PULLEYMACHINE` | Half Kneeling Cable Vertical Pallof Press - L | Machine | Other | LEFT |
| `HALFKNEELINGCABLEVERTICALPALLOFPRESSRIGHT_PULLEYMACHINE` | Half Kneeling Cable Vertical Pallof Press - R | Machine | Other | RIGHT |
| `HANGINGKNEERAISE` | Hanging Knee Raises | Pull Up Bar | Other | BILATERAL |
| `HANGINGLEGRAISES` | Hanging Leg Raises | Pull Up Bar | Other | BILATERAL |
| `HANGINGTICTOCS` | Hanging Tic Tocs | Pull Up Bar | Other | BILATERAL |
| `HANGINGTOESTOBAR` | Hanging Toes to Bar | Pull Up Bar | Other | BILATERAL |
| `KNEELINGCABLEPALLOFPRESSLEFT_PULLEYMACHINE` | Kneeling Cable Pallof Press - L | Machine | Other | LEFT |
| `KNEELINGCABLEPALLOFPRESSRIGHT_PULLEYMACHINE` | Kneeling Cable Pallof Press - R | Machine | Other | RIGHT |
| `KNEELINGCABLEROTATIONLEFT_PULLEYMACHINE` | Kneeling Cable Rotation - L | Machine | Other | LEFT |
| `KNEELINGCABLEROTATIONRIGHT_PULLEYMACHINE` | Kneeling Cable Rotation - R | Machine | Other | RIGHT |
| `KNEELINGCABLEVERTICALPALLOFPRESSLEFT_PULLEYMACHINE` | Kneeling Cable Vertical Pallof Press - L | Machine | Other | LEFT |
| `KNEELINGCABLEVERTICALPALLOFPRESSRIGHT_PULLEYMACHINE` | Kneeling Cable Vertical Pallof Press - R | Machine | Other | RIGHT |
| `KNEESROLLOUTS_BARBELL` | Kneeling Rollouts | Stability Ball | Other | BILATERAL |
| `LEFTSTRAIGHTARMCABLEROTATION_PULLEYMACHINE` | Standing Cable Rotations - L | Machine | Other | LEFT |
| `MB_RUSSIAN_TWIST` | MB Russian Twist | Medicine Ball | Other | ALTERNATING |
| `OTHEREXERCISE` | Other | Other | Other | BILATERAL |
| `PIKE_STABILITYBALL` | Pike | Stability Ball | Other | BILATERAL |
| `REVERSE_CRUNCH_MACHINE` | Reverse Crunch Machine | Machine | Other | BILATERAL |
| `RIGHTSTRAIGHTARMCABLEROTATION_PULLEYMACHINE` | Standing Cable Rotations - R | Machine | Other | RIGHT |
| `ROTARY_TORSO_TWIST` | Rotary Torso Twist | Machine | Other | ALTERNATING |
| `SIDEPLANKELBOWLEFT` | Side Plank - L | Bodyweight | Other | LEFT |
| `SIDEPLANKELBOWRIGHT` | Side Plank - R | Bodyweight | Other | RIGHT |
| `SITUPS_BODYWEIGHT` | Sit Ups | Bodyweight | Other | BILATERAL |
| `SPLITSTANCECABLEPALLOFPRESSLEFT_PULLEYMACHINE` | Split Stance Cable Pallof Press - L | Machine | Other | LEFT |
| `SPLITSTANCECABLEPALLOFPRESSRIGHT_PULLEYMACHINE` | Split Stance Cable Pallof Press - R | Machine | Other | RIGHT |
| `SPLITSTANCECABLEROTATIONLEFT_PULLEYMACHINE` | Split Stance Cable Rotation - L | Machine | Other | LEFT |
| `SPLITSTANCECABLEROTATIONRIGHT_PULLEYMACHINE` | Split Stance Cable Rotation - R | Machine | Other | RIGHT |
| `SPLITSTANCECABLEVERTICALPALLOFPRESSLEFT_PULLEYMACHINE` | Split Stance Cable Vertical Pallof Press - L | Machine | Other | LEFT |
| `SPLITSTANCECABLEVERTICALPALLOFPRESSRIGHT_PULLEYMACHINE` | Split Stance Cable Vertical Pallof Press - R | Machine | Other | RIGHT |
| `STABILITYBALL_TICTOCS` | Tic Tocs | Stability Ball | Other | BILATERAL |
| `STANDINGCABLEPALLOFPRESSLEFT_PULLEYMACHINE` | Standing Cable Pallof Press - L | Machine | Other | LEFT |
| `STANDINGCABLEPALLOFPRESSRIGHT_PULLEYMACHINE` | Standing Cable Pallof Press - R | Machine | Other | RIGHT |
| `STANDINGCABLEVERTICALPALLOFPRESSLEFT_PULLEYMACHINE` | Standing Cable Vertical Pallof Press - L | Machine | Other | LEFT |
| `STANDINGCABLEVERTICALPALLOFPRESSRIGHT_PULLEYMACHINE` | Standing Cable Vertical Pallof Press - R | Machine | Other | RIGHT |
| `STANDINGLANDMINEROTATIONS_BARBELL` | Standing Landmine Rotations | Barbell | Other | BILATERAL |
| `STANDINGSIDETHROWLEFT_MEDBALL` | Standing Side Throw - L - Med Ball | Medicine Ball | Other | LEFT |
| `STANDINGSIDETHROWRIGHT_MEDBALL` | Standing Side Throw - R - Med Ball | Medicine Ball | Other | RIGHT |
| `SUPINE_LEG_LIFTS` | Supine Leg Lifts | Bodyweight | Other | BILATERAL |
| `TURKISHGETUPLEFT_KETTLEBELL` | Turkish Get Up - L | Kettlebell | Other | LEFT |
| `TURKISHGETUPRIGHT_KETTLEBELL` | Turkish Get Up - R | Kettlebell | Other | RIGHT |

### FULL_BODY (35)

| exercise_id | Name | Equipment | Movement | Laterality |
|---|---|---|---|---|
| `ASSAULT_AIRBIKE` | Assault Bike | Bodyweight | Other | BILATERAL |
| `BAR-FACING_BURPEES_(LATERAL)` | Bar-Facing Burpees (Lateral) | Barbell | Jump | BILATERAL |
| `BB_SOTS_PRESS` | BB Sots Press | Barbell | Vertical Press | BILATERAL |
| `BB_ZERCHER_SQUAT` | BB Zercher Squat | Barbell | Squat | BILATERAL |
| `BOX_JUMP-OVER_BURPEES` | Box Jump-Over Burpees | Plyo Box | Jump | BILATERAL |
| `BURPEE` | Burpees | Bodyweight | Other | BILATERAL |
| `BURPEE_BOX_JUMP` | Burpee Box Jump | Plyo Box | Jump | BILATERAL |
| `BURPEE_BROAD_JUMPS` | Burpee Broad Jumps | Bodyweight | Jump | BILATERAL |
| `BURPEEPULLUPS` | Burpee Pull Ups | Bodyweight | Hinge | BILATERAL |
| `BURPEES_OVER_THE_BAR` | Burpees Over the Bar | Barbell | Jump | BILATERAL |
| `BURPEES_OVER_THE_DUMBBELL` | Burpees Over the Dumbbell | Dumbbell | Jump | BILATERAL |
| `BUTTERFLY_PULL-UPS` | Butterfly Pull-Ups | Pull Up Bar | Vertical Pull | BILATERAL |
| `DB_CURTSY_LUNGE` | DB Curtsy Lunge | Dumbbell | Lunge | ALTERNATING |
| `DB_RENEGADE_ROW` | DB Renegade Row | Dumbbell | Horizontal Pull | ALTERNATING |
| `DB_REVERSE_LUNGE_TO_STAND` | DB Reverse Lunge to Stand | Dumbbell | Lunge | ALTERNATING |
| `DB_SINGLE_ARM_CLEAN_AND_JERK` | DB Single Arm Clean and Jerk | Dumbbell | Olympic Lift | ALTERNATING |
| `DB_SUITCASE_CARRY_` | DB Suitcase Carry | Dumbbell | Other | ALTERNATING |
| `DEVIL_PRESS` | Devil Press | Dumbbell | Vertical Press | BILATERAL |
| `DOUBLE_UNDERS` | Double Unders | Other | Jump | BILATERAL |
| `ELLIPTICAL_MACHINE` | Elliptical | Bodyweight | Other | BILATERAL |
| `KB_OVERHEAD_WALKING_LUNGES` | KB Overhead Walking Lunges | Kettlebell | Lunge | ALTERNATING |
| `KB_RENEGADE_ROW` | KB Renegade Row | Kettlebell | Horizontal Pull | ALTERNATING |
| `KB_WAITER_CARRY` | KB Waiter Carry | Kettlebell | Other | ALTERNATING |
| `KIPPING_PULL-UPS` | Kipping Pull-Ups | Pull Up Bar | Vertical Pull | BILATERAL |
| `MB_WALL_BALL` | MB Wall Ball | Medicine Ball | Squat | BILATERAL |
| `OVERHEAD_WALKING_LUNGES_-_DUMBBELL` | Overhead Walking Lunges - Dumbbell | Dumbbell | Lunge | ALTERNATING |
| `PENDULUM_SQUAT` | Pendulum Squat | Machine | Squat | BILATERAL |
| `RING_MUSCLE-UPS` | Ring Muscle-Ups | Other | Vertical Pull | BILATERAL |
| `ROPE_CLIMBS_(STANDARD)` | Rope Climbs (Standard) | Other | Vertical Pull | ALTERNATING |
| `ROWS_MACHINE` | Rowing | Bodyweight | Other | BILATERAL |
| `SANDBAG_LUNGES` | Sandbag Lunges | Other | Lunge | ALTERNATING |
| `SMITH_MACHINE_ROMANIAN_DEADLIFT` | Smith Machine Romanian Deadlift | Machine | Hinge | BILATERAL |
| `SMITH_MACHINE_SINGLE_LEG_ROMANIAN_DEADLIFT` | Smith Machine Single Leg Romanian Deadlift | Machine | Hinge | ALTERNATING |
| `SMITH_MACHINE_SPLIT_SQUAT` | Smith Machine Split Squat | Machine | Lunge | ALTERNATING |
| `WALL_WALKS` | Wall Walks | Bodyweight | Vertical Press | BILATERAL |

### LEGS (157)

| exercise_id | Name | Equipment | Movement | Laterality |
|---|---|---|---|---|
| `45DEGTRAVELINGLUNGES_DUMBBELL` | Travelling Lunge - 45 Degree - Dumbbell | Dumbbell | Lunge | BILATERAL |
| `ALTERNATINGBACKWARDLUNGES_BARBELL` | Backward Lunge - Alternating - Barbell | Barbell | Lunge | ALTERNATING |
| `ALTERNATINGBACKWARDLUNGES_BODYWEIGHT` | Backward Lunge - Alternating - Bodyweight | Bodyweight | Lunge | ALTERNATING |
| `ALTERNATINGBACKWARDLUNGES_DUMBBELL` | Backward Lunge - Alternating - Dumbbell | Dumbbell | Lunge | ALTERNATING |
| `ALTERNATINGFRONTRACKBACKWARDLUNGES_BARBELL` | Backward Lunge - Front Rack - Alternating - Barbell | Barbell | Lunge | ALTERNATING |
| `ALTERNATINGFRONTRACKLUNGES_BARBELL` | Front Rack Lunge - Alternating - Barbell | Barbell | Lunge | ALTERNATING |
| `ALTERNATINGGOBLETSIDELUNGE_DUMBBELL` | Lateral Lunge - Goblet - Alternating - Dumbbell | Dumbbell | Lunge | ALTERNATING |
| `ALTERNATINGLUNGE_BARBELL` | Lunge - Alternating - Barbell | Barbell | Lunge | ALTERNATING |
| `ALTERNATINGLUNGE_DUMBBELL` | Lunge - Alternating - Dumbbell | Dumbbell | Lunge | ALTERNATING |
| `ALTERNATINGSIDELUNGE_BARBELL` | Side Lunge - Alternating - Barbell | Barbell | Lunge | ALTERNATING |
| `ALTERNATINGSINGLELEGCOUNTERMOVEMENTJUMP` | Countermovement Jump - Single Leg - Alternating | Bodyweight | Jump | ALTERNATING |
| `ALTERNATINGSINGLELEGROMANIANDEADLIFT_BARBELL` | Romanian Deadlift - Single Leg - Alternating - Barbell | Barbell | Hinge | ALTERNATING |
| `ALTERNATINGSINGLELEGROMANIANDEADLIFT_DUMBBELL` | Romanian Deadlift - Single Leg - Alternating - Dumbbell | Dumbbell | Hinge | ALTERNATING |
| `ALTERNATINGSINGLELEGSQUAT_BODYWEIGHT` | Squat - Single Leg - Alternating | Bodyweight | Squat | ALTERNATING |
| `ALTERNATINGSTEPUPS_BARBELL` | Step Ups - Alternating - Barbell | Barbell | Lunge | ALTERNATING |
| `ALTERNATINGSTEPUPS_DUMBBELL` | Step Up - Alternating - Dumbbell | Dumbbell | Lunge | ALTERNATING |
| `ALTERNATINGSTEPUPS_WEIGHT_VEST` | Step Ups - Alternating - Weighted | Plyo Box | Lunge | ALTERNATING |
| `ALTERNATINGTRAVELINGLUNGE_BARBELL` | Travelling Lunge - Alternating - Barbell | Barbell | Lunge | ALTERNATING |
| `ALTERNATINGTRAVELINGLUNGES_DUMBBELL` | Travelling Lunge - Alternating - Dumbbell | Dumbbell | Lunge | ALTERNATING |
| `BACKSQUAT_BARBELL` | Back Squat - Barbell | Barbell | Squat | BILATERAL |
| `BACKSQUAT_SAFETYBARBELL` | Back Squat - Safety Bar | Barbell | Squat | BILATERAL |
| `BACKSQUATWITHPAUSE_BARBELL` | Back Squat - Pause - Barbell | Barbell | Squat | BILATERAL |
| `BACKWARDLUNGESLEFT_DUMBBELL` | Backward Lunge - L - Dumbbell | Dumbbell | Lunge | LEFT |
| `BACKWARDLUNGESRIGHT_DUMBBELL` | Backward Lunge - R - Dumbbell | Dumbbell | Lunge | RIGHT |
| `BIKE_ERG` | Bike Erg | Other | Other | ALTERNATING |
| `BOX_STEP-OVERS` | Box Step-Overs | Plyo Box | Lunge | ALTERNATING |
| `BOXJUMP` | Box Jump | Plyo Box | Jump | BILATERAL |
| `BOXJUMPWITHARMSWING` | Box Jump - Arm Swing | Plyo Box | Jump | BILATERAL |
| `BOXSQUAT_BARBELL` | Box Squat - Barbell | Barbell | Squat | BILATERAL |
| `BOXSQUATWITHPAUSE_BARBELL` | Box Squat - Pause - Barbell | Barbell | Squat | BILATERAL |
| `BULGARIANSQUATLEFT_BARBELL` | Rear Foot Elevated Split Squat - L - Barbell | Barbell | Squat | LEFT |
| `BULGARIANSQUATLEFT_DUMBBELL` | Split Squat - Rear Foot Elevated - L - Dumbbell | Dumbbell | Squat | LEFT |
| `BULGARIANSQUATRIGHT_BARBELL` | Rear Foot Elevated Split Squat - R - Barbell | Barbell | Squat | RIGHT |
| `BULGARIANSQUATRIGHT_DUMBBELL` | Split Squat - Rear Foot Elevated - R - Dumbbell | Dumbbell | Squat | RIGHT |
| `CLEAN_BARBELL` | Clean - Barbell | Barbell | Olympic Lift | BILATERAL |
| `CLEAN_KETTLEBELL` | Kettlebell Cleans | Kettlebell | Olympic Lift | BILATERAL |
| `CLEANHIGHPULL_BARBELL` | Clean High Pull - Barbell | Barbell | Olympic Lift | BILATERAL |
| `CLEANHIGHPULLOFFBLOCKS_BARBELL` | Clean High Pull - Off Blocks - Barbell | Barbell | Olympic Lift | BILATERAL |
| `CLEANJERK_BARBELL` | Clean and Split Jerk - Barbell | Barbell | Olympic Lift | BILATERAL |
| `CLEANOFFBLOCKS_BARBELL` | Clean - Off Blocks - Barbell | Barbell | Olympic Lift | BILATERAL |
| `CLEANPULL_BARBELL` | Clean Pull - Barbell | Barbell | Olympic Lift | BILATERAL |
| `CLEANPULLOFFBLOCKS_BARBELL` | Clean Pull - Off Blocks - Barbell | Barbell | Olympic Lift | BILATERAL |
| `CONCENTRICJUMPSQUAT_BARBELL` | Concentric Jump Squat - Barbell | Barbell | Jump | BILATERAL |
| `CONCENTRICSQUAT_BARBELL` | Back Squat - Concentric - Barbell | Barbell | Squat | BILATERAL |
| `COUNTERMOVEMENTJUMP` | Countermovement Jump | Bodyweight | Jump | BILATERAL |
| `DEADLIFT_BARBELL` | Deadlift - Barbell | Barbell | Hinge | BILATERAL |
| `DEADLIFT_DUMBBELL` | Deadlift - Dumbbell | Dumbbell | Hinge | BILATERAL |
| `DEADLIFT_KETTLEBELL` | Deadlift - Kettlebell | Kettlebell | Hinge | BILATERAL |
| `DEADLIFT_TRAPBAR` | Deadlift - Trapbar | Barbell | Hinge | BILATERAL |
| `DEADLIFTOFFBLOCKS_BARBELL` | Deadlift - Off Blocks - Barbell | Barbell | Hinge | BILATERAL |
| `FARMERSWALK_DUMBBELL` | Farmer's Walk - Dumbbell | Dumbbell | Other | BILATERAL |
| `FARMERSWALK_KETTLEBELL` | Farmer's Walk - Kettlebell | Kettlebell | Other | BILATERAL |
| `FLIP_TIRE` | Tire Flip | Other | Squat | BILATERAL |
| `FRONTSQUAT_BARBELL` | Front Squat - Barbell | Barbell | Squat | BILATERAL |
| `FRONTSQUAT_DUMBBELL` | Front Squat - Dumbbell | Dumbbell | Squat | BILATERAL |
| `FRONTSQUAT_KETTLEBELL` | Front Squat - Kettlebell | Kettlebell | Squat | BILATERAL |
| `FRONTSQUATWITHPAUSE_BARBELL` | Front Squat - Pause - Barbell | Barbell | Squat | BILATERAL |
| `GLUTEABDUCTOR_PULLEYMACHINE` | Glute Abductor Machine | Machine | Other | BILATERAL |
| `GLUTEBRIDGE` | Glute Bridge | Bodyweight | Hinge | BILATERAL |
| `GLUTEHAMRAISE_GLUTEHAMMACHINE` | Glute Ham Raise | Bodyweight | Other | BILATERAL |
| `GOBLETSIDELUNGELEFT_DUMBBELL` | Goblet Side Lunge - L - Dumbbell | Dumbbell | Lunge | LEFT |
| `GOBLETSIDELUNGERIGHT_DUMBBELL` | Goblet Side Lunge - R - Dumbbell | Dumbbell | Lunge | RIGHT |
| `GOBLETSQUAT_DUMBBELL` | Goblet Squat - Dumbbell | Dumbbell | Squat | BILATERAL |
| `GOBLETSQUAT_KETTLEBELL` | Goblet Squat - Kettlebell | Kettlebell | Squat | BILATERAL |
| `GROINADDUCTOR_PULLEYMACHINE` | Groin Adductor Machine | Machine | Other | BILATERAL |
| `HALFSQUAT_BARBELL` | Half Squat - Barbell | Barbell | Squat | BILATERAL |
| `HALFSQUAT_PULLEYMACHINE` | Hack Squat | Machine | Squat | BILATERAL |
| `HANGCLEAN_BARBELL` | Hang Clean - Barbell | Barbell | Olympic Lift | BILATERAL |
| `HANGCLEANHIGHPULL_BARBELL` | Hang Clean High Pull - Barbell | Barbell | Olympic Lift | BILATERAL |
| `HANGCLEANPULL_BARBELL` | Hang Clean Pull - Barbell | Barbell | Olympic Lift | BILATERAL |
| `HANGPOWERCLEAN_BARBELL` | Hang Power Clean - Barbell | Barbell | Olympic Lift | BILATERAL |
| `HANGPOWERSNATCH_BARBELL` | Hang Power Snatch - Barbell | Barbell | Olympic Lift | BILATERAL |
| `HANGPOWERSNATCH_DUMBBELL` | Hang Power Snatch - Dumbbell | Dumbbell | Olympic Lift | BILATERAL |
| `HANGSNATCH_BARBELL` | Hang Snatch - Barbell | Barbell | Olympic Lift | BILATERAL |
| `HANGSNATCHHIGHPULL_BARBELL` | Hang Snatch High Pull - Barbell | Barbell | Olympic Lift | BILATERAL |
| `HIPTHRUST_BARBELL` | Hip Thrust - Barbell | Barbell | Hinge | BILATERAL |
| `HIPTHRUST_SMITHMACHINE` | Smith Machine Hip Thrust | Machine | Hinge | BILATERAL |
| `JUMPINGJACKS` | Jumping Jacks | Bodyweight | Other | BILATERAL |
| `JUMPSQUAT` | Squat Jump | Bodyweight | Jump | BILATERAL |
| `JUMPSQUAT_BARBELL` | Jump Squat - Barbell | Barbell | Jump | BILATERAL |
| `KNEELINGSQUATJUMP` | Kneeling Squat Jump | Bodyweight | Jump | BILATERAL |
| `LATERALBARRIERJUMPS` | Lateral Barrier Jump | Bodyweight | Jump | BILATERAL |
| `LATERALBOXJUMP` | Lateral Box Jump | Bodyweight | Jump | BILATERAL |
| `LATERALWALK_SLED` | Sled Lateral Walks | Other | Other | BILATERAL |
| `LEGPRESS_PULLEYMACHINE` | Leg Press | Machine | Squat | BILATERAL |
| `LOWBARBACKSQUAT_BARBELL` | Back Squat - Low Bar | Barbell | Squat | BILATERAL |
| `LUNGELEFT_BARBELL` | Lunge - L - Barbell | Barbell | Lunge | LEFT |
| `LUNGERIGHT_BARBELL` | Lunge - R - Barbell | Barbell | Lunge | RIGHT |
| `LYINGSINGLELEGBRIDGELEFT` | Glute Bridge - Single Leg - L | Bodyweight | Other | LEFT |
| `LYINGSINGLELEGBRIDGERIGHT` | Glute Bridge - Single Leg - R | Bodyweight | Other | LEFT |
| `ONEARMSNATCHLEFT_DUMBBELL` | Single Arm Snatch - L - Dumbbell | Dumbbell | Olympic Lift | LEFT |
| `ONEARMSNATCHLEFT_KETTLEBELL` | Single Arm Snatch - L - Kettlebell | Kettlebell | Olympic Lift | LEFT |
| `ONEARMSNATCHRIGHT_DUMBBELL` | Single Arm Snatch - R - Dumbbell | Dumbbell | Olympic Lift | RIGHT |
| `ONEARMSNATCHRIGHT_KETTLEBELL` | Single Arm Snatch - R - Kettlebell | Kettlebell | Olympic Lift | RIGHT |
| `PISTOLSQUATLEFT_KETTLEBELL` | Pistol Squat - L - Kettlebell | Kettlebell | Squat | LEFT |
| `PISTOLSQUATRIGHT_KETTLEBELL` | Pistol Squat - R - Kettlebell | Kettlebell | Squat | RIGHT |
| `POWERCLEAN_BARBELL` | Power Clean - Barbell | Barbell | Olympic Lift | BILATERAL |
| `POWERCLEANOFFBLOCKS_BARBELL` | Power Clean - Off Blocks - Barbell | Barbell | Olympic Lift | BILATERAL |
| `POWERPULL_TRAPBAR` | Power Pull - Trap Bar | Barbell | Olympic Lift | BILATERAL |
| `POWERSNATCH_BARBELL` | Power Snatch - Barbell | Barbell | Olympic Lift | BILATERAL |
| `PRONELEGCURL_PULLEYMACHINE` | Prone Leg Curl | Machine | Other | BILATERAL |
| `PULL_SLED` | Sled Pull | Other | Other | BILATERAL |
| `QUARTERSQUAT_BARBELL` | Quarter Squat - Barbell | Barbell | Squat | BILATERAL |
| `REGULARJUMP_ROPE` | Jump Rope | Other | Jump | BILATERAL |
| `REVERSE_LUNGE_TO_STAND` | Reverse Lunge to Stand | Bodyweight | Lunge | ALTERNATING |
| `REVERSEBACKEXTENSION_GLUTEHAMMACHINE` | Reverse Back Extensions | Machine | Hinge | BILATERAL |
| `ROMANIANDEADLIFT_BARBELL` | Romanian Deadlift - Barbell | Barbell | Hinge | BILATERAL |
| `ROMANIANDEADLIFT_DUMBBELL` | Romanian Deadlift - Dumbbell | Dumbbell | Hinge | BILATERAL |
| `ROMANIANDEADLIFT_KETTLEBELL` | Romanian Deadlift - Kettlebell | Kettlebell | Hinge | BILATERAL |
| `SEATEDCALFRAISE_PULLEYMACHINE` | Calf Raise - Seated | Machine | Other | BILATERAL |
| `SEATEDLEGCURL_PULLEYMACHINE` | Seated Machine Leg Curl | Machine | Other | BILATERAL |
| `SEATEDLEGEXTENSION_PULLEYMACHINE` | Seated Machine Leg Extension | Machine | Other | BILATERAL |
| `SHINLOCKEDSQUAT_PULLEYMACHINE` | Shin Locked Squat | Machine | Squat | BILATERAL |
| `SINGLEARMOVERHEADSQUATLEFT_DUMBBELL` | Overhead Squat - Single Arm - L - Dumbbell | Dumbbell | Squat | LEFT |
| `SINGLEARMOVERHEADSQUATLEFT_KETTLEBELL` | Overhead Squat - Single Arm - L - Kettlebell | Kettlebell | Squat | LEFT |
| `SINGLEARMOVERHEADSQUATRIGHT_DUMBBELL` | Overhead Squat - Single Arm - R - Dumbbell | Dumbbell | Squat | RIGHT |
| `SINGLEARMOVERHEADSQUATRIGHT_KETTLEBELL` | Overhead Squat - Single Arm - R - Kettlebell | Kettlebell | Squat | RIGHT |
| `SINGLEARMSWINGLEFT_KETTLEBELL` | Swing - Single Arm - L - Kettlebell | Kettlebell | Hinge | LEFT |
| `SINGLEARMSWINGRIGHT_KETTLEBELL` | Swing - Single Arm - R - Kettlebell | Kettlebell | Hinge | RIGHT |
| `SINGLELEGBOXJUMPLEFT` | Box Jump - Single Leg - L | Plyo Box | Jump | LEFT |
| `SINGLELEGBOXJUMPRIGHT` | Box Jump - Single Leg - R | Plyo Box | Jump | RIGHT |
| `SINGLELEGCOUNTERMOVEMENTJUMPLEFT` | Countermovement Jump - Single Leg - L | Bodyweight | Jump | LEFT |
| `SINGLELEGCOUNTERMOVEMENTJUMPRIGHT` | Countermovement Jump - Single Leg - R | Bodyweight | Jump | RIGHT |
| `SINGLELEGROMANIANDEADLIFTLEFT_BARBELL` | Romanian Deadlift - Single Leg - R - Barbell | Barbell | Hinge | RIGHT |
| `SINGLELEGROMANIANDEADLIFTLEFT_DUMBBELL` | Romanian Deadlift - Single Leg - L - Dumbbell | Dumbbell | Hinge | LEFT |
| `SINGLELEGROMANIANDEADLIFTRIGHT_BARBELL` | Romanian Deadlift - Single Leg - L - Barbell | Barbell | Hinge | LEFT |
| `SINGLELEGROMANIANDEADLIFTRIGHT_DUMBBELL` | Romanian Deadlift - Single Leg - R - Dumbbell | Dumbbell | Hinge | RIGHT |
| `SINGLELEGSQUATLEFT_BODYWEIGHT` | Squat - Single Leg - L | Bodyweight | Squat | LEFT |
| `SINGLELEGSQUATRIGHT_BODYWEIGHT` | Squat - Single Leg - R | Bodyweight | Squat | RIGHT |
| `SINGLEPUSH_SLED` | Sled Push | Other | Other | BILATERAL |
| `SISSY_SQUAT` | Sissy Squat | Bodyweight | Squat | BILATERAL |
| `SNATCH_BARBELL` | Snatch - Barbell | Barbell | Olympic Lift | BILATERAL |
| `SNATCHHIGHPULL_BARBELL` | Snatch High Pull - Barbell | Barbell | Olympic Lift | BILATERAL |
| `SNATCHPULL_BARBELL` | Snatch Pull - Barbell | Barbell | Olympic Lift | BILATERAL |
| `SPLITJERK_BARBELL` | Split Jerk - Barbell | Barbell | Olympic Lift | BILATERAL |
| `SPLITSQUATLEFT_BARBELL` | Split Squat - L - Barbell | Barbell | Squat | LEFT |
| `SPLITSQUATLEFT_DUMBBELL` | Split Squat - L - Dumbbell | Dumbbell | Squat | LEFT |
| `SPLITSQUATRIGHT_BARBELL` | Split Squat - R - Barbell | Barbell | Squat | RIGHT |
| `SPLITSQUATRIGHT_DUMBBELL` | Split Squat - R - Dumbbell | Dumbbell | Squat | RIGHT |
| `SQUAT_BODYWEIGHT` | Squat - Bodyweight | Bodyweight | Squat | BILATERAL |
| `SQUAT_DUMBBELL` | Squat - Dumbbell | Dumbbell | Squat | BILATERAL |
| `SQUAT_SMITHMACHINE` | Smith Machine Squat | Machine | Squat | BILATERAL |
| `SQUATWITHARMSWING_BODYWEIGHT` | Squat - Arm Swing - Bodyweight | Bodyweight | Squat | BILATERAL |
| `STANDINGCALFRAISE_PULLEYMACHINE` | Calf Raise - Standing | Machine | Other | BILATERAL |
| `STANDINGLEGCURLLEFT_PULLEYMACHINE` | Standing Leg Curl - L | Machine | Other | LEFT |
| `STANDINGLEGCURLRIGHT_PULLEYMACHINE` | Standing Leg Curl - R | Machine | Other | RIGHT |
| `STEPUPSLEFT_BARBELL` | Step Up - L - Barbell | Barbell | Lunge | LEFT |
| `STEPUPSLEFT_DUMBBELL` | Step Up - L - Dumbbell | Dumbbell | Lunge | LEFT |
| `STEPUPSRIGHT_BARBELL` | Step Up - R - Barbell | Barbell | Lunge | RIGHT |
| `STEPUPSRIGHT_DUMBBELL` | Step Up - R - Dumbbell | Dumbbell | Lunge | RIGHT |
| `SUMODEADLIFT_BARBELL` | Deadlift - Sumo - Barbell | Barbell | Hinge | BILATERAL |
| `SUMODEADLIFT_DUMBBELL` | Deadlift - Sumo - Dumbbell | Dumbbell | Hinge | BILATERAL |
| `SWING_KETTLEBELL` | Swing - Kettlebell | Kettlebell | Hinge | BILATERAL |
| `TRAVELINGLUNGESLEFT_DUMBBELL` | Travelling Lunge - L - Dumbbell | Dumbbell | Lunge | LEFT |
| `TRAVELINGLUNGESRIGHT_DUMBBELL` | Travelling Lunge - R - Dumbbell | Dumbbell | Lunge | RIGHT |
| `TUCKJUMP` | Tuck Jump | Bodyweight | Jump | BILATERAL |
| `WIDEGRIPDEADLIFT_BARBELL` | Deadlift - Wide Grip - Barbell | Barbell | Hinge | BILATERAL |

### OTHER (3)

| exercise_id | Name | Equipment | Movement | Laterality |
|---|---|---|---|---|
| `RUNNING` | Running | Bodyweight | Other | BILATERAL |
| `SPIN_MACHINE` | Spin | Bodyweight | Other | BILATERAL |
| `STAIRMASTER_MACHINE` | Stairmaster | Bodyweight | Other | BILATERAL |

### SHOULDERS (41)

| exercise_id | Name | Equipment | Movement | Laterality |
|---|---|---|---|---|
| `ARNOLDPRESS_DUMBBELL` | Arnold Press - Seated - Dumbbell | Dumbbell | Vertical Press | BILATERAL |
| `AROUNDTHEWORLD_DUMBBELL` | Around the World - Dumbbell | Dumbbell | Other | BILATERAL |
| `BB_Z_PRESS` | BB Z Press | Barbell | Vertical Press | BILATERAL |
| `BEHINDTHENECKPRESS_BARBELL` | Overhead Press - Behind the Neck | Barbell | Vertical Press | BILATERAL |
| `BENCHYRAISE_DUMBBELL` | DB Bench Y Raise | Dumbbell | Other | BILATERAL |
| `DB_Z_PRESS` | DB Z Press | Dumbbell | Vertical Press | BILATERAL |
| `DEFICIT_HANDSTAND_PUSH-UPS` | Deficit Handstand Push-Ups | Bodyweight | Vertical Press | BILATERAL |
| `FACEPULL_PULLEYMACHINE` | Cable Face Pulls | Machine | Horizontal Pull | BILATERAL |
| `FRONTRAISE_DUMBBELL` | Front Shoulder Raise - Dumbbell | Dumbbell | Other | BILATERAL |
| `HANDSTAND_PUSH-UPS` | Handstand Push-Ups | Bodyweight | Vertical Press | BILATERAL |
| `HANDSTAND_WALKS` | Handstand Walks | Bodyweight | Vertical Press | ALTERNATING |
| `KIPPING_HANDSTAND_PUSH-UPS` | Kipping Handstand Push-Ups | Bodyweight | Horizontal Press | BILATERAL |
| `KNEELINGLANDMINEPRESSLEFT_BARBELL` | Kneeling Landmine Press - L | Barbell | Vertical Press | LEFT |
| `KNEELINGLANDMINEPRESSRIGHT_BARBELL` | Kneeling Landmine Press - R | Barbell | Vertical Press | RIGHT |
| `LATERALRAISE_DUMBBELL` | Lateral Shoulder Raise - Dumbbell | Dumbbell | Other | BILATERAL |
| `LATERALRAISELEFT_PULLEYMACHINE` | Lateral Raise - Cable - L | Machine | Other | LEFT |
| `LATERALRAISERIGHT_PULLEYMACHINE` | Lateral Raise - Cable - R | Machine | Other | RIGHT |
| `OVERHEADPRESS_BARBELL` | Overhead Press - Barbell | Barbell | Vertical Press | BILATERAL |
| `OVERHEADPRESS_PULLEYMACHINE` | Shoulder Press - Machine | Machine | Vertical Press | BILATERAL |
| `OVERHEADPRESS_SMITHMACHINE` | Overhead Press - Smith Machine | Machine | Vertical Press | BILATERAL |
| `OVERHEADSQUAT_BARBELL` | Overhead Squat - Barbell | Barbell | Squat | BILATERAL |
| `PUSHJERK_BARBELL` | Push Jerk - Barbell | Barbell | Olympic Lift | BILATERAL |
| `PUSHPRESS_BARBELL` | Push Press - Barbell | Barbell | Vertical Press | BILATERAL |
| `REVERSECHESTFLY_PULLEYMACHINE` | Machine Shoulder Flys | Machine | Other | BILATERAL |
| `REVERSEFLY_DUMBBELL` | Reverse Fly - Dumbbell | Dumbbell | Other | BILATERAL |
| `SEATEDMILITARYPRESS_DUMBBELL` | Overhead Press - Seated - Dumbbell | Dumbbell | Vertical Press | BILATERAL |
| `SHRUGS_BARBELL` | Shrugs - Barbell | Barbell | Other | BILATERAL |
| `SHRUGS_DUMBBELL` | Shrugs - Dumbbell | Dumbbell | Other | BILATERAL |
| `SHRUGS_PULLEYMACHINE` | Shrugs - Cable | Machine | Other | BILATERAL |
| `SINGLEARMPRESSLEFT_DUMBBELL` | Single Arm Press - L - Dumbbell | Dumbbell | Vertical Press | LEFT |
| `SINGLEARMPRESSLEFT_KETTLEBELL` | Single Arm Press - L - Kettlebell | Kettlebell | Vertical Press | LEFT |
| `SINGLEARMPRESSRIGHT_DUMBBELL` | Single Arm Press - R - Dumbbell | Dumbbell | Vertical Press | RIGHT |
| `SINGLEARMPRESSRIGHT_KETTLEBELL` | Single Arm Press - R - Kettlebell | Kettlebell | Vertical Press | RIGHT |
| `STANDINGLANDMINEPRESSLEFT_BARBELL` | Landmine Press - Standing - L - Barbell | Barbell | Horizontal Press | LEFT |
| `STANDINGLANDMINEPRESSRIGHT_BARBELL` | Landmine Press - Standing - R - Barbell | Barbell | Horizontal Press | RIGHT |
| `STRICT_HANDSTAND_PUSH-UPS` | Strict Handstand Push-Ups | Bodyweight | Vertical Press | BILATERAL |
| `THRUSTER_BARBELL` | Thruster - Barbell | Barbell | Squat | BILATERAL |
| `THRUSTER_DUMBBELL` | Thruster - Dumbbell | Dumbbell | Squat | BILATERAL |
| `UPRIGHTROW_BARBELL` | Upright Row - Barbell | Barbell | Vertical Pull | BILATERAL |
| `VERTICALTOSS_MEDBALL` | Vertical Toss - Med Ball | Medicine Ball | Other | BILATERAL |
| `WIDEGRIPOVERHEADPRESS_BARBELL` | Overhead Press - Wide Grip - Barbell | Barbell | Vertical Press | BILATERAL |

---

## Full endpoint catalog (384 paths)

Every deduped path from `src/data/endpoints.ts`. Format: `METHOD STATUS PATH`. Grouped by service. Use this as a reference when calling `whoop_raw`.

#### `/achievements-service` (1 ops)

```
GET 200 /achievements-service/v1/progression?level={level}
```

#### `/activities-service` (10 ops)

```
GET 200 /activities-service/v1/journals/behaviors/user
GET 200 /activities-service/v1/journals/stats/user/0
GET 200 /activities-service/v1/journals/stats/user/{id}
GET 200 /activities-service/v1/sports/history?countryCode=AU
GET 200 /activities-service/v1/sports/history?countryCode=US
GET 200 /activities-service/v1/user-state
GET 200 /activities-service/v2/activity-types
GET 401 /activities-service/v1/user-state
POST 200 /activities-service/v1/user-state
PUT 204 /activities-service/v1/journals/behaviors/user
```

#### `/advanced-labs-service` (1 ops)

```
GET 200 /advanced-labs-service/v1/advanced-labs
```

#### `/ai-conversation-bff` (6 ops)

```
GET 200 /ai-conversation-bff/v1/conversation/{conversation_id}/presentation/CARDIO_DETAILS
GET 200 /ai-conversation-bff/v1/conversation/{conversation_id}/suggestions
GET 200 /ai-conversation-bff/v1/conversation/{conversation_id}/turn/{uuid}
POST 200 /ai-conversation-bff/v1/conversation
POST 200 /ai-conversation-bff/v1/conversation/{conversation_id}/turn
POST 200 /ai-conversation-bff/v1/conversation/{conversation_id}/turn/{uuid}/seen
```

#### `/ai-conversation-service` (3 ops)

```
GET 200 /ai-conversation-service/v1/settings
GET 401 /ai-conversation-service/v1/settings
PUT 200 /ai-conversation-service/v1/settings
```

#### `/app-notifications-service` (2 ops)

```
GET 200 /app-notifications-service/v1/app/notification-cards
PUT 200 /app-notifications-service/v1/app/notifications/{uuid}/expire
```

#### `/auth-service` (5 ops)

```
GET 200 /auth-service/v2/user
GET 200 /auth-service/v2/whoop/password/requirements
OPTIONS 200 /auth-service/v2/user
POST 200 /auth-service/v3/whoop
POST 401 /auth-service/v3/whoop
```

#### `/autopop-service` (1 ops)

```
PUT 204 /autopop-service/v1/autopop/JOURNAL/{id}
```

#### `/behavior-impact-service` (6 ops)

```
GET 200 /behavior-impact-service/v1/impact
GET 200 /behavior-impact-service/v1/impact/journal-trends/{uuid}
GET 200 /behavior-impact-service/v1/impact/journal-trends/{uuid}?endDate={date}
GET 200 /behavior-impact-service/v1/impact/journal-trends/{uuid}?startDate={date}
GET 200 /behavior-impact-service/v1/impact/summary-card/{date}
GET 200 /behavior-impact-service/v2/impact/details/{uuid}
```

#### `/candidate-service` (2 ops)

```
GET 200 /candidate-service/v1/applehealthkit/events?token=1437&permissions=HKCategoryTypeIdentifierSleepAnalysis,HKQuantityTypeIdentifierActiveEnergyBurned,HKQuantityTypeIdentifierHeartRate,HKQuantityTypeIdentifierOxygenSaturation,HKQuantityTypeIdentifierRespiratoryRate,HKQuantityTypeIdentifierRestingHeartRate,HKQuantityTypeIdentifierStepCount,HKWorkoutTypeIdentifier
GET 200 /candidate-service/v1/applehealthkit/events?token=1443&permissions=HKCategoryTypeIdentifierSleepAnalysis,HKQuantityTypeIdentifierActiveEnergyBurned,HKQuantityTypeIdentifierHeartRate,HKQuantityTypeIdentifierOxygenSaturation,HKQuantityTypeIdentifierRespiratoryRate,HKQuantityTypeIdentifierRestingHeartRate,HKQuantityTypeIdentifierStepCount,HKWorkoutTypeIdentifier
```

#### `/coaching-service` (20 ops)

```
GET 200 /coaching-service/v1/health/bff/monitor
GET 200 /coaching-service/v1/health/report
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-23T19:24:51.086-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-23T19:29:57.640-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-23T19:34:58.515-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-23T19:40:36.597-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-23T19:47:32.635-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T17:14:36.868-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T17:20:09.648-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T18:44:19.709-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T18:45:17.937-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T18:50:56.318-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T19:08:11.511-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T19:13:22.641-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T19:16:48.962-0700
GET 200 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T19:18:28.374-0700
GET 200 /coaching-service/v2/sleepneed
GET 404 /coaching-service/v1/health/report
GET 404 /coaching-service/v1/performance-assessment/MONTH/data/2026-05-24T17:08:04.751-0700
POST 200 /coaching-service/v1/health/report
```

#### `/commerce-service` (2 ops)

```
GET 200 /commerce-service/v1/mobile/shop/home?source=menu
GET 200 /commerce-service/v2/join-flow/catalog/memberships?tier=PEAK&country=US&language=en
```

#### `/community-service` (100 ops)

```
DELETE 204 /community-service/v1/communities/36852/leave?userId=200002
DELETE 204 /community-service/v1/communities/{id}/leave?userId=200001
DELETE 204 /community-service/v1/communities/{id}/leave?userId=200002
GET 200 /community-service/v1/chat/token
GET 200 /community-service/v1/communities/12090/members/details?excludeUser=228741&teamType=COMMUNITY&offset={offset}&limit={limit}
GET 200 /community-service/v1/communities/36852/members/details?excludeUser=228741&teamType=COMMUNITY&offset={offset}&limit={limit}
GET 200 /community-service/v1/communities/36858/members/details?excludeUser=228741&teamType=COMMUNITY&offset={offset}&limit={limit}
GET 200 /community-service/v1/communities/36858?userId=0&includeOwnerDetails=true
GET 200 /community-service/v1/communities/41237/members/details?excludeUser=314986&teamType=COMMUNITY&offset={offset}&limit={limit}
GET 200 /community-service/v1/communities/defaultImages
GET 200 /community-service/v1/communities/featured?includeOwnerDetails=true&offset={offset}&limit={limit}
GET 200 /community-service/v1/communities/invites/pending?recipientId=200001&includeDetails=true
GET 200 /community-service/v1/communities/invites/pending?recipientId=200002&includeDetails=true
GET 200 /community-service/v1/communities/memberships?userId=200001&includeOwnerDetails=true&offset={offset}&limit={limit}&teamType=ALL&includeUserRank=true&leaderboardType=strain&startDate={date}
GET 200 /community-service/v1/communities/memberships?userId=200002&includeOwnerDetails=true&offset={offset}&limit={limit}&teamType=ALL&includeUserRank=true&leaderboardType=sleep&startDate={date}&endDate={date}&period=week
GET 200 /community-service/v1/communities/memberships?userId=200002&includeOwnerDetails=true&offset={offset}&limit={limit}&teamType=ALL&includeUserRank=true&leaderboardType=strain&startDate={date}
GET 200 /community-service/v1/communities/{id}/members/details?excludeUser=200001&teamType=COMMUNITY&offset={offset}&limit={limit}
GET 200 /community-service/v1/communities/{id}/members/details?excludeUser=200002&teamType=COMMUNITY&offset={offset}&limit={limit}
GET 200 /community-service/v1/leaderboards/communities/36852/average/month/recovery/score?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/average/month/sleep/performance?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/average/month/strain/day_strain/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/average/month/strain/day_strain?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/average/week/recovery/score?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/average/week/sleep/performance?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/average/week/strain/day_strain/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/average/week/strain/day_strain?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/{date}/recovery/score?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/{date}/sleep/performance?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36852/{date}/strain/day_strain?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/average/month/recovery/score?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/average/month/sleep/performance?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/average/month/strain/day_strain/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/average/month/strain/day_strain?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/average/week/recovery/score?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/average/week/sleep/performance?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/average/week/strain/day_strain/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/average/week/strain/day_strain?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/{date}/recovery/score?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/{date}/sleep/performance?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/36858/{date}/strain/day_strain?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/month/recovery/score/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/month/recovery/score?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/month/sleep/performance/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/month/sleep/performance?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/month/strain/day_strain/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/month/strain/day_strain?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/week/recovery/score/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/week/recovery/score?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/week/sleep/performance/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/week/sleep/performance?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/week/strain/day_strain/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/average/week/strain/day_strain?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/{date}/recovery/score/user/{id}?teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/{date}/recovery/score?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/{date}/sleep/performance/user/{id}?teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/{date}/sleep/performance?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/{date}/strain/day_strain/user/{id}?teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/41237/{date}/strain/day_strain?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/average/week/recovery/score?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/average/week/sleep/performance?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/average/week/strain/day_strain/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/average/week/strain/day_strain?offset={offset}&limit={limit}&startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/{date}/recovery/score/user/{id}?teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/{date}/recovery/score?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/{date}/sleep/performance/user/{id}?teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/{date}/sleep/performance?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/{date}/strain/day_strain/user/{id}?teamType=COMMUNITY
GET 200 /community-service/v1/leaderboards/communities/{id}/{date}/strain/day_strain?offset={offset}&limit={limit}&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36852/average/month/recovery/score/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36852/average/month/sleep/performance/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36852/average/week/recovery/score/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36852/average/week/sleep/performance/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36852/{date}/recovery/score/user/{id}?teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36852/{date}/sleep/performance/user/{id}?teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36852/{date}/strain/day_strain/user/{id}?teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36858/average/month/recovery/score/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36858/average/month/sleep/performance/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36858/average/week/recovery/score/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36858/average/week/sleep/performance/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36858/{date}/recovery/score/user/{id}?teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36858/{date}/sleep/performance/user/{id}?teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/36858/{date}/strain/day_strain/user/{id}?teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/{id}/average/week/recovery/score/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/{id}/average/week/sleep/performance/user/{id}?startDate={date}&endDate={date}&includeCompliance=true&complianceCutoff=70&teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/{id}/{date}/recovery/score/user/{id}?teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/{id}/{date}/sleep/performance/user/{id}?teamType=COMMUNITY
GET 404 /community-service/v1/leaderboards/communities/{id}/{date}/strain/day_strain/user/{id}?teamType=COMMUNITY
POST 200 /community-service/v1/communities/join/COMM-0D8539
POST 200 /community-service/v1/communities/join/COMM-68073D
POST 200 /community-service/v1/communities?includeOwnerDetails=true
PUT 200 /community-service/v1/communities/41237/status?online=false
PUT 200 /community-service/v1/communities/41237/status?online=true
PUT 200 /community-service/v1/communities/{id}
PUT 200 /community-service/v1/communities/{id}/chat?chatEnabled=false&teamType=COMMUNITY
PUT 200 /community-service/v1/communities/{id}/chat?chatEnabled=true&teamType=COMMUNITY
PUT 200 /community-service/v1/communities/{id}/status?online=false
PUT 200 /community-service/v1/communities/{id}/status?online=true
PUT 401 /community-service/v1/communities/41237/status?online=false
PUT 403 /community-service/v1/communities/67472/status?online=false
PUT 403 /community-service/v1/communities/{id}/status?online=false
```

#### `/context-hub-bff` (2 ops)

```
GET 200 /context-hub-bff/v1/context-hub?analytics_source=coach-chat
GET 200 /context-hub-bff/v1/context-hub?analytics_source=profile
```

#### `/core-details-bff` (8 ops)

```
DELETE 204 /core-details-bff/v1/cardio-details?activityId={uuid}
GET 200 /core-details-bff/v1/cardio-details?activityId={uuid}
GET 200 /core-details-bff/v1/start-activity/strain
GET 200 /core-details-bff/v2/activity-type/user-created
GET 200 /core-details-bff/v2/prediction/{id}/activity
GET 414 /core-details-bff/v1/cardio-details?activityId={uuid}
POST 200 /core-details-bff/v0/create-activity
POST 400 /core-details-bff/v2/create-activity
```

#### `/device-config` (1 ops)

```
GET 200 /device-config/v1/value
```

#### `/enterprise-service` (1 ops)

```
GET 200 /enterprise-service/v1/data-sharing
```

#### `/entitlement-service` (2 ops)

```
GET 200 /entitlement-service/v1/entitlements
PUT 200 /entitlement-service/v1/entitlements/onboarding
```

#### `/followers-service` (5 ops)

```
GET 200 /followers-service/v1/followers-home
GET 200 /followers-service/v1/followers-home/manage
GET 200 /followers-service/v1/followers-home/manage/SHARING
GET 200 /followers-service/v1/search
GET 200 /followers-service/v1/search/results
```

#### `/growth-content-service` (5 ops)

```
GET 200 /growth-content-service/v1/in-app-welcome-screen/order-info-content
GET 200 /growth-content-service/v1/payment-method/menu-item
GET 401 /growth-content-service/v1/advanced-labs/management/menu-item
GET 401 /growth-content-service/v1/payment-method/menu-item
GET 404 /growth-content-service/v1/advanced-labs/management/menu-item
```

#### `/health-service` (6 ops)

```
DELETE 204 /health-service/v1/hormonal-insights/settings/mci
GET 200 /health-service/v2/stress-bff/{date}
GET 200 /health-service/v2/stress-bff/{date}/calendar
GET 401 /health-service/v2/stress-bff/{date}
POST 404 /health-service/v2/stress-bff?timestamp=May%2024,%202026
PUT 204 /health-service/v1/hormonal-insights/settings/mci/survey
```

#### `/health-tab-bff` (2 ops)

```
GET 200 /health-tab-bff/v1/health-tab
GET 401 /health-tab-bff/v1/health-tab
```

#### `/home-service` (19 ops)

```
GET 200 /home-service/v1/calendar/overview?date={date}
GET 200 /home-service/v1/calendar/recovery?date={date}
GET 200 /home-service/v1/deep-dive/recovery/trends?date={date}
GET 200 /home-service/v1/deep-dive/recovery?date={date}
GET 200 /home-service/v1/deep-dive/sleep/last-night?date={date}
GET 200 /home-service/v1/deep-dive/sleep/trends?date={date}
GET 200 /home-service/v1/deep-dive/sleep?date={date}
GET 200 /home-service/v1/deep-dive/strain/trends?date={date}
GET 200 /home-service/v1/deep-dive/strain?date={date}
GET 200 /home-service/v1/home?date={date}
GET 200 /home-service/v1/tilt-view?date={date}
GET 200 /home-service/v1/widget/overview?widgetSize=MEDIUM
GET 200 /home-service/v1/widget/overview?widgetSize=SMALL
GET 200 /home-service/v2/home/dashboard/customize
GET 401 /home-service/v1/home?date={date}
GET 401 /home-service/v1/widget/overview?widgetSize=MEDIUM
GET 401 /home-service/v1/widget/overview?widgetSize=SMALL
GET 404 /home-service/v1/widget/overview?widgetSize=MEDIUM
GET 404 /home-service/v1/widget/overview?widgetSize=SMALL
```

#### `/hr-zones-service` (5 ops)

```
GET 200 /hr-zones-service/v1/bff/settings
GET 200 /hr-zones-service/v1/bff/zones
GET 404 /hr-zones-service/v1/bff/zones
POST 200 /hr-zones-service/v1/bff/custom
POST 200 /hr-zones-service/v1/maxhr
```

#### `/integrations-bff` (4 ops)

```
GET 200 /integrations-bff/v1/integrations/discovery
GET 200 /integrations-bff/v1/integrations/trainingpeaks/details
GET 200 /integrations-bff/v1/integrations/withings/details
GET 200 /integrations-bff/v1/integrations/{uuid}/details
```

#### `/journal-service` (9 ops)

```
GET 200 /journal-service/v1/journals/preferences
GET 200 /journal-service/v2/journals/behaviors
GET 200 /journal-service/v2/journals/behaviors/user/{date}
GET 200 /journal-service/v3/journals/behaviors
GET 200 /journal-service/v3/journals/date-picker/{date}
GET 200 /journal-service/v3/journals/drafts/mobile/{date}
GET 200 /journal-service/v3/journals/home-tile?date={date}
PUT 200 /journal-service/v1/journals/preferences
PUT 204 /journal-service/v2/journals/entries/user/date/{date}
```

#### `/member-data-export-service` (1 ops)

```
GET 200 /member-data-export-service/v1/member-data-export-details
```

#### `/membership` (4 ops)

```
GET 200 /membership/accessories/shop/auth
GET 401 /membership/accessories/shop/auth
OPTIONS 204 /membership/referrals
POST 200 /membership/referrals
```

#### `/membership-service` (34 ops)

```
GET 200 /membership-service/v0/onboarding/info?flow=create-account&strapSerial=5BG0021577&strapSignature=MmM1NDU2ODQ1ZTIyMzU5ODljOTRlNWM5MTRmODZi
GET 200 /membership-service/v1/billing/info
GET 200 /membership-service/v1/billing/payment_method
GET 200 /membership-service/v1/billing/whoop-pro/info
GET 200 /membership-service/v1/family-plans-native/hub
GET 200 /membership-service/v1/gift-content
GET 200 /membership-service/v1/membership-management
GET 200 /membership-service/v1/membership-management/membership-and-billing
GET 200 /membership-service/v1/membership?useReplica=true
GET 200 /membership-service/v1/payment/public-stripe-key
GET 200 /membership-service/v1/refer-a-friend/menu
GET 200 /membership-service/v1/straps
GET 200 /membership-service/v2/in-app-banners
GET 200 /membership-service/v2/refer-a-friend/community
GET 200 /membership-service/v2/referral-content?source=Individual
GET 200 /membership-service/v2/referral-content?source=Team
GET 200 /membership-service/v2/upcycle/onboarding/finalizedContent
GET 200 /membership-service/v3/billing/info?useReplica=false
GET 400 /membership-service/v1/membership/native-account-header
GET 401 /membership-service/v1/billing/info
GET 401 /membership-service/v1/billing/payment_method
GET 401 /membership-service/v1/payment/public-stripe-key
GET 401 /membership-service/v1/refer-a-friend/menu
GET 401 /membership-service/v1/straps
GET 401 /membership-service/v2/in-app-banners
GET 404 /membership-service/v1/payment/public-stripe-key
GET 404 /membership-service/v2/straps/pairing-adjustment?strapSerial=5BG0021577&strapSignature=MmM1NDU2ODQ1ZTIyMzU5ODljOTRlNWM5MTRmODZi
OPTIONS 200 /membership-service/v1/billing/info
OPTIONS 200 /membership-service/v1/billing/whoop-pro/info
OPTIONS 200 /membership-service/v1/payment/public-stripe-key
OPTIONS 200 /membership-service/v3/billing/info?useReplica=false
OPTIONS 204 /membership-service/v1/membership?useReplica=true
POST 204 /membership-service/v1/membership-management/resume
POST 204 /membership-service/v2/straps/pairing-adjustment
```

#### `/membership?useReplica=false` (1 ops)

```
GET 200 /membership?useReplica=false
```

#### `/membership?useReplica=true` (3 ops)

```
GET 200 /membership?useReplica=true
GET 428 /membership?useReplica=true
OPTIONS 204 /membership?useReplica=true
```

#### `/metrics-service` (4 ops)

```
GET 200 /metrics-service/v1/consumerstats/mobile/highwatermark/min
POST 200 /metrics-service/v1/metrics
POST 400 /metrics-service/v1/metrics
POST 401 /metrics-service/v1/metrics
```

#### `/notification-service` (5 ops)

```
DELETE 200 /notification-service/v1/notifications/user-settings/block/namespace/GPS
DELETE 200 /notification-service/v1/notifications/user-settings/block/namespace/StressSummary
GET 200 /notification-service/v1/notifications/user-settings/bff
POST 200 /notification-service/v1/notifications/events
PUT 200 /notification-service/v1/notifications/user-settings/block/namespace
```

#### `/onboarding-service` (20 ops)

```
GET 200 /onboarding-service/v1/account/activate
GET 200 /onboarding-service/v1/account/device-education
GET 200 /onboarding-service/v1/account/start-auth?fromLogin=true
GET 200 /onboarding-service/v1/account/start?email=briangao2%40gmail.com&fromLogin=false
GET 200 /onboarding-service/v1/app/destination
GET 200 /onboarding-service/v1/feature-education-state?userId=200001
GET 200 /onboarding-service/v1/feature-education-state?userId=200002
GET 200 /onboarding-service/v1/features/educations/onboarding/PAIRING_MODE_EDUCATION
GET 200 /onboarding-service/v1/features/educations/{education_name}
GET 200 /onboarding-service/v1/overlay/all
GET 200 /onboarding-service/v1/what-to-expect
GET 200 /onboarding-service/v1/what-to-expect/entry-point
GET 401 /onboarding-service/v1/what-to-expect/entry-point
GET 404 /onboarding-service/v1/learn-more-carousel/bff/community?zoneId=America/Los_Angeles&cta=MORE
POST 200 /onboarding-service/v1/account/activate
POST 200 /onboarding-service/v2/emails/check
PUT 200 /onboarding-service/v1/account/profile
PUT 200 /onboarding-service/v1/feature-education-state?userId=200001
PUT 200 /onboarding-service/v1/feature-education-state?userId=200002
PUT 204 /onboarding-service/v1/account/sign-up
```

#### `/privacy-service` (2 ops)

```
GET 200 /privacy-service/v1/user_privacy_settings/
PUT 200 /privacy-service/v1/user_privacy_settings/allow-recommendation
```

#### `/profile-service` (5 ops)

```
GET 200 /profile-service/v1/profile/bff
GET 200 /profile-service/v1/profile/bff/edit
PUT 200 /profile-service/v1/profile
PUT 200 /profile-service/v1/profile/avatar
PUT 400 /profile-service/v1/profile
```

#### `/progression-service` (6 ops)

```
GET 200 /progression-service/v2/weekly-plan/home-tile/{date}
GET 200 /progression-service/v2/weekly-plan/setup?screens=STRENGTH_TRAINING_TIME&editing=true
GET 200 /progression-service/v3/exercise/{exercise_id}?endDate={date}
GET 200 /progression-service/v3/exercise?endDate={date}
GET 200 /progression-service/v3/trends/{metric}?endDate={date}
PUT 204 /progression-service/v2/weekly-plan/{uuid}/goal/target
```

#### `/research-service` (1 ops)

```
GET 200 /research-service/research-bff-service/v1/campaigns
```

#### `/sleep-service` (1 ops)

```
GET 200 /sleep-service/v1/heart-rate/baseline
```

#### `/smart-alarm-bff` (3 ops)

```
GET 200 /smart-alarm-bff/v1/schedule/all
GET 200 /smart-alarm-bff/v1/schedule/components/populated/{uuid}
PUT 200 /smart-alarm-bff/v1/schedule/{uuid}
```

#### `/smart-alarm-service` (7 ops)

```
GET 200 /smart-alarm-service/v1/smartalarm/preferences
POST 204 /smart-alarm-service/v1/smartalarm/wbl
POST 401 /smart-alarm-service/v1/smartalarm/wbl
PUT 200 /smart-alarm-service/v1/smartalarm/preferences
PUT 200 /smart-alarm-service/v1/strap-status
PUT 204 /smart-alarm-service/v1/alarm-schedule/disable
PUT 204 /smart-alarm-service/v1/alarm-schedule/enable
```

#### `/social-service` (1 ops)

```
GET 200 /social-service/v1/strava/bff/settings
```

#### `/strap-location-service` (2 ops)

```
GET 200 /strap-location-service/v1/garment
GET 401 /strap-location-service/v1/garment
```

#### `/streaks-service` (2 ops)

```
GET 200 /streaks-service/v1/bff/streaks/data-streak
GET 200 /streaks-service/v1/streaks/data-streak
```

#### `/users-service` (23 ops)

```
DELETE 204 /users-service/v1/hidden-metrics/BODY_COMP
DELETE 204 /users-service/v1/hidden-metrics/HEALTHSPAN
GET 200 /users-service/v1/hidden-metrics/BODY_COMP
GET 200 /users-service/v1/hidden-metrics/HEALTHSPAN
GET 200 /users-service/v1/stealth-mode
GET 200 /users-service/v1/users/{id}/preference
GET 200 /users-service/v2/bootstrap
GET 200 /users-service/v2/bootstrap/account
GET 200 /users-service/v2/bootstrap/membership
GET 200 /users-service/v2/bootstrap/user
GET 401 /users-service/v2/bootstrap
GET 404 /users-service/v1/goals/user/motivation
OPTIONS 200 /users-service/v2/bootstrap/account
OPTIONS 200 /users-service/v2/bootstrap/membership
OPTIONS 200 /users-service/v2/bootstrap/user
PATCH 200 /users-service/v0/users/preference
POST 200 /users-service/v1/users/check/username
POST 200 /users-service/v1/users/preferences/time
POST 204 /users-service/v1/hidden-metrics/BODY_COMP
POST 204 /users-service/v1/hidden-metrics/HEALTHSPAN
PUT 200 /users-service/v1/stealth-mode
PUT 200 /users-service/v1/users/{id}/privacy
PUT 204 /users-service/v1/users/profile/offset
```

#### `/vow-service` (1 ops)

```
POST 200 /vow-service/v1/coaching/vows/sleepcoach?format=TWELVE_HOUR
```

#### `/weightlifting-service` (16 ops)

```
GET 200 /weightlifting-service/v1/exercise/BAR-FACING_BURPEES_(LATERAL)
GET 200 /weightlifting-service/v1/exercise/{exercise_id}
GET 200 /weightlifting-service/v1/exercise/{exercise_id}(BAND)
GET 200 /weightlifting-service/v1/exercise/{exercise_id}(MACHINE)
GET 200 /weightlifting-service/v1/exercise/{exercise_id}{uuid}
GET 200 /weightlifting-service/v2/exercise
GET 200 /weightlifting-service/v2/workout-template/{id}
GET 200 /weightlifting-service/v3/exercise/{exercise_id}
GET 200 /weightlifting-service/v3/exercise/{exercise_id}/exercise_history
GET 200 /weightlifting-service/v3/exercise/{exercise_id}/personal_records
GET 200 /weightlifting-service/v3/prs
GET 200 /weightlifting-service/v3/prs?startDate={date}&endDate={date}&offset={offset}
GET 200 /weightlifting-service/v3/workout-library
POST 200 /weightlifting-service/v2/custom-exercise
POST 200 /weightlifting-service/v2/weightlifting-workout/activity
POST 200 /weightlifting-service/v3/workout-template
```

#### `/widget-service` (2 ops)

```
GET 200 /widget-service/v1/statistics/recovery
GET 401 /widget-service/v1/statistics/recovery
```

#### `/womens-health-service` (8 ops)

```
GET 200 /womens-health-service/v1/hormonal-insights/onboarding
GET 200 /womens-health-service/v1/hormonal-insights/settings
GET 200 /womens-health-service/v1/menstrual-cycle-insights/calendar?date={date}
GET 200 /womens-health-service/v1/menstrual-cycle-insights/cycles/edit?localDate={date}&source=CYCLE_CALENDAR
GET 200 /womens-health-service/v1/menstrual-cycle-insights?date={date}
GET 200 /womens-health-service/v1/symptom-insights/log/symptoms?requestDate={date}
POST 204 /womens-health-service/v1/symptom-insights/log/symptoms?requestDate={date}
PUT 204 /womens-health-service/v1/menstrual-cycle-insights/log
```

---

*End of deep endpoint research.*
