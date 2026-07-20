# Whoop iOS API — Deep Endpoint Research

> Full writeup of Whoop's private iOS API surface. 47 microservices, **311 templated endpoints** (419 raw operations captured → 384 after body-shape dedup → 311 after path-templating; the bundled `src/data/endpoints.ts` ships these 311), ~85 KB of captured request bodies, ~6 MB of captured response payloads. Compiled from three mitmproxy capture sessions across two accounts.

**This document is for developers**. If you want to understand what the MCP does, read [`README.md`](README.md). If you want to know how Whoop's private API actually works at the wire level — what bytes go in, what bytes come out, what enums exist, what status codes mean what, how auth works — read this.

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

After dedup: **419 unique operations across 47 microservices**, collapsed to **384 body-shape-deduped paths** (merging variants that differed only cosmetically), then to **311 final paths** once the IDs / timestamps / tokens embedded in those paths were templated to placeholders — rows that differed only by a literal value (e.g. `/communities/36852/…` vs `/communities/12090/…`) merged into one (`/communities/{id}/…`). The bundled `src/data/endpoints.ts` ships these **311** templated paths.

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

After auth, every API call to `api.prod.whoop.com/<service>/<endpoint>` carries the
bearer token **plus the iOS app's full identity header set**, so our traffic sits
inside the legitimate-app distribution instead of standing out as the one client
that omits them (`src/whoop/device.ts` builds these; `src/whoop/client.ts` merges
them):

```
authorization: Bearer <access token>           (capital "Bearer", as the app sends)
user-agent: iOS                                (literally "iOS" — the app's data-request UA)
x-whoop-device-platform: iOS
x-whoop-ios-version: 5.52.0                     ← app-version constant (bump on app updates)
x-whoop-ios-build-number: 595097               ← build-number constant
x-whoop-bundle-name: com.whoop.iphone
x-whoop-installation-identifier: <UUID>         ← randomized per install, persisted to .env
x-whoop-time-zone: <IANA name>                  ← derived from the host, like a phone
x-whoop-clock-format: TWELVE_HOUR
currency: USD
locale: en_US
accept-language: en
accept: */*
priority: u=3
content-type: application/json                  (for POST/PUT/PATCH only)
```

**Why these and not more.** The static values above are the app's *own* constants —
shared by every real install on this version, so they're camouflage, not a
signature. The installation identifier is randomized per install (uppercase UUID,
persisted via `src/whoop/installation.ts` so it's stable across restarts), exactly
like the app, so there's no shared constant to fingerprint. Timezone is derived
from the host. We deliberately send **nothing the app doesn't** — no Sentry
`baggage`/`sentry-trace`, no marketing cookies — because a unique invented header
in open-source code would be the precise one-line WAF rule we're avoiding. We also
don't set `accept-encoding` ourselves: doing so disables undici's automatic
response decompression and would break `response.json()`.

Two of these headers also affect response *content*, and both were verified safe:
`x-whoop-clock-format: TWELVE_HOUR` matches the server's existing default (our
captures already return 12-hour clock labels, which `parseClockMinutes` expects),
and `x-whoop-time-zone` only changes the wall-clock rendering of clock labels,
which the sleep hypnogram consumes by *relative spacing* anchored to the UTC
`[start,end]` window — so the timeline is zone-invariant.

Not matched (deliberately, to stay this side of "over the top"): the transport
fingerprint. We're Node/undici over HTTP/1.1 with a Node TLS signature, not iOS
Network.framework over HTTP/2 — faking that would need curl-impersonate/uTLS and a
datacenter IP claiming to be a phone is its own anomaly. App-layer headers are what
a WHOOP engineer reading this repo could cheaply key on; those are what we match.

The `apiVersion=7` query parameter is automatically appended to every request by `src/whoop/client.ts:56`:

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
WHOOP_USER_ID={userId}
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
- For sleep stages, the BFF endpoint `/home-service/v1/deep-dive/sleep/last-night?date=` returns the full UI tree (~848 KB). We project from it because it's the only sleep stage source, extracting the structured fields we need (~6 KB output, most of it the per-stage hypnogram timeline reconstructed from the HR-curve points).
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
| `{community_id}` | Integer | Stable community ID. Seen: `12090, {id}, 36858, 41237, 67472`. |
| `{user_id}` | Integer | Stable user ID. Seen: `{userId}`, `200002` (test testuser2), `228741` (likely Whoop staff member who appeared in a leaderboard), `314986` (another user from leaderboard). |
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

Not wrapped — `whoop_progress` (combined streaks + achievements) was in v1 but cut from v2. Reach it via `whoop_raw` if needed.

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

The MCP wraps `whoop_coach_ask`, which runs the full create-conversation → send-turn → poll-for-response flow in a single call. The async polling waits up to 30 × 1 second for the response.

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
| POST | `/community-service/v1/communities/join/{COMM-CODE}` | 200 | Body empty. Path codes seen: `COMM-{code}, COMM-{code}`. Response 329 B: `{id, unread_count, deleted, online, member_type, notification_setting, created_at, updated_at, last_online, user_id}`. |
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

Communities observed in Brian's account: `12090, {id}, 36858, 41237, 67472`. The 41237 community had a member named "Whoop Team" (user_id 228741) — possibly internal staff. The 67472 community had a 403 on online status — Brian had left it.

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
| GET | `/home-service/v1/deep-dive/sleep/last-night?date={date}` | 200 | **848,428 B = 848 KB!** `{header_section, sub_header_section, sections}`. Full sleep stages + hypnogram + HR + HRV traces. The single biggest non-binary response in the API. The MCP wraps this as `whoop_sleep` and extracts ~6 KB of clean data — stage totals, the full per-stage hypnogram, and in-sleep HR (avg/min), all reconstructed from the per-stage HR-curve points. |
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
| GET | `/membership-service/v0/onboarding/info?flow=create-account&strapSerial={serial}&strapSignature={hash}` | 200 | 268 B `{require_credit_card, require_team_code, show_annual_upsell, family_plan, active_family_plan, paired_text_override, num_trial_months, strap_membership_status, membership_tier_type, is_used_strap}` — first call during signup after the user pairs a strap. `strapSerial` example: `{strapSerial}`. `strapSignature` is a base64'd cryptographic signature proving the user has physical possession of the strap. |

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

The MCP wraps `whoop_trend` (the 25-metric trend) and `whoop_lift_progression` (single exercise). `whoop_weekly_plan` was in v1 but cut from v2.

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
| POST | `/users-service/v1/users/check/username` | 200 | Body: `{"username":"testuser2", "strap_serial":"{strapSerial}", "strap_signature":"<hash>"}` — username availability check (signup only). The strap signature gates this so anonymous probes can't enumerate usernames. |
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

#### Link-cardio-workout body (attach a lift to an existing activity)

`POST /weightlifting-service/v2/weightlifting-workout/link-cardio-workout` is the endpoint behind the app's **"Calculate Muscular Load"** option on a strap-tracked activity (the `LINK_MSK_WORKOUT` menu action, gated by `link_workout_option_enabled` in `cardio-details`). Unlike `.../weightlifting-workout/activity` — which *creates* a new Strength Trainer activity — this **attaches** set-by-set strength data to an activity that already exists (e.g. a `weightlifting` cardio activity the strap recorded), so the one activity carries both the HR/cardio strain and the computed Muscular Load. Afterwards the activity reports as `weightlifting_msk`.

It is a **two-call sequence**, mirroring the iOS app:

1. `POST /weightlifting-service/v3/workout-template` with `{name, workout_groups}` → returns `{workout_template_key, ...}`.
2. `POST /weightlifting-service/v2/weightlifting-workout/link-cardio-workout` with the template inline **plus** that key and the target `activity_id`:

```json
{
  "template": {
    "workout_groups": [
      {
        "workout_exercises": [
          {
            "sets": [
              { "weight": 15, "number_of_reps": 2 },
              { "weight": 15, "number_of_reps": 3 }
            ],
            "exercise_details": { /* full catalog exercise, same shape as the log body */ }
          }
        ]
      }
    ],
    "name": "20 Jul 2026",
    "source": "USER",
    "workout_template_key": {templateId}
  },
  "rpe": 0,
  "template_id": {templateId},
  "activity_id": "{activityId}"
}
```

**Critical details:**

- **Sets are far simpler here than in the log body** — just `{weight, number_of_reps}` (plus `time_in_seconds` for `TIME`-format exercises). No `during` range, no `weightlifting_workout_set_id`, no `strap_location*`, no per-set `msk_total_volume_kg`: Whoop derives the workout window from the linked activity.
- `exercise_details` is still the full denormalized catalog object (`created_at`/`updated_at` must be non-empty, same 422-on-empty rule as the log body).
- `template_id` and `template.workout_template_key` are both the integer returned by the step-1 template `POST`; they match.
- `rpe` observed as `0`.
- Response 200: `{original_activity_id, original_activity_type, workout_metadata}`, where `workout_metadata` is the now-linked activity carrying a fresh `weightlifting_workout_id`, `workout_template_id`, `total_effective_volume_kg`, and `scaled_msk_strain_score`:

```json
{
  "original_activity_id": "{activityId}",
  "original_activity_type": "weightlifting",
  "workout_metadata": {
    "id": "{activityId}",
    "user_id": {userId},
    "during": "['2026-07-20T16:36:34.972Z','2026-07-20T18:09:29.181Z')",
    "score_type": "CARDIO",
    "type": "weightlifting",
    "weightlifting_workout_id": "{uuid}",
    "workout_template_id": {templateId},
    "total_effective_volume_kg": 141.65,
    "raw_msk_strain_score": 0.00199,
    "msk_intensity_percent": 0.4,
    "scaled_msk_strain_score": 0.197
  }
}
```

Not yet wrapped by the MCP. Independently captured from the iOS app (mitmproxy); account-specific IDs above are templated as `{activityId}` / `{userId}` / `{templateId}` / `{uuid}`.

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
| `{id}` | `12090, {id}, 1520732784` | Numeric DB primary keys |
| `{date}` | `2026-05-23` | ISO YYYY-MM-DD, client uses local TZ |
| `{community_id}` | `12090, {id}, 36858, 41237, 67472` | Integer |
| `{user_id}` | `{userId}, 200002, 228741, 314986` | Integer, stable per account |
| `{exercise_id}` | `BENCHPRESS_BARBELL, ASSAULT_AIRBIKE, ASSISTED_PULL_UPS_(BAND)` | Upper-snake catalog ID OR UUID for custom |
| `{behavior_id}` | `1, 80, 145, 338, 397` | Integer 1-398 (308 active) |
| `{metric}` | `HRV, RHR, RECOVERY, STEPS, VO2_MAX` | 25-value enum |
| `{education_name}` | `PAIRING_MODE_EDUCATION, ADVANCED_LABS_LH_CYCLE_RANGES` | Upper-snake string |
| `{conversation_id}` | `5e0d4424-b31a-4a67-b06d-dfbf1030c0e9` | UUID, server-assigned at create |
| `{namespace}` | `GPS, StressSummary` | Upper-camel string |
| `{COMM-CODE}` | `COMM-{code}, COMM-{code}` | Community invite code |
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
  "user_id": {userId},
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

Covered in full under [Cross-cutting patterns → Pattern 5](#pattern-5-status-code-taxonomy). Quick reference: **200** success+body · **204** success / no body (writes) · **400** validation (`{code, message, location}`) · **401** JWT expired · **403** permission denied (e.g. a community you left) · **404** not found / feature not provisioned / no leaderboard data · **409** conflict (overlapping time ranges) · **414** URI too long (one-off) · **422** business-rule rejection · **428** precondition required · **500** rare server bug (behavior-impact 500'd on a stale UUID).

---

## Token cost analysis

Whoop's BFFs are extraordinarily verbose by design — they ship UI code, not data — so the MCP's projections cut most responses by **99%+**: the 848 KB sleep response → ~6 KB (`whoop_sleep`, mostly the hypnogram timeline), the 300 KB workout detail → ~500 chars (`whoop_workout`), the 118 KB trend → 0.5–12 KB depending on populated windows (`whoop_trend`), the 54 KB home → ~480 chars (`whoop_today`). Raw response sizes per endpoint are tabulated in [Appendix B](#appendix-b-bytes-per-endpoint-response-payload-observed) and noted inline in the per-service reference.

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
419 unique operations total  (→ 311 after path-templating; that's the count bundled in src/data/endpoints.ts)
```

---

## Appendix B: Bytes per endpoint (response payload, observed)

The largest responses by byte size — what the iOS app pulls; the MCP reduces most by 99%+:

```
 1,529,442  /health-service/v2/stress-bff/{date}                     (~1.5 MB, estimated)
   848,428  /home-service/v1/deep-dive/sleep/last-night?date={date}
   538,889  /home-service/v1/tilt-view?date={date}
   385,000  /weightlifting-service/v2/exercise                       (exercise catalog)
   300,123  /core-details-bff/v1/cardio-details?activityId={uuid}
   176,630  /activities-service/v1/journals/behaviors/user
   118,399  /progression-service/v3/trends/{metric}?endDate={date}
    88,606  /activities-service/v1/sports/history?countryCode=US
    73,571  /journal-service/v3/journals/behaviors
    68,672  /commerce-service/v1/mobile/shop/home?source=menu
    66,646  /journal-service/v2/journals/behaviors
    54,998  /activities-service/v2/activity-types
    54,751  /home-service/v1/home?date={date}
    44,991  /home-service/v1/deep-dive/sleep/trends?date={date}
    37,346  /womens-health-service/v1/menstrual-cycle-insights?date={date}
```

The rest are noted inline in the [per-service reference](#per-service-endpoint-reference).

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

Full raw responses for the highest-value endpoints are committed under [`tests/fixtures/*.json`](tests/fixtures) (the projection test suite asserts exact field values against them). The structural keys each projection walks:

- **`home.json`** (54 KB, `whoop_today`) — `pillars[OVERVIEW].sections[].items[]`: `SCORE_GAUGE_STICKY.gauges[]` (SLEEP/RECOVERY/STRAIN `score_display` + `progress_fill_style`) for scores; `ACTIVITY` items for workout count. State from `progress_fill_style` (`RECOVERY_HIGH→GREEN`, `_MEDIUM→YELLOW`, `_LOW→RED`).
- **`deep_dive_recovery.json`** (21 KB, `whoop_recovery`) — migrated May 2026 to `SCORE_GAUGE { id: RECOVERY_SCORE_GAUGE }` + `CONTRIBUTORS_TILE { id: RECOVERY_CONTRIBUTORS_TILE }.metrics[]` (HRV / RHR / RESPIRATORY_RATE / SLEEP_PERFORMANCE; `status` = today, `status_subtitle` = baseline). See [Pattern 2b](#pattern-2b-score_gauge--contributors_tile-may-2026-recovery--strain).
- **`deep_dive_sleep.json`** (848 KB, `whoop_sleep`) — `DETAILS_GRAPHING_CARD[card_title].arrow_stat[0].current_stat_text` for HOURS OF SLEEP / HOURS VS. NEEDED / SLEEP CONSISTENCY / SLEEP EFFICIENCY; `BAR_GRAPH_CARD.duration_display` for time-in-bed; `BAR_GRAPH_CARD.heart_rate_zones[]` (misnamed — these are the sleep stages AWAKE / LIGHT_SLEEP / SWS_SLEEP / REM_SLEEP, each with `bar_graph_tile_time_display` + `_percentage_display`); start/end from `header_section.destination.parameters`. The per-stage HR-curve `LINE_PLOT`s (points with `data_scrubber_details.scrubber_style` = stage, `value_display` = bpm, `secondary_contextual_display` = clock time) are walked + merged to reconstruct the `hypnogram` (timed off the clock labels, anchored to the sleep window at its midpoint) and `sleep_hr` (avg/min).
- **`deep_dive_strain.json`** (29 KB, `whoop_strain`) — migrated May 2026 to `STRAIN_SCORE_GAUGE` + `STRAIN_CONTRIBUTORS_TILE.metrics[]` (HR_ZONES_1_3 / HR_ZONES_4_5 / STRENGTH_TRAINING_TIME / STEPS); workout count from `ACTIVITY` items. `calories` / `avg_hr` / `max_hr` / per-zone granularity are no longer here — fetch per-workout `/cardio-details`.
- **`cardio_details.json`** (300 KB) + **`cardio_details_nonstrength.json`** (540 KB), `whoop_workout` — `title_bar.title_display` (sport), `key_metric_carousel.key_metric_tile[]` by icon (CALORIES / HEART_RATE / MAX_HEART_RATE / DURATION), `bar_graph_container.heart_rate_zones[]` (id → zone: RESTORATIVE=0 … MAX=5), `graph_response.plots[].plot.segments[].points[]` (HR curve), `weightlifting_cardio_details.weightlifting_exercises.exercise_summary_carousel.items[]` (per-exercise aggregates; first item is the summary row), `strain_breakdown.msk_percent_display`. Non-strength: `strain_breakdown` + `weightlifting_cardio_details` are null.
- **`trend_hrv.json`** (117 KB, `whoop_trend`) — `{week,month,six_month}_time_segment`, each with `metrics[]` (**an array** — read `metrics[0].current_metric_value` + `metric_change`, NOT `metrics.avg`) and `graph.plots[].plot.segments[].points[]` where `data_scrubber_details.value` is null and the real number is `value_display` / `graph_label.label` (strings).
- **`bootstrap.json`** (1.2 KB, `whoop_profile`) — `{account, user, profile, membership, bio_data}`. Quirks the projection handles: `profile.birthday` is a full ISO datetime (the PUT wants YYYY-MM-DD); `profile.gender` is lowercase (the PUT wants uppercase).
- **`lift_prs.json`** (10 KB, `whoop_lift_prs`) — `tiles[]` with exercise metadata + `volume_input_value` (a **string**, coerced via `asNumber`).
- **stress** (`/stress-bff/{date}`, ~1.3 MB, `whoop_stress`) — `stress_state.timeline[]` (one `{started_at, ended_at, level}` per 15-min window; `level` is null during no-data windows). The 1.3 MB is mostly inline education + the `vow` narrative; the actual stress data is <100 KB.

---

## Captured request body samples (write endpoints)

The canonical write bodies are documented inline in the [per-service reference](#per-service-endpoint-reference) (HR zones, smart alarm, MCI survey, cycle / symptom log, custom exercise, workout log, profile PUT). The essentials, restated:

- **Activity create** (`POST /core-details-bff/v0/create-activity`): `{sport_id, gps_enabled, start_time, end_time}` with ISO timestamps → receipt `{id, cycle_id, during, timezone, source}`. (The v2 `activity_internal_name` variant 400s on non-ISO dates.)
- **Journal save** (`PUT /journal-service/v2/journals/entries/user/date/{date}`): `{notes, tracker_inputs:[…]}` where each input is bare `{behavior_tracker_id}`, boolean `{…, answered_yes}`, or magnitude `{…, magnitude_input_value, magnitude_input_label}`. → 204.
- **Strength workout log** (`POST /weightlifting-service/v2/weightlifting-workout/activity`): `{during, workout_groups:[{workout_exercises:[{sets:[{during, weight, number_of_reps, strap_location, strap_location_laterality, weightlifting_workout_set_id, [time_in_seconds]}], exercise_details:{…full denormalized exercise}}]}]}`. **`exercise_details.created_at`/`updated_at` must be non-empty** or it silently 422s. → receipt with `total_effective_volume_kg`, `scaled_msk_strain_score`, etc.
- **MCI survey** (`PUT /health-service/v1/hormonal-insights/settings/mci/survey`): `{contraception_type, interest, last_period_date_range:[[Y,M,D],…], symptoms:["177",…] (stringified behavior IDs), typical_cycle_length}`.
- **Cycle log** (`PUT /…/menstrual-cycle-insights/log`): `{period_logs:[{date:[Y,M,D], period:{answered_yes, magnitude_input_value}, ovulation:{…}}]}` — date as a 3-int array.
- **Profile PUT** (`PUT /profile-service/v1/profile`): a near-complete body is required (too partial → 422); birthday `YYYY-MM-DD` (ISO datetime → 400); enums UPPERCASE; weight in **kg**, height in **m** regardless of `unit_system`.
- **Behaviors reorder** (`PUT /activities-service/v1/journals/behaviors/user`): a bare JSON array of ~308 behavior IDs in display order.

`during` fields are PostgreSQL range literals: `"['<start_iso>','<end_iso>')"` (half-open). Set timestamps in `whoop_lift_log` default to a 100 ms placeholder range per set; Whoop accepts it.

---

## Discovery scripts

The reverse-engineering pipeline (archived separately, **not shipped** — the raw `.mitm` captures contain personal tokens):

1. `mitmproxy --listen-port 8080 --set save_stream_file=flows.mitm`; iPhone Wi-Fi proxy → the Mac; mitmproxy's CA trusted on the phone. (Whoop's iOS app does **not** pin certs — the single reason any of this works.)
2. `dump_combined.py` walks all three captures and dedups by `(method, templated_path, body_signature, status)`, skipping pure-telemetry services. The two load-bearing pieces:

```python
def templatize(p):
    p = re.sub(r"/conversation/[^/?]+", "/conversation/{conversation_id}", p)
    p = re.sub(r"/exercise/[A-Z][A-Z0-9]*_[A-Z0-9_]+", "/exercise/{exercise_id}", p)
    p = re.sub(r"/trends/[A-Z][A-Z0-9_]+", "/trends/{metric}", p)
    p = re.sub(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", "{uuid}", p, flags=re.I)
    p = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "{date}", p)
    p = re.sub(r"/\d{6,}", "/{id}", p)
    # ...plus offset / limit / level / id query params -> placeholders
    return p

def body_signature(body):   # the dedup key's body component
    # JSON dict -> sorted top-level keys; list -> "array[N]"; binary -> "binary"; empty -> "empty"
    ...
```

   Bodies are redacted (`PASSWORD`, `AccessToken`, `RefreshToken`, `IdToken`, `Session`, `SMS_MFA_CODE` → `<REDACTED>`) before the text dump is written. A `heartbeat.py` polled the live flows file every 5 s and warned on >60 s capture gaps (after a silent Wi-Fi drop quietly killed Phase 8a).
3. The deduped `all.txt` was split into 12 chunks; a single Opus pass over it produced the per-service brief that became this document.

**Don't share the `.mitm` file** — the binary flows are unredacted (access tokens, refresh tokens, SMS codes).

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

## Sports / activity-types catalog

Two related lists: the v2 `/activities-service/v2/activity-types` catalog (**197** records, keyed by `internal_name`) and the v1 `/activities-service/v1/sports/history?countryCode=US` list (**203** entries, keyed by numeric `sport_id`). The MCP bundles the v1 numeric mapping in [`src/data/sports.ts`](src/data/sports.ts), searchable via `whoop_sports_catalog`; `whoop_activity_create` takes a numeric `sport_id`. The `sport_id` ↔ `internal_name` mapping is held client-side by the iOS app and not exposed via the API.

v2 catalog breakdown — category: cardiovascular (109), restorative (33), muscular (32), non-cardiovascular (21), sleep (2). `score_type`: CARDIO (162), RECOVERY (33), SLEEP (2). GPS-enabled: 72/197. MSK-linkable (can tie to a Strength Trainer session): 9/197.

Verified numeric `sport_id` → name (full list in `src/data/sports.ts`): `-1` Activity (generic) · `0` Running · `1` Cycling · `17` Basketball · `33` Swimming · `45` Weightlifting · `48` Functional Fitness · `52` Hiking · `63` Walking · `123` Strength Trainer.

---

## Feature-education + overlay flags

`GET /onboarding-service/v1/feature-education-state?userId={id}` (15 KB) and `/onboarding-service/v1/overlay/all` (15 KB) return objects whose **top-level keys are feature / overlay names** — each value encodes whether the user has dismissed that teach-me modal. ~159 education flags + ~141 content articles + 22 overlays were observed. Representative keys: `PAIRING_MODE_EDUCATION`, `METABOLIC_HEALTH`, `ADVANCED_LABS_LH_CYCLE_RANGES`, `DATA_STREAK_MILESTONE_UNLOCK_EDUCATION`, `OVERLAY_HEALTH_TAB`, `OVERLAY_HOME_DEEP_DIVES_STRAIN`, `OVERLAY_STRENGTH_BUILDER_WORKOUT_BUILDER`. Marked complete via `PUT /onboarding-service/v1/feature-education-state` `{feature_education_id, completed:true}`. None are wrapped — pure onboarding state.

---

## Journal behavior catalog

All **308** active behaviors are bundled in [`src/data/behaviors.ts`](src/data/behaviors.ts) and searchable via `whoop_journal_catalog` (filter by category / magnitude type / name). Each entry: `{behavior_tracker_id, title, question, internal_name, category, magnitude}`. Integer IDs span 1–398 (gaps where Whoop deleted experimental behaviors).

By category: Drugs & Medication (24), Health & Symptoms (44), Hormonal Health (43), Lifestyle (33), Mental Wellbeing (28), Nutrition (41), Recovery (35), Sleep & Circadian Health (33), Supplements (27).

`magnitude` is one of `bare` (just "did it"), `boolean` (yes/no), or `magnitude` (numeric value + label). Sample: `1` → alcohol (boolean), `80` → hydration ("22 oz", magnitude), `145` → calories ("1800 cal", magnitude). Full list: the `BEHAVIORS` array in `src/data/behaviors.ts`.

---

## Strength Trainer exercise catalog

All **372** official exercises are bundled in [`src/data/exercises.ts`](src/data/exercises.ts) and searchable via `whoop_lift_catalog` (filter by muscle / equipment / movement_pattern / laterality / name). Each entry: `{exercise_id, name, muscle_groups, primary_muscle, equipment, movement_pattern, laterality}`.

By primary muscle group: ARMS (27), BACK (36), CHEST (23), CORE (50), FULL_BODY (35), LEGS (157), OTHER (3), SHOULDERS (41).

Sample: `BENCHPRESS_BARBELL` → Bench Press - Barbell (CHEST · BARBELL · HORIZONTAL_PRESS), `DEADLIFT_BARBELL` → Deadlift - Barbell, `LATPULLDOWNFRONT_PULLEYMACHINE` → Lat Pulldown. IDs are upper-snake-case with original punctuation preserved (`ASSISTED_PULL_UPS_(BAND)`, `BAR-FACING_BURPEES_(LATERAL)`). Full list: the `EXERCISES` array in `src/data/exercises.ts`.

---

## Endpoint catalog

All **311** templated paths are bundled in [`src/data/endpoints.ts`](src/data/endpoints.ts) and searchable live via the `whoop_endpoints` MCP tool (optional `filter` substring + `method`). Per-service operation counts are in [Appendix A](#appendix-a-operation-count-by-service). Format: `METHOD STATUS /templated/path`. Representative sample:

```
GET 200 /home-service/v1/home?date={date}
GET 200 /home-service/v1/deep-dive/recovery?date={date}
GET 200 /home-service/v1/deep-dive/sleep/last-night?date={date}
POST 200 /core-details-bff/v0/create-activity
GET 200 /weightlifting-service/v3/prs
POST 200 /weightlifting-service/v2/weightlifting-workout/activity
GET 200 /journal-service/v3/journals/drafts/mobile/{date}
PUT 204 /journal-service/v2/journals/entries/user/date/{date}
GET 200 /progression-service/v3/trends/{metric}?endDate={date}
DELETE 204 /core-details-bff/v1/cardio-details?activityId={uuid}
PUT 204 /womens-health-service/v1/menstrual-cycle-insights/log
```

The full per-service catalog is the `ENDPOINTS` array in `src/data/endpoints.ts`.

---

*End of deep endpoint research.*
