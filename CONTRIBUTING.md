# Contributing to totem

Pull requests are welcome. The code base is small and the tests run in a few seconds.

## Setup

```bash
git clone https://github.com/thebriangao/totem.git
cd totem
npm install
npx tsc && npm link     # builds once and puts `totem` on your PATH
totem auth --local      # log in to WHOOP (use a test account if you have one)
totem test
```

`totem test`, `totem typecheck` and `totem dev` run from the source, so there is no rebuild while you work. `totem dev --http` starts the HTTP server (set `MCP_AUTH_TOKEN` to 32+ characters first).

## How the code is laid out

```
src/
├── server.ts            stdio entry (what an app starts on your computer)
├── server-http.ts       HTTP entry: MCP, OAuth sign-in, consent and Connect pages, /admin/tokens
├── cloudflare/          the same server inside a Durable Object (wrangler.jsonc builds it)
├── whoop/               WHOOP client and login
│   ├── client.ts          requests, errors, the bounded read cache, 401 refresh-and-retry
│   ├── token_manager.ts   one owner per login, keep-alive, rotation saved before use
│   ├── token_store.ts     the token file (and a memory store for tests)
│   ├── oauth_provider.ts  OAuth 2.1 for apps that connect to a server
│   └── consent_page.ts, connect_page.ts   the two pages a person sees
├── tools/
│   ├── register.ts        the 41 tools, in order
│   └── v2/                one file per tool
├── projections/v2/      WHOOP's responses turned into the compact shapes tools return
├── lib/                 dates, time zones, times as tools take them, install links, helpers
├── data/                catalogs generated from WHOOP (exercises, behaviours, sports, endpoints)
└── cli/                 the `totem` command: setup flows, connect, auth, update, the UI kit
```

A tool reads from WHOOP through `WhoopClient`, turns the response into a small shape with a projection, and returns it as compact JSON. A tool that writes returns a preview (`will_execute`) unless it gets `confirm: true`, then reads back what it wrote to check it landed.

## Rules the tests hold you to

- **Token budget.** The whole tool list must stay at or under 36,000 characters (`tests/tools/registry.test.ts`), and a default call at about 1.5 KB (`tests/tools/default_output_budget.test.ts`). Every character in a description is paid on every turn of every conversation.
- **TOOLS.md is generated.** After changing a tool, run `npx tsx scripts/tools-md.ts > TOOLS.md`.
- **The CLI's screens are snapshots** (`tests/cli/screens/`). Run the tests with `-u` after a deliberate change and read the diff. Colour must only decorate, lines stay within 80 columns, and there is an ASCII fallback.
- **No real data in fixtures.** Fixtures come from a test account or are made up. Never commit anything from a real person's account.

## Adding a tool

Think twice: a new tool costs tokens for everyone, and most ideas fit an existing tool as an `include` option or an input.

1. Find the endpoint (see [WHOOP.md](WHOOP.md); `whoop_raw` lets you call it).
2. Save a response from a test account under `tests/fixtures/`.
3. Write the projection in `src/projections/v2/` and its test.
4. Write the tool in `src/tools/v2/` and add it to `src/tools/register.ts` and the groups in `scripts/tools-md.ts`.
5. `totem typecheck && totem test`, then regenerate TOOLS.md.

## When WHOOP changes something

A tool starts returning nulls, or a write starts failing. Call the endpoint with `whoop_raw`, save the new response as a fixture, update the projection and its test, and note the change in [WHOOP.md](WHOOP.md).

## Before you open a pull request

```bash
totem typecheck && npx tsc --noEmit -p tsconfig.test.json && totem test
```

CI runs the same on every pull request. Describe what changed and how you checked it; for a tool, say which account (test or your own) you tried it against.

## Commits

One change per commit, a subject that says what is now true ("whoop_sleep refuses an activity that isn't a sleep"), and a body with what broke, how you found it and how you checked the fix.

## Reporting bugs

Open an issue with the tool, the exact inputs, what it returned and what you expected. A `whoop_raw` response of the endpoint behind it helps a lot (remove anything personal first).

## Code of conduct

Be kind. This is a small project.
