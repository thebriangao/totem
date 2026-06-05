<p align="center">
  <img src="assets/banner.svg" alt="whoop-mcp — 48 tools, 47 microservices, 311 endpoints" width="820">
</p>

<p align="center">
  <i>Give Claude (or any MCP-compatible AI) <b>full read + write access to your Whoop fitness data</b> by wrapping Whoop's private iOS API.</i>
</p>

<p align="center">
  <a href="#remote-hosting"><img src="https://img.shields.io/badge/Claude_Code-a855f7?style=for-the-badge" alt="Claude Code"></a>
  <a href="#claude-desktop-config"><img src="https://img.shields.io/badge/Claude_Desktop-7c3aed?style=for-the-badge" alt="Claude Desktop"></a>
  <img src="https://img.shields.io/badge/ChatGPT_Desktop-10a37f?style=for-the-badge" alt="ChatGPT Desktop">
  <img src="https://img.shields.io/badge/Codex-000000?style=for-the-badge" alt="Codex">
  <img src="https://img.shields.io/badge/Gemini_CLI-4285f4?style=for-the-badge" alt="Gemini CLI">
  <img src="https://img.shields.io/badge/Any_MCP_1.x_Client-262626?style=for-the-badge" alt="any MCP 1.x client">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-48-9ca3af?style=flat-square" alt="tools">
  <img src="https://img.shields.io/badge/TypeScript-6.0-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="typescript">
  <img src="https://img.shields.io/badge/Node-24%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="node">
  <img src="https://img.shields.io/badge/MCP-1.x%2B-9ca3af?style=flat-square" alt="mcp">
  <img src="https://img.shields.io/badge/deploy-Fly%20%7C%20Docker%20%7C%20Railway-9ca3af?style=flat-square" alt="deploy">
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/b0101d7d-24ad-4341-a88c-dc6fae075f6e" controls muted width="820"></video>
</p>
<p align="center">
  <sub>▶ 2-min demo — the full <code>whoop-mcp cloud</code> flow: install → Whoop login → Fly deploy → Claude connector → first query.</sub>
</p>

48 tools, structured zod-validated outputs, bundled catalogs (372 exercises, 308 behaviors, 203 sports, 311 endpoints), write-safety harness, automatic Cognito token refresh, session-scoped catalog gate. TypeScript 6, Node 24, 212 tests.

> *Note: this works through Whoop's private iOS API rather than the public OAuth API. That isn't what Whoop's terms allow — see the [FAQ](#faq) if you want the full picture before installing.*

---

## Table of contents

1. [Get Started](#get-started)
2. [Why this exists](#why-this-exists)
3. [What it does](#what-it-does)
4. [Architecture](#architecture)
5. [The 48 tools](#the-48-tools)
6. [Authentication](#authentication)
7. [Write-safety harness](#write-safety-harness)
8. [Bundled catalogs](#bundled-catalogs)
9. [Configuration](#configuration)
10. [Remote hosting](#remote-hosting)
    - [Deploying to Hugging Face Spaces (free hosting)](#deploying-to-hugging-face-spaces-free-hosting)
11. [The `whoop-mcp` CLI](#the-whoop-mcp-cli)
12. [Privacy + security](#privacy--security)
13. [Troubleshooting](#troubleshooting)
14. [Comparison to alternatives](#comparison-to-alternatives)
15. [FAQ](#faq)
16. [Disclaimers](#disclaimers)
17. [Acknowledgments](#acknowledgments)

**Other root-level docs:** [`TOOLS.md`](TOOLS.md) (full per-tool reference) · [`WHOOP.md`](WHOOP.md) (full API reference) · [`CHANGELOG.md`](CHANGELOG.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`LICENSE`](LICENSE)

---

## Get Started

**Prerequisites:** Node 24+ and a Whoop account (any membership tier).

```bash
git clone https://github.com/briangaoo/whoop-mcp.git
cd whoop-mcp && npm install && npx tsc && npm link
```

That puts `whoop-mcp` on your PATH (the one-time `npx tsc` builds it; after that every workflow is a `whoop-mcp` command — there are no `npm run` scripts). Now run **one guided command** — each handles Whoop login (SMS included), setup, and connecting to Claude from end to end. Pick how you want to run it:

### ★ Recommended — `whoop-mcp cloud`

Deploys the server to a host and connects it to Claude on **web, desktop, and mobile**, synced across every device on your account. One command walks through:

1. **Whoop login** — email + password, plus the SMS code if your account has MFA. Tokens are saved locally and pushed to the host.
2. **Pick a host** — Fly (automated + tested), Railway, Google Cloud Run, or your own server (guided Docker steps).
3. **Secrets** — generates `MCP_AUTH_TOKEN` and asks you to choose a connector password.
4. **Deploy + verify** — sets env, deploys, confirms `/health` and the OAuth endpoints are live.
5. **Connect** — prints ready-to-paste setup for **claude.ai, ChatGPT, Claude Code (remote), and Cursor / Windsurf / any HTTP MCP client** (URL + password for the OAuth connectors, a bearer-token block for the rest), and opens claude.ai's connector page.

```bash
whoop-mcp cloud
```

### Local only — `whoop-mcp local`

Runs the server on this machine over stdio — no hosting, this device only. Walks through Whoop login → build → wiring it into the client you pick: **Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Gemini CLI, Codex CLI, or Windsurf** — it writes the right config to the right path automatically (or prints a universal block for any other MCP client). Restart the client and you're set.

```bash
whoop-mcp local
```

### Keeping it alive

Whoop's tokens expire roughly every 30 days. When they do, re-run the same command — it re-logs you in and (if you deployed) pushes the new tokens to your server:

```bash
whoop-mcp auth
```

Silent if your account has no SMS MFA; prompts for the code if it does. Pushes fresh tokens to your deployment automatically.

### Check it works

Ask Claude: *"how am I doing today on whoop?"* — you should get structured recovery / sleep / strain back.

> Prefer to wire everything up by hand? The guided commands just automate the steps documented in [The `whoop-mcp` CLI](#the-whoop-mcp-cli), [Remote hosting](#remote-hosting), and [Configuration](#configuration). Stuck? See [Troubleshooting](#troubleshooting).

---

## Why this exists

Whoop ships two APIs:

- The **public developer API** at [`developer.whoop.com`](https://developer.whoop.com/api/) is OAuth2, read-only, and exposes **13 endpoints** under 6 scopes. You get recovery score, sleep stage totals, workout strain, body measurements (3 fields), and HRV/RHR per cycle. No journal, no Strength Trainer, no Whoop Coach, no hypnogram, no stress monitor, no trends, no writes, nothing else. Numeric `sport_id` was removed 2025-09-01.
- The **private iOS API** is what the actual Whoop app uses — `api.prod.whoop.com` behind AWS Cognito. **311 distinct operations across 47 microservices**, including everything missing from above.

This MCP wraps the iOS surface.

### What the iOS API has that the public OAuth doesn't

| Capability | Tool |
|---|---|
| HRV / RHR / respiratory / VO2 / weight time-series (25 metrics × up to 4 windows) | `whoop_trend` |
| Hypnogram (per-stage sleep timeline) + full stage breakdown (ms + %) + in-sleep HR | `whoop_sleep` |
| Strength Trainer — every set, every workout, full 372-exercise catalog, PRs | `whoop_lift_*` (8 tools) |
| 308-behavior Journal + behavior impact analysis | `whoop_journal*` (5 tools) |
| Stress monitor (intraday timeline) | `whoop_stress, whoop_live_stress` |
| Whoop Coach AI chat | `whoop_coach_ask` |
| Smart Alarm (read + 4 write modes) | `whoop_smart_alarm*` |
| HR zones (read + configure max HR / 5 custom zones) | `whoop_hr_zones*` |
| Compare-windows, sleep coach, calendar grid, performance assessment | `whoop_compare`, `whoop_sleep_need`, `whoop_calendar`, `whoop_performance_assessment` |
| Live HR / activity state / live stress | `whoop_live_*` (3 tools) |
| Community leaderboards, hidden metrics, women's health (cycle / symptoms / MCI) | `whoop_leaderboard`, `whoop_hidden_metric`, `whoop_cycle*` |
| **14 write tools** — log workouts, journal entries, profile edits, smart-alarm config | various |

If recovery + sleep totals + workout list is enough for you, use the public OAuth API. If anything in the table is interesting, you need this. The iOS API was discovered via mitmproxy — full methodology in [`WHOOP.md`](WHOOP.md).

---

## What it does

The MCP runs as a local Node process. It speaks **Model Context Protocol** over stdio (or HTTP for remote deployments), registers 48 tools at startup, and waits for tool calls from a connected MCP client.

When a tool is called:

1. Authenticates via the cached Cognito access token (auto-refreshes if expired)
2. Issues HTTP requests to `api.prod.whoop.com`
3. Walks the response to extract a flat domain object (the **projection** step)
4. Validates the projected object against a zod schema (catches Whoop API drift)
5. Returns the structured JSON to the MCP client

Writes follow the same path plus a **preview gate**: every write tool defaults `confirm: false`, returning a preview of what would be sent. Claude must explicitly re-call with `confirm: true` to fire.

See [The 48 tools](#the-48-tools) for the full per-tool reference.

---

## Architecture

```
Claude Desktop / Code  ──stdio──▶  src/server.ts  ──▶  48 tool handlers
                                                          │
                                       ┌──────────────────┼──────────────────┐
                                       ▼                  ▼                  ▼
                                  schemas (zod)    projections (raw→flat)  whoop/client
                                                                              │
                                                                              ▼ HTTPS
                                                                       api.prod.whoop.com
```

### Three layers per tool

Every tool is a schema + projection + handler:

- **`src/schemas/<tool>.ts`** — zod schema. The contract Claude sees. Used at runtime to validate the projection's output before returning.
- **`src/projections/<tool>.ts`** — pure function turning Whoop's raw BFF response into a flat object. All the "Whoop puts this data over there, not where you'd expect" knowledge lives here. Tested against captured fixtures.
- **`src/tools/v2/<tool>.ts`** — ~25-100 lines. Registers the tool, parses input args, calls the client, runs the projection, validates with zod, returns.

Almost no logic in the tool file. That's all in the projection — which makes the codebase highly testable (projections are pure transformations, tested against `tests/fixtures/*.json` without hitting the network).

### Shape drift handling

When Whoop changes a response shape, the projection emits unexpected data, zod's `.parse()` fails, and the MCP throws `WhoopProjectionError` instead of silently returning malformed data to Claude. Fix: use `whoop_raw` + `whoop_endpoints` to capture the new shape, update the projection, update the fixture, ship.

> **Recent example:** in May 2026, Whoop migrated recovery + strain deep-dives from `GRAPHING_CARD` tiles (keyed by `content.title` like `"RECOVERY"`) to `SCORE_GAUGE` + `CONTRIBUTORS_TILE` items with stable `content.id` keys (`RECOVERY_SCORE_GAUGE`, `CONTRIBUTORS_TILE_HRV`). Other deep-dives still use the old card-based shape. The escape-hatch tools made the migration trivial to debug.


---

## The 48 tools

Compact summary. **Full per-tool reference (input shape · source endpoints · output shape · notes) → [`TOOLS.md`](TOOLS.md).** Tools marked ⚠️ are writes (default `confirm: false`, preview-first). Tools marked 🔒 are gated — the catalog tool in the same group must be called once per session before they'll run.

| Group | Tools |
|---|---|
| **Snapshots & profile** (4) | `whoop_today` · `whoop_day` · `whoop_profile` · `whoop_calendar` |
| **Deep dives** (3) | `whoop_recovery` · `whoop_sleep` · `whoop_strain` |
| **Trends** (2) | `whoop_trend` · `whoop_compare` |
| **Stress + sleep coach** (2) | `whoop_stress` · `whoop_sleep_need` |
| **Live** (3) | `whoop_live_hr` · `whoop_live_state` · `whoop_live_stress` |
| **Activities** (5) | `whoop_workouts` · `whoop_workout` · `whoop_sports_catalog` · `whoop_activity_create` ⚠️🔒 · `whoop_activity_delete` ⚠️ |
| **Strength reads** (6) | `whoop_lift_prs` · `whoop_lift_exercise` 🔒 · `whoop_lift_progression` 🔒 · `whoop_lift_history` · `whoop_lift_library` · `whoop_lift_catalog` |
| **Strength writes** (3) | `whoop_lift_log` ⚠️🔒 · `whoop_lift_template_save` ⚠️🔒 · `whoop_lift_custom_exercise` ⚠️🔒 |
| **Journal** (5) | `whoop_journal` · `whoop_journal_catalog` · `whoop_behavior_impact` · `whoop_journal_log` ⚠️🔒 · `whoop_journal_autopop` ⚠️ |
| **Women's health** (3) | `whoop_cycle` · `whoop_cycle_log` ⚠️ · `whoop_symptom_log` ⚠️🔒 |
| **Coach + performance** (2) | `whoop_coach_ask` ⚠️ · `whoop_performance_assessment` |
| **Smart alarm** (2) | `whoop_smart_alarm` · `whoop_smart_alarm_set` ⚠️ |
| **Social** (2) | `whoop_leaderboard` · `whoop_communities` |
| **Settings** (4) | `whoop_hr_zones` · `whoop_hr_zones_set` ⚠️ · `whoop_profile_update` ⚠️ · `whoop_hidden_metric` ⚠️ |
| **Escape hatch** (2) | `whoop_raw` · `whoop_endpoints` |

**Total: 48** (32 reads + 14 writes + 2 escape hatches). For each tool's input args, source endpoint(s), and output shape, see [`TOOLS.md`](TOOLS.md).

---

## Authentication

Whoop's iOS app uses **AWS Cognito** routed through a Whoop-owned proxy (`/auth-service/v3/whoop/`). The proxy fills in `ClientId` + `SECRET_HASH` server-side — no IPA extraction needed.

**Bootstrap once** (email + password + SMS MFA code if your account has it on) → tokens written to `.env`. **After that, it's hands-off**: access tokens auto-refresh every 24h via the refresh token; refresh token lives ~30 days. Single-flight refresh gate prevents thundering-herd refreshes when concurrent tool calls all see a stale token at the same time.

Auth requests impersonate the iOS AWS Swift SDK (the proxy 403s a Node-style User-Agent), and data requests carry the **WHOOP iOS app's own identity headers** (`user-agent: iOS`, the `x-whoop-*` device set, a per-install identifier) so the traffic blends with the legitimate app rather than standing out — see [`WHOOP.md` → Headers for data requests](WHOOP.md) for the full set and the reasoning.

**Error classes** (`src/whoop/errors.ts`):

| Error | When | Behavior |
|---|---|---|
| `WhoopAuthExpiredError` | 401 from Whoop | TokenManager refreshes on next call |
| `WhoopApiError` | 4xx with body | Description surfaced to caller |
| `WhoopServerError` | 5xx | Transient — retry |
| `WhoopProjectionError` | Projection output failed zod parse | Whoop changed shape — fix the projection |

When refresh-token lifetime expires (~30 days), re-run `whoop-mcp auth`. It auto-detects local vs deployed and, for a deployment, pushes the new tokens to it. Brand-new SMS code (if your account has MFA), fresh 30-day window.

---

## Write-safety harness

Every write tool defaults `confirm: false`. The first call returns a **preview** of what would execute. Claude must explicitly re-call with `confirm: true` to fire the actual request. Without the gate, a hallucinated "log my workout" could create garbage activities on your account.

The preview shape (lives in `src/whoop/write_safety.ts`):

```json
{
  "preview": true,
  "will_execute": {
    "method": "POST",
    "path": "/weightlifting-service/v2/weightlifting-workout/activity",
    "body_summary": {
      "exercise_count": 3, "set_count": 12,
      "exercise_list": [{"name": "BENCHPRESS_BARBELL", "set_count": 5}, ...]
    }
  },
  "set_confirm_true_to_run": true
}
```

Claude reads this back to you, you confirm, Claude re-calls with `confirm: true`, the actual POST fires. Every write tool's output schema is a `withPreview(ReceiptSchema)` discriminated union — preview or receipt, never both.

---

## Bundled catalogs

Four datasets compiled into the MCP at build time (not fetched at runtime):

| Catalog | Entries | Catalog tool | Use |
|---|---:|---|---|
| `behaviors.ts` | 308 | `whoop_journal_catalog` | Journal behavior validation |
| `exercises.ts` | 372 | `whoop_lift_catalog` | Strength Trainer exercises |
| `sports.ts` | 203 | `whoop_sports_catalog` | `sport_id` ↔ name |
| `endpoints.ts` | 311 | `whoop_endpoints` | API path search |

**Session-scoped gate**: tools that take IDs from sports/exercises/behaviors refuse to run until the corresponding catalog tool has been called once per session. Keeps ~14k tokens out of the system prompt. AI calling e.g. `whoop_activity_create` first gets `{error: "Must call whoop_sports_catalog first…"}`.

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `WHOOP_EMAIL` | yes | Your Whoop login email |
| `WHOOP_PASSWORD` | yes (bootstrap only) | Your Whoop login password (used only during bootstrap) |
| `WHOOP_IOS_BEARER_TOKEN` | yes | Cognito access token (24h, auto-refreshed) |
| `WHOOP_COGNITO_REFRESH_TOKEN` | yes | Cognito refresh token (~30d) |
| `WHOOP_USER_ID` | no | Your Whoop user ID — used by `whoop_profile`, `whoop_leaderboard`. Avoids one bootstrap call per session. |
| `WHOOP_TIMEZONE` | no | IANA timezone (e.g., `America/Los_Angeles`). If unset, auto-detected from your Whoop profile and refreshed hourly. Set explicitly to override. |
| `WHOOP_INSTALLATION_ID` | no (auto) | The per-install device identifier sent as `x-whoop-installation-identifier`. Generated once and written to `.env` on first run — don't set it by hand. |
| `WHOOP_TOKEN_STORE` | no | `envfile` (default — persists refreshed tokens back to `.env`) or `memory` (for read-only filesystems; re-bootstrap every ~30 days). |

### Claude Desktop config

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

The MCP loads `.env` from the repo root (relative to `server.js`). Use absolute paths — Claude Desktop doesn't inherit shell `PATH`.

---

## Remote hosting

The MCP also speaks HTTP — deploy once, use from multiple devices. Same 48 tools, same auto-refresh, behind a bearer-token gate at a URL.

```bash
# 1. Local bootstrap (Cognito needs an interactive MFA prompt)
whoop-mcp auth

# 2. Build + deploy via the shipped Dockerfile (Fly/Railway/Render/VPS — all work)
docker build -t whoop-mcp .

# 3. Run with env: WHOOP_EMAIL, WHOOP_IOS_BEARER_TOKEN, WHOOP_COGNITO_REFRESH_TOKEN,
#    MCP_TRANSPORT=http, MCP_AUTH_TOKEN=$(openssl rand -hex 32)
```

### Deploying to Hugging Face Spaces (free hosting)

[Hugging Face Spaces](https://huggingface.co/spaces) provides **free Docker hosting** — a zero-cost alternative to Fly or Railway. Connecting to **claude.ai web and Claude mobile** as a custom connector requires a **Claude Pro plan**, but the server itself runs for free on HuggingFace.

> **Note:** The Dockerfile in this repo already sets `PORT=7860` and `EXPOSE 7860`, which is the port HuggingFace Spaces requires. If you adapt a different version of this server, make sure to change the port to `7860` — HuggingFace routes all external traffic through that port only.

#### Step-by-step

**1. Create a new Space**

- Go to [huggingface.co/new-space](https://huggingface.co/new-space)
- Select **Docker** as the Space SDK
- Set the **visibility to Public** — HuggingFace Spaces must be public for Claude's connector to reach the `/mcp` endpoint

**2. Add your secrets via the Space Settings UI**

In your Space → **Settings → Variables and Secrets**, add each of the following as a **Secret** (not a variable — secrets are hidden and not exposed in logs):

| Secret name | Where to find the value |
|---|---|
| `WHOOP_EMAIL` | Your Whoop account email |
| `WHOOP_IOS_BEARER_TOKEN` | From `whoop-mcp auth` on your local machine (written to `.env`) |
| `WHOOP_COGNITO_REFRESH_TOKEN` | From `whoop-mcp auth` on your local machine (written to `.env`) |
| `WHOOP_USER_ID` | From `.env` after running `whoop-mcp auth` |
| `MCP_AUTH_TOKEN` | The value of `MCP_AUTH_TOKEN` in your `.env.deploy` file |
| `AUTH_PASSWORD` | A password you'll type once when adding the Claude connector |
| `PUBLIC_URL` | Your Space's public URL — e.g. `https://raunakjodhawat-whoop-mcp-server.hf.space` |

> **Tip:** `MCP_AUTH_TOKEN` and the other token values can be found in your local `.env.deploy` file after running `whoop-mcp auth`.

**3. Push your code to the Space**

Clone this repo and add your HuggingFace Space as a remote, then push:

```bash
git clone https://github.com/raunakjodhawat/whoop-mcp
cd whoop-mcp

# Add your HuggingFace Space as a remote
git remote add hf https://huggingface.co/spaces/<your-hf-username>/<your-space-name>

# Push the main branch
git push hf main
```

HuggingFace will automatically build and run the Docker container. Watch the **Logs** tab in your Space to confirm it starts up and `/health` returns 200.

**4. Connect to Claude**

Once the Space is running, go to **claude.ai → Settings → Connectors → Add custom connector**:

- **MCP Server URL:** `https://<your-hf-username>-<your-space-name>.hf.space/mcp`
- Claude will open an OAuth flow — enter the `AUTH_PASSWORD` you set in your Space secrets

> The `MCP_AUTH_TOKEN` value from your `.env.deploy` file is used internally as the bearer token and JWT signing secret. You do **not** type it into Claude's connector UI — that field uses the OAuth `AUTH_PASSWORD` flow instead.

**5. Re-authenticate when tokens expire (~30 days)**

Whoop's Cognito tokens expire roughly every 30 days. Re-run `whoop-mcp auth` on your local machine, then update `WHOOP_IOS_BEARER_TOKEN` and `WHOOP_COGNITO_REFRESH_TOKEN` in your Space's Secrets UI. The Space will restart automatically and pick up the new tokens.

**Claude Desktop** doesn't natively speak remote MCP — bridge through stdio with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{ "mcpServers": { "whoop": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://your-app.fly.dev/mcp",
           "--header", "Authorization:Bearer your-mcp-auth-token"]
}}}
```

**Claude Code** speaks remote MCP natively: `claude mcp add whoop --url ... --header ...`.

**claude.ai web + Claude mobile app** can't use a bearer token — their custom-connector UI only supports OAuth. The server includes an OAuth 2.1 + PKCE authorization server for exactly this. Enable it by setting two extra env vars:

```bash
AUTH_PASSWORD=<a password you'll type once when adding the connector>
PUBLIC_URL=https://your-app.fly.dev   # your server's public origin (the OAuth issuer)
```

Then in Claude: **Settings → Connectors → Add custom connector**, paste `https://your-app.fly.dev/mcp`, and Claude walks the OAuth flow. It pops a small password page (served by your server) — enter `AUTH_PASSWORD`, approve, done. The connector then syncs across every device logged into your Claude account (web, desktop, mobile). The password gate means a stranger who finds your URL still can't connect without it. `MCP_AUTH_TOKEN` doubles as the JWT signing secret; leave `AUTH_PASSWORD` unset to disable this path.

All of the above is what `whoop-mcp cloud` automates for you — the manual steps here are for reference or hand-rolling.

**When Cognito expires (~30 days)**: `whoop-mcp auth` from your Mac. Silent if your account has no SMS MFA; prompts for the code if it does. Auto-detects your deployment and pushes the new tokens to it (Fly/Railway/Cloud Run/custom), ~10s restart. Requires being at a machine with the repo + the platform CLI.

**Security**: bearer-token and OAuth paths both gate `/mcp`. Generate the token random (`openssl rand -hex 32`), HTTPS only, never commit, rotate if leaked. OAuth access/refresh tokens are stateless signed JWTs (survive restarts); auth codes are one-time + 60s-lived; PKCE S256 is enforced. `/health` is the only path without auth.

---

## The `whoop-mcp` CLI

`whoop-mcp` is the single entry point for everything — there are no `npm run` scripts. It works from any directory (it resolves its own install path), so `whoop-mcp deploy` from `~/Desktop` does the same thing as `cd whoop-mcp && fly deploy`.

```bash
# One-time, after cloning:
npm install && npx tsc && npm link   # the only npm steps; `npx tsc` does the first build

whoop-mcp       # banner + full command list
```

Commands by group:

| Group | Commands |
|---|---|
| **Get started** | `cloud` ★ (guided server deploy + Claude connect) · `local` (guided local setup) |
| **Setup** | `auth` (log in + save tokens — re-run to re-auth; auto-detects local vs deployed and pushes new tokens to your deployment) |
| **Deployed** | `deploy` · `logs` · `status` · `ping` |
| **Local dev** | `start [--http]` · `dev` · `dev:http` · `build` · `test` · `typecheck` |
| **Inspect** | `info` · `tools` · `config <stdio\|http>` |
| **Help** | `help` · `version` (+ `--help`, `-v` aliases) |

Most people only ever need the two **Get started** commands plus `auth` (to re-auth when tokens expire). The rest are for power users — `whoop-mcp ping` ("is my deploy alive"), `whoop-mcp logs`, `whoop-mcp start` (drop-in for `node dist/server.js`), etc.

---

## Privacy + security

- **Credentials live in `.env` on your machine.** Email, password, access token, refresh token — never leave your filesystem. Claude can't read them (it doesn't have filesystem access unless you wire in a filesystem MCP).
- **The only outbound traffic is HTTPS to `api.prod.whoop.com`.** No telemetry, no analytics, no third-party servers. The MCP is open source — every line that touches your data is auditable.
- **Write safety**: every write tool defaults to `confirm: false`. The preview shape includes what would be sent. You see it in chat before any mutation. To go further, remove specific writes from `src/tools/register.ts` or use Claude Desktop's "always require approval" setting.
- **Hardened in 1.2.3**: token files are written `0600`, your account password is wiped from `.env` after login, OAuth tokens are audience-bound and signed with a key derived from `MCP_AUTH_TOKEN`, the HTTP server sends anti-clickjacking + CSP headers, the connector-password gate has a global brute-force ceiling, and deploy secrets are pushed over stdin (not argv). Full detail in [`SECURITY.md`](SECURITY.md) and [`CHANGELOG.md`](CHANGELOG.md).

---

## Troubleshooting

**"AUTH FAIL: Cognito InitiateAuth failed (400)"**
> Wrong email or password. Double-check `.env`.

**"AUTH FAIL: Cognito MFA challenge missing Session token"**
> The InitiateAuth response was malformed (unusual). Re-run `whoop-mcp auth` — Cognito occasionally drops sessions.

**"MFA verification did not return tokens"**
> You entered the wrong SMS code (or it timed out). Codes expire after ~3 minutes.

**"WhoopAuthExpiredError" after every call**
> Your refresh token has expired (>30 days since last login). Re-run `whoop-mcp auth` — it logs you back in, saves the tokens locally, and (if you deployed) auto-detects your host and pushes the new tokens to it in one step. If your account has MFA you'll get a fresh SMS code on your phone to type in the terminal.

**"WhoopServerError: 502" / "503" / "504"**
> Whoop's servers are having issues. Retry in 30 seconds.

**Claude says it doesn't see any whoop tools**
> Check `claude_desktop_config.json` paths are absolute. Restart Claude Desktop fully (quit, then reopen).
> Check the MCP server runs without errors: `whoop-mcp dev` — it should start silently and wait on stdin.

**"WhoopApiError: 422 on /profile-service/v1/profile"**
> Your `whoop_profile_update` body is too partial. Send most fields (gender from {MALE,FEMALE,NON_BINARY} only, birthday as YYYY-MM-DD or ISO datetime, country ISO-2). If `country=US`, also send `state` — Whoop returns 400 `"AdminDivision (state) must be set for US"` otherwise.

**"Whoop API error 409 on /weightlifting-service/v2/weightlifting-workout/activity"**
> Time window conflicts with an existing workout. Use a different range.

**"WhoopProjectionError for whoop_X"**
> Whoop changed a response shape. Capture the new response (e.g. via `whoop_raw`), inspect, update the projection.

**Tests fail after `git pull`**
> Pull may have updated captured fixtures. Run `whoop-mcp test` again to see what changed. If projections need updating, that's the work.

**`whoop-mcp build` (or `npx tsc`) fails with "Top-level await is currently not supported with the 'cjs' output format"**
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
| **This MCP** | Full iOS API surface (48 total: 32 reads + 14 writes + 2 escape hatches), writes supported, structured outputs, auto-refresh, write-safety, session-scoped catalog gate | Unsupported by Whoop (see [FAQ](#faq) for what that means); reverse-engineered (Whoop could break it at any time); local install required |
| Whoop's public OAuth API | Official, supported, 6 webhook events, scoped permissions | Only 13 endpoints; read-only; no journal/strength/stress/coach/smart-alarm/trends/hypnogram; numeric `sport_id` removed 2025-09-01; 429s exist |
| HealthKit-based scraper | Bypass Whoop entirely; uses Apple's data sync | Loses Whoop-specific data (recovery score, journal, coach); requires iOS device involvement |
| Direct mitmproxy capture | See everything | Manual, not programmable, doesn't scale |
| Whoop iOS app + screenshots → Claude | Works without code | Painful, slow, no writes |

This MCP is the only option for **programmatic write access** to your Whoop data right now.

---

## FAQ

**Q: Is this supported by Whoop?**
A: No. This MCP works through Whoop's private iOS API, which isn't a public surface they intend for third-party tools. Whoop's terms reserve the right to take action against accounts they catch using unsupported integrations — realistically that means suspending API access or terminating the membership. The author has used the MCP heavily for weeks without issue, and traffic patterns look similar to normal app usage, but there's no guarantee. If losing your Whoop account would be a problem for you, don't use this.

**Q: Why not use Whoop's public OAuth API instead?**
A: It's 13 endpoints, all read-only, no journal, no strength, no stress, no coach, no smart alarm, no trends beyond a single recovery score per day. Whoop also pulled numeric `sport_id` past 2025-09-01 (now `sport_name` strings only). If you only need recovery score + sleep stage totals + workout list, the OAuth API is the right answer.

**Q: Will this work with the Whoop 4.0 vs 5.0 strap?**
A: Yes — the API doesn't care which strap you have. It cares about your account.

**Q: What about Whoop 6.0?**
A: When it launches and the iOS app updates, the api version may bump from 7 to 8. The MCP's `constants.ts` may need an update. Worst case, projections break and you fix them.

**Q: Can I run this on a server / cloud / always-on?**
A: Sure. The MCP doesn't care where it runs. Just make sure your `.env` survives restarts.

**Q: Can I share this MCP with my friends?**
A: Each user needs their own `.env` with their own Whoop credentials. Don't share tokens.

**Q: Is there an HTTP transport instead of stdio?**
A: Yes — set `MCP_TRANSPORT=http` to expose the MCP over Streamable HTTP behind a bearer-token + OAuth 2.1 gate (since v1.1.0). See [Remote hosting](#remote-hosting). stdio stays the default for local Claude Desktop / Claude Code.

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

## Disclaimers

- **Not affiliated with Whoop.** "WHOOP" is a trademark of WHOOP, Inc. Community-built tool that interacts with surfaces Whoop has not published. See the [FAQ](#faq) for the practical implications.
- **No warranty, use at your own discretion.** The API surface is reverse-engineered — Whoop can change response shapes at any time. The zod schemas surface drift as `WhoopProjectionError` instead of silent corruption.
- **Respect rate limits.** Single-digit RPS in normal use. Don't be the person who triggers a backend alert that gets every user of this MCP banned.
- **Don't share tokens.** Your `.env` is yours. Don't commit it, don't paste it anywhere.

---

## Acknowledgments

- **WHOOP** for building a fitness platform worth reverse-engineering
- **Anthropic** for [MCP](https://modelcontextprotocol.io) and [Claude](https://claude.ai)
- **mitmproxy** for being the tool that made discovery possible
- **The TypeScript + zod community** for making strict validation pleasant
- The various API consumers + bloggers who documented bits of Whoop's private API over the years

This is open source under the terms in `LICENSE`. Contributions welcome.
