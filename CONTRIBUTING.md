# Contributing to totem

Pull requests welcome. The codebase is small and the test suite is fast, so iteration is quick.

---

## Quick orientation

```
src/
├── server.ts            # MCP entry — branches on MCP_TRANSPORT (stdio default, http opt-in)
├── server-http.ts       # Streamable HTTP transport + bearer-token auth gate (since v1.1.0)
├── whoop/               # Auth + HTTP-client layer (don't break unless you know what you're doing)
│   ├── client.ts        # Outbound HTTP wrapper, error classification, 30s timeout
│   ├── cognito.ts       # Cognito proxy auth (no AWS SDK, no client secret)
│   ├── token_manager.ts # Auto-refresh, single-flight, persists via TokenStore
│   ├── token_store.ts   # EnvFileTokenStore + MemoryTokenStore (since v1.1.0)
│   ├── write_safety.ts  # preview() + withPreview() helpers
│   ├── build_lift_body.ts
│   ├── session_state.ts # In-memory catalog-gate Set
│   ├── errors.ts, json_out.ts, constants.ts, types.ts
├── data/                # Auto-generated catalogs (behaviors, exercises, sports, endpoints)
├── schemas/             # zod schemas for every tool's output (the contract with Claude)
├── projections/         # Raw API response → flat domain object (one per tool group)
├── lib/                 # walk / dates / format / stats helpers
└── tools/
    ├── register.ts      # Wires every tool to the MCP server
    └── v2/              # 48 tool handlers, one per file
```

Every tool follows a three-layer pattern: **schema** (defines the output shape) → **projection** (walks the raw API response into that shape) → **tool** (registers it with the MCP server, validates input args, calls the client, runs the projection, returns).

See [README.md → Architecture](README.md#architecture) for the full pattern walkthrough. See [README.md → Remote hosting](README.md#remote-hosting) for the HTTP transport architecture (added in v1.1.0).

---

## Setup

```bash
git clone https://github.com/briangaoo/totem.git
cd totem
npm install
npx tsc && npm link          # one-time: builds + puts `totem` on PATH
cp .env.example .env
# edit .env with your Whoop creds
totem auth
totem test               # 219 tests, <2s
totem typecheck
totem build

# stdio mode (default, for local Claude Desktop / Claude Code):
totem dev

# HTTP mode (for remote hosting via Docker/Fly/etc.):
MCP_AUTH_TOKEN=$(openssl rand -hex 32) totem dev:http
curl http://localhost:3000/health   # → {"status":"ok"}
```

> The only `npm` steps are `npm install` and the one-time `npx tsc` (you need a build before the `totem` CLI exists). Everything else is a `totem` command — `package.json` has no `scripts`. `totem test`/`dev`/`typecheck` run against the source directly, so you don't rebuild to iterate.

---

## Adding a new tool

Walkthrough lives in [README.md → Adding a new tool](README.md#adding-a-new-tool). Short version:

1. Pick a source endpoint (browse [`WHOOP.md`](WHOOP.md) for the relevant microservice).
2. Add a zod schema in `src/schemas/`.
3. Add a projection function in `src/projections/`. Tested against captured fixtures in `tests/fixtures/*.json`.
4. Add a tool file in `src/tools/v2/` (~30 lines: register with the MCP server, parse args, call client, project, validate, return).
5. Wire it up in `src/tools/register.ts`.
6. Add a projection test in `tests/projections/`.
7. `totem typecheck && totem test && totem build`.

---

## Fixing a broken projection (Whoop API drift)

When Whoop changes a response shape, projections may start returning all-null or partial outputs. They typically don't throw — zod schemas validate the *shape*, not the *content*, so null-heavy outputs pass validation silently.

To debug:

1. Hit the endpoint live via `whoop_raw` — get the current shape into your hands.
2. Save it as a captured fixture under `tests/fixtures/`.
3. Diff against the old fixture. Common drift patterns:
   - Tile types renamed (e.g. `GRAPHING_CARD` → `SCORE_GAUGE`)
   - Card titles changed (e.g. `"RECOVERY"` → no title, identified by `content.id` instead)
   - Sport name mappings changed (e.g. `weightlifting_msk` exposed via different internal_name)
4. Rewrite the projection to walk the new shape.
5. Update the per-projection tests with the new expected values.
6. Document the migration in [`WHOOP.md`](WHOOP.md) so the next person knows.

Recent precedents to read:
- May 2026 deep-dive migration: `src/projections/recovery.ts`, `src/projections/strain.ts`. See [Pattern 2b in the endpoints doc](WHOOP.md).
- Sport-name filter fix: `src/projections/lift_history.ts` — old `/strength/i` regex matched none of `weightlifting_msk` / `weightlifting` / `powerlifting`.

---

## Testing

- **`totem test`** — 219 unit tests in <2s. Fixture-driven for projections; integration-style for the HTTP transport (`tests/whoop/http_auth.test.ts` spins up a real `http.Server` and hits it with `fetch`).
- **Live-API tests live in a separate `whoop-testing` archive.** They require a dummy account and aren't safe to expose to first-time users. If you want to add or run them, ask Brian.
- When fixing a projection, update its fixture in `tests/fixtures/` and the corresponding test in `tests/projections/` (`round1`/`round2`/`round3`, plus `round3_data_fixes.test.ts` for the live-audit data-extraction regressions).
- When changing the HTTP transport (`src/server-http.ts`) or auth model, add coverage to `tests/whoop/http_auth.test.ts`. The pattern is: boot a real server on an ephemeral port with a stub `WhoopClient`, then assert with `fetch()`.
- **CI runs the same checks on every PR.** `.github/workflows/ci.yml` runs `tsc --noEmit`, the full `vitest` suite, and a build on each push to `main` and each pull request. Run `totem typecheck && totem test && totem build` locally before opening a PR and it'll pass green — nothing reaches `main` (or a merge) without it.

---

## Code style

- TypeScript 6 strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`).
- No `any`. Use `unknown` + narrow with `isObject` / `asString` / `asNumber` from `src/lib/walk.ts`.
- Match the existing conventions in adjacent files — don't unilaterally refactor.
- Don't add features beyond what the task requires.
- One tool per file. ~30 lines is normal; over 100 is a smell unless the schema is genuinely complex (`whoop_smart_alarm_set` has 4 modes — that's fine).

---

## Commit style

Follow what's already in the log:

```
fix: whoop_recovery + whoop_strain were silently returning all-null

<one paragraph explaining what broke and how you found it>
<one paragraph on the fix>
<verification: live-API check or test result>
```

For commits that change behavior, include a before/after measurement when possible. The bug reports + fixes in the existing log are good models.

---

## Reporting bugs

Open an issue with:
- Which tool
- The exact arguments you called it with
- The full output (especially if it's all-null or partial)
- The current state of your account that should be in the output (e.g. "I have 3 workouts on May 23 but `whoop_workouts` returns empty")

If you can attach a `whoop_raw` capture of the underlying endpoint, even better.

---

## Code of conduct

Be decent. This is a small project run by a teenager.
