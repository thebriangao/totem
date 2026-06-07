# Changelog

All notable changes to this project. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

## [1.4.2] — 2026-06-07

### Added

- **`totem update` is now an interactive updater.** Running it opens a version picker — every release, newest first, with dates + notes from GitHub Releases. The newest is the default; choosing an older one warns you what you'd be behind on (and you can re-run to go forward — being on the latest doesn't lock you out of pinning an older version). After you choose, it applies the change with a guided, animated build (git installs fast-forward `main` or check out the pinned tag, reinstall deps, rebuild; npm installs reinstall the chosen version), then redeploys to your existing host and health-checks `/health`. Requires a clean working tree (won't clobber local edits); a failed deploy leaves the live server untouched.
- **Opt-in auto-update.** After updating to the latest, `totem update` offers to turn on auto-update — or toggle it directly with **`totem update --auto on`** / **`--auto off`**. When on, a background job (launchd on macOS, cron on Linux) checks for new releases every 6 hours and applies them the same way (pull → build → redeploy → health-check), logging to `.totem-autoupdate.log`. It's a scheduled poll (there's no push channel to a user's machine) and only ever moves you to **released**, CI-gated versions — never bleeding-edge `main`. `--auto on` also pulls the newest immediately.
- Versions come from where they already live — git tags + GitHub Releases (git installs) and the npm registry (global installs) — so there's no separate version index to host. `totem update --check` remains a non-interactive installed-vs-latest preview and now also reports the auto-update state.

## [1.4.1] — 2026-06-07

### Fixed

- **`whoop_journal` always returned `behaviors: []`** even when journal entries were logged and confirmed in the app ([#2](https://github.com/briangaoo/totem/issues/2), reported by @theanswertw). The v3 drafts endpoint nests each logged behavior as `{ behavior_tracker: {id, …}, tracker_input: {behavior_tracker_id, answered_yes, magnitude_input_*, …} }`, but the projection read `behavior_tracker_id` off the top level of each entry — always `undefined`, so every behavior was filtered out (while `cycle_id`, read from a different field, still came through). The projection now reads the nested `tracker_input`/`behavior_tracker` shape and falls back to the flat shape. Root-caused with a live write→read→restore probe against a real account; added a populated-draft fixture + regression tests so the empty-only fixture can't hide it again. Test suite 212 → 219.

## [1.4.0] — 2026-06-05

### Changed

- **Renamed the project to Totem.** `whoop-mcp` → `totem` across the package name (`@briangaoo/totem`), the CLI binary (`totem <command>`), the MCP registry id (`io.github.briangaoo/totem`), the server identity, the banner, and the docs. **Whoop itself is untouched** — every `whoop_*` tool, the `WHOOP_*` env vars, the private-iOS-API adapter, and `WHOOP.md` are byte-for-byte the same. Totem is becoming a device-agnostic wearables→AI bridge (the MCP + projection layer doesn't care what you wear); Whoop is the first and currently only shipping adapter, with **Fitbit, Apple Watch, and Garmin in progress**.
  - *Migration:* the npm package is republished under `@briangaoo/totem` and the old `@briangaoo/whoop-mcp` is deprecated with a pointer. Existing installs keep working; to move over, reinstall and use `totem` instead of `whoop-mcp`. A cloud deployment's saved record was `.whoop-mcp-deploy.json` and is now `.totem-deploy.json` — rename it (or just re-run `totem cloud`) so `totem deploy`/`logs`/`update` find it.

### Added

- **`totem update`** — a one-liner that pulls the latest release from GitHub and redeploys in place. Compares your `HEAD` against `origin/main`, fast-forwards (or reinstalls the global package), rebuilds, redeploys to your existing host, and pings `/health` to confirm. `totem update --check` does a no-write dry run that just reports installed-vs-latest. Opt-in, never automatic.
- **CI verify gate.** A GitHub Actions workflow (`.github/workflows/ci.yml`) runs `tsc --noEmit`, the full vitest suite, and a build on every push to `main` and every PR — so nothing reaches the default branch (or a merged contribution) without passing the same checks run locally.

## [1.3.0] — 2026-06-01

### Added

- **Direct setup for the major AI clients, in both flows.** `totem local` now wires the server into your pick of **Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Gemini CLI, Codex CLI, or Windsurf** — writing the right config to the right path automatically (or printing a universal block for any other MCP client). `totem cloud`'s connect step prints ready-to-paste instructions for **claude.ai, ChatGPT, Claude Code (remote), and Cursor/Windsurf/any HTTP MCP client** — URL + password for the OAuth clients, a bearer-token config block for the header-auth ones. Every stdio client uses the identical launch entry, so the server still self-loads its `.env` no matter which app starts it.

## [1.2.4] — 2026-06-01

Bug-fix release for a remote-connector regression introduced in 1.2.3. stdio / Claude Code connections were unaffected.

### Fixed

- **The claude.ai web/desktop/mobile connector couldn't connect on 1.2.3.** The 1.2.3 security pass set a `Content-Security-Policy` on *every* HTTP response. On the JSON OAuth-metadata responses Claude read that as a "server configuration issue"; on the consent (password) page the `form-action 'self'` directive blocked the OAuth redirect back to Claude, so submitting the password silently did nothing. The CSP is removed from the API/metadata responses entirely, and from the consent page — which keeps `X-Frame-Options: DENY` (the clickjacking control that page actually needs).
- **Audience binding (RFC 8707) is now log-only, not enforced.** A strict `resource`-claim check risked 401-ing a valid token and bricking the connector, so it logs a mismatch instead of rejecting. It'll return as strict once verified against a live token.
- **Reverted `redirect: "error"` on the Whoop API client** back to the default (follow), so a redirecting endpoint can't make a data tool throw.
- The consent endpoint now logs *which* check failed (password vs. client decode vs. redirect) instead of always saying "incorrect password" — so a future failure is diagnosable.

## [1.2.3] — 2026-05-31

A security-hardening release — no API or tool changes, all behavior-compatible. Came out of a full codebase security audit.

### Security

- **Token files are now written `0600`** (owner-only) instead of inheriting a `0644` umask — `.env` and the token store, with a `chmod` repair so files from older versions get tightened on the next write.
- **Your Whoop password is removed from `.env` after a successful login.** It was only ever needed for the one bootstrap call; every refresh uses the token. Re-running `auth` re-prompts for it (masked).
- **OAuth JWTs are signed with a key derived from `MCP_AUTH_TOKEN`** (HMAC), not the token itself — the static bearer and the signing secret are no longer the same value in two roles.
- **Access tokens are audience-bound** (RFC 8707): a token's `resource` claim must match this server's `/mcp` URL, so a token can't be replayed against another deployment that shares the secret.
- **Security headers** on every HTTP response (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, strict CSP) — the connector password page can no longer be framed (clickjacking).
- **The connector-password gate is harder to brute-force**: a global attempt ceiling independent of the spoofable per-IP key, plus a 16-char + character-class floor for user-chosen passwords (the auto-generated one was always strong).
- **Fly secrets are pushed over stdin** (`secrets import`), not argv — token/password values are no longer visible in `ps`/`/proc` during deploy or token rotation.
- **`totem cloud` now verifies the auth gate after deploy** — it asserts an unauthenticated `/mcp` returns 401 before declaring success.
- **`.gitignore` now excludes every `.env*` variant** (incl. backups) so a stray `.env.bak` can't be committed; `.dockerignore` excludes `.env*` + the deploy record so they're never uploaded to a build context.
- Outbound requests use `redirect: "error"`, and API error messages no longer echo response-body fragments — defense-in-depth against token/data leakage.

### Changed

- **Reduced request burstiness** for stealth: the wide read fan-outs (`whoop_compare`, `whoop_lift_history`) are now paced (≤3 concurrent, small jitter) instead of firing all at once, and `whoop_coach_ask` polls on a jittered interval instead of a fixed 1.000 s metronome.
- On read-only hosts the install identifier is derived deterministically from the account email (stable across restarts) instead of a fresh random one per process. A boot warning fires if the bundled iOS app version has gone stale.

## [1.2.2] — 2026-05-31

### Changed

- **The Whoop password is now hidden as you type** during `totem auth` / `cloud` / `local`. It previously echoed in plaintext — fine in private, but exposed on a screen-share or recording. Implemented with an explicit raw-mode reader (terminal echo off, characters captured but never rendered), masked in both the guided-flow prompt and the standalone `auth` script. Everything else stays visible (email, MFA code, the auto-generated connector password).
- **New demo.** Replaced the static screenshot with a ~2-minute screen recording of the full `totem cloud` flow (`assets/demo.mp4`): install → Whoop login → Fly deploy → Claude connector → first query. The README loads it from GitHub, so it isn't bundled into the npm package.

## [1.2.1] — 2026-05-31

A correctness + stealth pass. Every read and write tool was exercised individually against a live account (each call's raw API exchange compared with the projected output and the state read back), which surfaced a class of "returns HTTP 200 but the payload is empty or wrong" bugs that receipt-only testing missed.

### Added

- **iOS-app identity headers on every data request.** The data client now sends the WHOOP iOS app's own header set — `user-agent: iOS`, `x-whoop-device-platform`/`-ios-version`/`-ios-build-number`/`-bundle-name`/`-installation-identifier`/`-time-zone`/`-clock-format`, `currency`/`locale`/`accept-language`/`priority`, and the capitalized `Bearer` scheme — captured from a live mitmproxy session (`src/whoop/device.ts`). Previously requests were a bare bearer token, which is trivially distinguishable from the app. The static values are the app's shared constants (camouflage, not a per-user signature); the installation identifier is a per-install random UUID persisted to `.env` (`src/whoop/installation.ts`, new `WHOOP_INSTALLATION_ID`); timezone is host-derived. We deliberately send nothing the app doesn't (no Sentry/`baggage`/`sentry-trace`, no marketing cookies), since a unique invented header in open-source code would be the exact one-line WAF rule to avoid. Transport-layer fingerprint (TLS/HTTP-2) is left unchanged — out of scope, and a Node TLS signature can't be hidden anyway. Full reasoning in `WHOOP.md` → "Headers for data requests".
- **`whoop_behavior_impact` is now self-discovering.** Called with no `behavior_id` it returns the list of every behavior with its `impact_uuid` + headline effect (from `GET /behavior-impact-service/v1/impact`); called with a UUID it returns the detail. Previously the tool only had the detail mode and required an impact UUID that **no other tool exposed** — so it was effectively un-callable by an AI (the catalog gate it carried pointed at the numeric `behavior_tracker_id`, the wrong id). The wrong gate was removed.

### Fixed

These all returned `200` with an empty or wrong projection before — the kind of bug that passes a green test suite and a status-code check:

- **`whoop_stress` returned an empty timeline.** The projection read `stress_state.timeline`, but `stress_state` is a string (`"RELAXED"`); the real data is in `gauge` (current level) + `stress_graph.graph` (the intraday points). Rewritten; the ~700-point graph is downsampled to ≤48 timeline points with reconstructed timestamps.
- **`whoop_trend` returned `value: null` (and blank dates) for every time/duration metric** (TIME_IN_BED, SLEEP_DEBT_POST, RESTORATIVE_SLEEP, the three STRESS metrics, HR_ZONES_1_3/4_5, STRENGTH_ACTIVITY_TIME). Those metrics render as bar plots — the value + date live in `bar_groups[].bars[].data_scrubber_details`, not the group-level label the projection read — and `labelToNumber` rejected the `"11:14"` duration form. Now reads the per-bar details and falls back to `timeLabelToMs`.
- **`whoop_cycle` returned all-null despite a populated response.** The projection searched for tile types (`CYCLE_PHASE_TILE`, `HORMONAL_MODE_TILE`) that don't exist in the `menstrual-cycle-insights` BFF. Rewritten to read the real tiles — `HEADER_TILE` (phase + "Cycle Day N"), `TYPICAL_CYCLE_TILE` (cycle length), `CALENDAR_TILE` (period/ovulation predictions from first-day-of-phase markers). Also: this endpoint must be called **with** the `date` query param (it 404s without it) — which is why it was previously misdiagnosed as "women's-health not enabled".
- **`whoop_workout` `hr_curve` was always empty.** The points carry no timestamp field — the bpm is in `value_display`, the time is `position_x` (fraction of the workout window). The old code looked for a `timestamp`/`dsd.timestamp` that never existed and dropped every point. Now rebuilt from `start + position_x·duration`, downsampled to ≤120 points.
- **`whoop_lift_progression` mislabeled its segments** (`week`/`month`) for exercises that only have `month`/`six_month` data, because it labeled by array position. Now labels from `segment_controller.element_names`. Same bar-plot parsing fix as `whoop_trend`.
- **`whoop_recovery` returned null SpO2 / skin temperature.** Those aren't in the deep-dive tiles; the tool now also fetches `/developer/v2/recovery` and reads `score.spo2_percentage` / `score.skin_temp_celsius`.
- **`whoop_coach_ask` returned a truncated reply.** The Whoop Coach response streams token-by-token, and the poll loop broke on the first non-empty chunk — so it returned a fragment like `"56"` instead of the finished answer. Now keeps the latest text and stops only when the turn is `COMPLETE` (or the text settles).
- **`whoop_symptom_log` crashed on menstruation-only / cervical-mucus-only calls** (`Cannot read properties of undefined (reading 'length')` when `symptoms` was omitted). Guarded with a default — the zod default already covered the live MCP path, but the handler is now robust on any path.

### Changed

- **`whoop_journal_log` description now warns it REPLACES the day's entry** and instructs reading `whoop_journal` first to avoid silently wiping behaviors already logged that day.
- **`whoop_smart_alarm_set` description routes wake-time changes to `mode=schedule`.** `mode=preferences` returns 200 but its `lower/upper_time_bound` don't persist when an explicit schedule exists (server-ignored, verified live); the schedule mode is what actually controls the wake time.
- Description clarifications for `whoop_cycle` (needs women's-health enabled; some fields always null) and `whoop_workout` (a just-logged activity is `pending` and errors on detail reads until scored).
- **Tool descriptions rewritten across the surface** — terser and deliberately example-free for id-taking tools (listing sample ids led the model to guess ones outside the list; now it must read the catalog), with the catalog read enforced by a hard gate that errors until the matching catalog tool (`whoop_sports_catalog` / `whoop_lift_catalog` / `whoop_journal_catalog`) has been called that session (`whoop_activity_create`, the three lift writes, `whoop_journal_log`, `whoop_symptom_log`).
- Test suite 178 → **212** — added `tests/projections/round3_data_fixes.test.ts` (regressions for every projection bug above; each assert fails against the pre-fix code) plus new committed fixtures (`cycle_insights.json`, `behavior_impact_list.json`, `recovery_v2.json`, `trend_time_in_bed.json`).

## [1.2.0] — 2026-05-29

### Security

- **OAuth consent gate hardened.** The connector password minimum is now 12 chars (was 4), and `POST /oauth/consent` — a custom route not covered by the SDK's OAuth rate-limiter — now enforces a per-IP fixed-window limit (10 attempts / 15 min → `429`), blunting brute force against the gate to your health data.
- **Scrubbed every real identifier from the bundled endpoint catalog.** `src/data/endpoints.ts` shipped concrete identifiers captured during reverse-engineering — community + user IDs, a personal email, a device serial + signature, HealthKit pairing tokens, and capture timestamps. All are now templated (`{id}`, `{userId}`, `{email}`, `{strapSerial}`, `{strapSignature}`, `{token}`, `{code}`, `{timestamp}`) and the list deduped (384 → 311 entries). The generator's contract (header comment) is now actually enforced.

### Fixed

- **`whoop_journal` (+ other timestamp fields) threw on Whoop's no-colon offset form.** Output schemas used `z.iso.datetime({ offset: true })`, which rejects the `+0000` / `-0700` form Whoop's journal/pg-range endpoints emit — and validation runs *before* `localizeTimestamps` normalizes it, so a populated `recorded_at` raised `WhoopProjectionError`. Replaced with a shared `IsoDateTime` schema (in `schemas/primitives.ts`) accepting `Z`, `±HH:MM`, and `±HHMM`; added a regression test.
- **HTTP server crashed on boot when `PUBLIC_URL` was empty.** `process.env.PUBLIC_URL ?? localhost` let an empty string reach `new URL("")` (a `TypeError`), crash-looping the first deploy on hosts that inject `PUBLIC_URL=""` (the Railway / Cloud Run first pass). Now treated as unset (`||`).
- **`whoop_lift_log` mislabeled the logged workout's timezone on cloud hosts** (used the system zone — UTC on Fly/Docker). Now prefers an IANA `WHOOP_TIMEZONE`, falling back to the system zone for local use.
- **`whoop_workouts` `limit` now caps at 25** to match the upstream API page size (the schema advertised up to 50 but the fetch silently returned ≤25).
- CLI banner tool count corrected (47 → 48); removed dead code in the recovery/trend projections; clarified the `session_state` gate comment (per-process, not per-session).

### Added

- **Two guided "one-command" setup flows** — the new recommended way to get going:
  - **`totem cloud`** ★ — walks you through the entire server-hosted path in one command: Whoop auth (SMS handled) → pick a host → generate `MCP_AUTH_TOKEN` + connector password → set env → deploy → verify `/health` + OAuth metadata are live → open claude.ai's connector page and print the URL + password to paste. By the end, Claude is connected across web, desktop, and mobile. Platforms: **Fly**, **Railway**, and **Cloud Run** — all fully CLI-automated and tested end-to-end (installs the host CLI if missing, logs you in, deploys, auto-detects the URL, sets `PUBLIC_URL`, verifies `/health` + OAuth) — plus **Custom** (printed Docker + env steps for any other host or your own server). OAuth is the default. (Koyeb was dropped before release — its signup now forces a paid $30/mo plan, so it no longer fits a zero-cost path; the Custom/Docker route covers it.)
  - **`totem local`** — guided stdio setup: auth → build → writes the Claude Desktop config (or prints the Claude Code one-liner).
  - New CLI modules `src/cli/ui.ts` (shared prompts/colors/runners) + `src/cli/setup.ts` (the flows). `cloud` writes a `.totem-deploy.json` record so `auth` knows where to push.
  - **Warm by default — no cold starts.** Fly deployments now set `min_machines_running = 1` + `auto_stop_machines = "suspend"`, and Cloud Run gets `--min-instances 1`, so the connector never cold-starts — without this, the first request after an idle auto-stop fails while the VM/container boots (~10s). Railway already runs continuously; the printed Custom `docker run` uses `--restart unless-stopped`.
  - **Interactive UX hardening (both flows).** Animated spinners on every otherwise-silent step (network lookups, health polling, backoff waits — driven by an async `captureAsync` so they actually animate, since `spawnSync` blocks the loop). **Explicit confirmations** before anything sensitive — IAM grants, API enablement, billable deploys, project creation, dependency installs, account switches — each printing the exact command + consequence. **Arrow-key (↑/↓, j/k, number) selection** replacing every numbered prompt, hardened against concatenated/split key delivery and EOF (no more hangs on Ctrl-D). **Account + GCP-project pickers** are now always offered (use current, switch account, or create a project) instead of silently inheriting whatever's active. Plus: auto-generated 18-char connector password copied to the clipboard, and the deployed URL auto-detected (no paste step). Every one of the five paths (Fly/Railway/Cloud Run/Custom + local) was deployed and verified end-to-end through the real CLI.
- **Banner on every command.** The figlet "WHOOP MCP" banner now prints at the top of *every* `totem` invocation (was: only the no-arg help). It's written to **stderr**, so it shows in the terminal without ever polluting stdout — `start`/`dev` keep a clean MCP protocol stream and `version`/`config` stay machine-parseable + pipe-safe.
- **One `auth` command for all token management** (replaces `bootstrap` + `rebootstrap`). `totem auth` logs you into Whoop, saves the tokens to `.env`, and **auto-detects** two things: *new vs re-auth* (whether you already have tokens — messaging only) and *local vs deployed* (reads `.totem-deploy.json`). For a deployment it pushes the new tokens to **wherever you actually deployed** — Fly (`fly secrets set`), Railway (`railway variables`), Cloud Run (`gcloud run services update`), printed values for a Custom host — or notes "restart your client" for a local install. Auto/silent when the account has no SMS MFA; prompts for the code when it does. The separate `refresh` command was removed; the guided `cloud`/`local` flows call `auth` internally in tokens-only mode so they don't double-push. Help is grouped with the two guided commands as the headline; everything else (logs, ping, deploy, start, etc.) stays available as advanced commands.
- **Sleep hypnogram + in-sleep heart rate.** `whoop_sleep` now returns the full **hypnogram** — the per-stage timeline (REM/light/SWS/wake), ~58 segments a night — reconstructed from the deep-dive's per-stage HR-curve points, plus **`sleep_hr`** (avg/min bpm). Both were schema'd but previously returned empty/null. Transition times come from each point's clock label anchored to the sleep window at its midpoint (the graph's `position_x` carries ~40 min of axis padding), emitted in UTC for `localizeTimestamps`. Sleep HRV / respiratory rate / debt / latency stay null — not exposed by the endpoint.

### Added

- **OAuth 2.1 authorization server (for claude.ai web + Claude mobile connectors).** Claude's custom-connector UI on web/mobile only supports OAuth — there's no bearer-token field — so the bearer setup only worked with Claude Code and the Claude Desktop `mcp-remote` bridge. The HTTP server now embeds a full OAuth 2.1 + PKCE authorization server (via the MCP SDK's `mcpAuthRouter` + a custom `OAuthServerProvider`), so the deployed server can be added as a custom connector and synced across every device on your Claude account.
  - **Password gate**: the `/authorize` step serves a small password page; the user enters `AUTH_PASSWORD` once when adding the connector. A stranger who finds the URL still can't connect.
  - **Stateless by design** (survives Fly's auto-stop restarts): access + refresh tokens are HS256 JWTs signed with `MCP_AUTH_TOKEN`; registered clients (dynamic client registration) encode their redirect URIs into a signed `client_id`, so Claude never has to re-register after a cold start. Only the 60-second authorization codes are in-memory.
  - **Backward compatible**: `/mcp` still accepts the static `MCP_AUTH_TOKEN` bearer (Claude Code + Desktop bridge unchanged). `verifyAccessToken` accepts either.
  - New env vars: `AUTH_PASSWORD` (enables the OAuth path) and `PUBLIC_URL` (the OAuth issuer origin). Leave `AUTH_PASSWORD` unset to disable.
  - The HTTP server migrated from raw `node:http` to **Express** (required by the SDK's OAuth router). The per-session McpServer routing is unchanged. 9 new OAuth provider tests + the 9 existing HTTP-auth tests pass (the auth gate now returns spec-correct status codes via the SDK's `requireBearerAuth`).

### Fixed

- **Timezone, both directions.** Two bugs were causing the AI to see wrong clock values:
  - *Output:* `localizeTimestamps` only matched `Z`-suffixed timestamps, but Whoop's journal + pg-range endpoints emit the `+0000` form (e.g. `2026-05-23T07:35:46.220+0000`). Those passed through as UTC. The matcher now catches `Z`, `+0000`, and `+00:00`, all of which mean UTC, and rewrites them to the user's local offset.
  - *Input:* `todayIso()` (the default for ~12 tools' `date` param) computed "today" from the server's calendar day. On a UTC host like Fly, that's a day ahead of the user during their evening, so "how am I doing today" could query tomorrow. It now resolves the calendar day in the configured `WHOOP_TIMEZONE` / auto-detected profile TZ via a new `zonedParts()` helper. `performance_assessment` had the same class of bug (`getTimezoneOffset()` returns 0 on UTC hosts) — fixed to use the configured TZ. 10 new timezone tests (164 total).
- **`whoop_lift_history` description was misleading.** It claimed "set-level detail" but its `sets[]` array is always empty — the `/cardio-details` endpoint only exposes per-exercise aggregates. So when asked for individual sets, the AI called `lift_history` and got nothing useful. The description now states it returns per-exercise aggregates and routes per-set questions to `whoop_lift_exercise`, which already returns every set (reps/weight/medal per set) correctly.

### Added

- **`whoop_communities`** (new tool, brings total to 48). Lists the communities you're a member of (teams, friend groups) with member counts and — optionally — your rank in each across a chosen metric (strain/sleep/recovery) over a window (day/week/month). Complements `whoop_leaderboard`: use `whoop_communities` to discover community IDs, then drill into one with `whoop_leaderboard`. Source: `GET /community-service/v1/communities/memberships` (already in use by `whoop_leaderboard` for community auto-discovery). Schema is permissive at the record level since the per-record field set hasn't been captured against a live account at the time of release — a `WhoopProjectionError` from this tool is the signal that Whoop's actual shape differs from the inferred one and the projection needs tightening.
- **Strain target** added to `whoop_strain` output. The existing deep-dive response carries `score_target`, `lower_optimal_percentage`, and `higher_optimal_percentage` as 0–1 fractions of max strain (21); the projection multiplies by 21 to expose them as strain values. New schema field: `target: {value, optimal_lower, optimal_upper}`. Lets the AI answer "should I work out today?" with a concrete number ("you're at 18.9, target was 13.2 — already past optimal") instead of just a state label.

### Added (earlier in this cycle)

- **README banner.** New SVG banner at the top of the README (`assets/banner.svg`) — figlet-style "WHOOP MCP" block text in light gray with a 5-beat EKG pulse waveform underneath (real `<path>` element, not ASCII), centered horizontally, theme-aware via `prefers-color-scheme` (auto-flips to light text on dark mode). Added `assets/` to `package.json` `files` whitelist so it ships with the published package.

### Fixed

- **Timestamps returned in user's local timezone.** Whoop's API returns every timestamp in UTC (`2026-05-25T22:30:00Z`), which confused the AI on the consumer side — `22:30:00` got interpreted as a clock time when it's really 3:30 PM in San Jose. The MCP now rewrites every UTC timestamp in tool responses with an explicit local offset (`2026-05-25T15:30:00-07:00`) — same instant, but the AI sees the actual local clock value. Implementation: single helper in `src/lib/timezone.ts`, applied in `jsonOut()` so every tool gets the conversion for free.

  Three-tier resolution chain so OSS users on any host get sensible timestamps without manual config:
  1. **`WHOOP_TIMEZONE` env var** (IANA name like `America/Los_Angeles`) — explicit override.
  2. **Auto-detected from Whoop profile.** On server boot, the MCP fetches `/users-service/v2/bootstrap` and caches the user's `timezone_offset` (e.g., `-0700`). Refreshes hourly so travelers get auto-updates without restarting. Fire-and-forget — server startup doesn't block on the fetch.
  3. **System TZ** — last resort. UTC on Fly/Railway/Docker, so Tier 2 saves you here.

  Tier 2 means `WHOOP_TIMEZONE` is now **optional** for nearly all users — local installs use system TZ, deployed installs use the Whoop-profile fallback automatically. `toLocalIso()` handles both IANA names (`America/Los_Angeles`) and fixed offsets (`-0700`, `-07:00`) since Whoop's API returns the offset form. 25 unit tests covering DST transitions, positive/negative/half-hour offsets, date rollover, millisecond precision, the priority chain, and pass-through for date-only / non-ISO strings.
- **Claude Desktop config for remote MCP.** Docs (README → Remote hosting) and the `totem config http` CLI command previously emitted the `{"url": "...", "headers": {...}}` format for Claude Desktop, which Claude Desktop rejects with *"The following entries in claude_desktop_config.json are not valid MCP server configurations and were skipped"*. That format only works for **Claude Code** (which natively supports remote MCP). Claude Desktop only speaks stdio, so the docs + CLI now emit a stdio bridge config using [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) — a small Node package that proxies HTTP MCP servers as stdio. First run downloads via `npx` (~5s), subsequent runs are cached.

### Added

- **`totem` CLI.** New first-class command (single binary, installable via `npm link` or, once published, `npm install -g totem`) that wraps every npm script plus operational helpers. Works from any directory — the CLI resolves its own install root from `import.meta.url`, so `totem deploy` from `~/Desktop` does the same thing as `cd totem && fly deploy`.
- Subcommands across 5 groups:
  - **Local**: `start [--http]`, `dev`, `dev:http`, `build`, `test`, `typecheck`
  - **Setup**: `auth` (login + token refresh; pushes to your deployment)
  - **Deployed**: `deploy`, `logs`, `status`, `ping`
  - **Inspect**: `info`, `tools`, `config <stdio|http>`
  - **Help**: `help`, `version` (+ `--help`, `-h`, `--version`, `-v` aliases)
- ANSI 24-bit truecolor banner with the Whoop pulse waveform (honors `NO_COLOR`, skipped on non-TTY stdout).
- `totem start` keeps stdout clean (no banner, no header) so it works as a drop-in for `node dist/server.js` in Claude Desktop stdio configs.
- `totem ping` and `totem status` hit the deployed `/health` endpoint live — instant "is my deploy alive" check.
- `totem config http` and `totem config stdio` print pre-filled Claude Desktop config snippets with absolute paths or your detected Fly URL.

### Changed

- `package.json` → `bin.totem` now points at `./dist/cli/index.js` (was `./dist/server.js`). The MCP server is still bootable via `totem start` — this is a CLI surface change, not a server change. Anyone with a Claude Desktop config invoking `totem` directly (none of the published quickstarts did this) should switch to `totem start` or stay on `node dist/server.js`.
- Token refresh is folded into `totem auth`: re-running it logs you back in and (for a deployment) pushes the new tokens to the host in one command — solving the ~30-day refresh-token expiry for remote deployments.
- Troubleshooting + README → Remote hosting now document the recovery flow: when Cognito tokens hit their 30-day wall, you run `totem auth`, type the SMS code (if your account has MFA), and the new tokens get pushed to your deployment automatically (~10s restart).

### Known limitation

- The `auth` re-auth flow still requires you to be at a machine with the repo + the platform CLI installed. If you're traveling when the token dies, you're locked out. A future feature would add a `/admin` web route accepting the SMS code from a browser, callable from a phone.

## [1.1.0] — 2026-05-26

### Added

- **Remote hosting via HTTP transport.** The MCP now supports two transport modes:
  - `MCP_TRANSPORT=stdio` (default) — current local Claude Desktop / Claude Code behavior
  - `MCP_TRANSPORT=http` — boots a Streamable HTTP server at `/mcp` behind a bearer-token gate, suitable for deployment to Fly.io, Railway, Render, a VPS, or any Docker host
  - Static bearer-token auth via `MCP_AUTH_TOKEN` env var (generate with `openssl rand -hex 32`). Constant-time compare to dodge timing attacks. Returns 401 on missing or wrong token without leaking which.
  - Health probe at `GET /health` (no auth).
  - CORS pre-configured for browser-based MCP clients.
- **`Dockerfile`** — multi-stage Alpine build, ~150 MB, runs as the non-root `node` user, ships a `HEALTHCHECK` directive. Deploy anywhere that runs containers.
- **`TokenStore` abstraction** (`src/whoop/token_store.ts`) — `EnvFileTokenStore` (default, writes refreshed tokens back to `.env`) and `MemoryTokenStore` (for read-only filesystems like Cloudflare Workers). Selectable via `WHOOP_TOKEN_STORE` env var. The Dockerfile uses `memory` by default; mount a writable volume + set `envfile` if you want persistence across restarts.
- **New npm scripts**: `dev:http` and `start:http` for running locally in HTTP mode.
- **9 HTTP-auth unit tests** in `tests/whoop/http_auth.test.ts` covering: 401 with no header / wrong token / wrong-length token (timing-safe path), 400 malformed body, 200 `/health` (no auth), 404 unknown path, 204 OPTIONS preflight with CORS headers, refuses to start with missing or too-short auth token.
- **New README section: "Remote hosting"** — full walkthrough including the Docker-based deploy path, instructions for Fly / Railway / Render / VPS / Cloudflare Tunnel, AI-client config snippets for both Claude Desktop and Claude Code with the bearer header, environment-variable reference, and a security model section.

### Changed

- `TokenManager` constructor now takes either `{ store: TokenStore }` or `{ envPath: string }` (the latter is shorthand for `new EnvFileTokenStore(envPath)`). Existing local stdio behavior is unchanged.
- Server version bumped to 1.1.0 in both `package.json` and the `McpServer` constructor.

### Migration

The default `MCP_TRANSPORT=stdio` means existing local installs are unaffected. To move to HTTP, follow the new [Remote hosting](README.md#remote-hosting) walkthrough.

## [1.0.0] — 2026-05-26

Initial public release.

### Added

- **47 MCP tools** wrapping Whoop's private iOS API:
  - 31 reads (today, day, profile, calendar, recovery, sleep, strain, trend, compare, stress, sleep_need, live_hr, live_state, live_stress, workouts, workout, sports_catalog, lift_prs, lift_exercise, lift_progression, lift_history, lift_library, lift_catalog, journal, journal_catalog, behavior_impact, cycle, performance_assessment, smart_alarm, leaderboard, hr_zones)
  - 14 writes (activity_create, activity_delete, lift_log, lift_template_save, lift_custom_exercise, journal_log, journal_autopop, cycle_log, symptom_log, smart_alarm_set, hr_zones_set, profile_update, hidden_metric, coach_ask)
  - 2 escape hatches (raw, endpoints)
- **4 bundled catalogs** generated from live API: 372 official Strength Trainer exercises, 308 journal behaviors, 203 sport_id mappings, 384 deduped iOS endpoint paths.
- **Session-scoped catalog gate** in `src/whoop/session_state.ts`. Tools that take exercise / behavior / sport IDs refuse to run until the corresponding lookup tool has been called once per session. Keeps ~14k tokens out of the system prompt.
- **Write-safety harness**: every write tool defaults `confirm: false`, returning a preview of what would be sent. AI must explicitly re-call with `confirm: true` to fire.
- **AWS Cognito auth** via Whoop's `/auth-service/v3/whoop/` proxy. No AWS SDK, no client secret extraction. Supports SMS MFA + TOTP. Auto-refresh on 401 with single-flight gate; persists refreshed tokens to `.env`.
- **Structured zod-validated outputs**. Every tool's response goes through a per-tool schema before returning to the client — catches Whoop API drift instead of silently returning malformed data.
- **TypeScript 6 strict** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. Node 24+.
- **116 unit tests** (vitest, fixture-driven projection tests).
- **MIT license** with Whoop trademark disclaimer.

### Documentation

- [`README.md`](README.md) — full developer-grade documentation: setup, every tool's signature + endpoints + caveats, architecture, schema design, write-safety details, token usage analysis, FAQ, troubleshooting.
- [`WHOOP.md`](WHOOP.md) — 5,900-line reverse-engineering writeup: methodology, every microservice, every endpoint, every body shape, every enum, every status code pattern, auth flows, capture sessions, the dedup pipeline.

### Known limitations

- **Reverse-engineered.** Whoop can change response shapes any time; when they do, projections may need updating. The zod schemas surface drift as `WhoopProjectionError` rather than silent corruption — see [Fixing a broken projection](README.md#fixing-a-broken-projection) for the recovery loop.
- **Avatar upload** is not wrapped (requires multipart upload with raw PNG bytes).
- **Webhooks** (Whoop's push-notification surface for sleep/workout/recovery events) are not exposed by the MCP. The OAuth API has 6 webhook events; we don't currently subscribe.
- **Per-set strength detail** (set 1: 10 reps @ 200lbs, set 2: ...) is not available in `/cardio-details`. `whoop_lift_history` returns per-exercise aggregates (set count, total reps, tonnage, medals). For per-set numbers across all your workouts of a specific exercise, use `whoop_lift_exercise`.
- **`whoop_cycle`** requires the user's MCI (menstrual cycle insights) survey to be completed. Fresh accounts return 400 until they set `contraception_type`.

### Pre-1.0 milestones (in the testing repo)

The v1 codebase (a thinner raw-passthrough version with no projections or write-safety harness) is archived at `../whoop-testing/v1/` for reference.

Reverse-engineering happened across three mitm capture sessions in May 2026:
- **Phase 1** (2026-05-23): primary account, read-heavy session, 122 MB capture
- **Phase 8a** (2026-05-24): test account onboarding, 29 MB
- **Phase 8b** (2026-05-24): test account write surface, 284 MB
