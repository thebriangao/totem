# Security policy

## What this MCP touches

This server holds AWS Cognito access + refresh tokens for your Whoop account and reads + writes your personal fitness data. Treat the host running it (and the file holding the tokens) with the same care you'd treat a logged-in Whoop session.

**In local stdio mode** (the default), the only attack surface is your own machine. Anyone with local file access to `.env` or to the running process has full access to your Whoop account.

**In HTTP mode** (`MCP_TRANSPORT=http`, since v1.1.0), there's an additional surface: the URL is public-by-default and protected only by a static bearer token in the `MCP_AUTH_TOKEN` env var. Anyone who learns that bearer token gets the same full account access as if they had your `.env`. See "Threat model — HTTP mode" below.

## What it does NOT do

- No telemetry, no analytics, no remote logging
- No outbound network calls except `https://api.prod.whoop.com`
- No data persisted outside `.env` (stdio mode) or the configured `TokenStore` (HTTP mode) and the running process memory
- No file-system access outside the repo root
- No code-execution surface for the AI: tool inputs are validated by zod before any HTTP call
- No multi-tenancy: one deployment = one Whoop account, full stop

## Reporting a vulnerability

Email **briangaoo2@gmail.com** with subject `[totem security]`. Please don't open a public GitHub issue for security reports.

For non-security bug reports, [open an issue](https://github.com/thebriangao/totem/issues).

## What counts as security

- Credential leakage (`.env` being read by a path that shouldn't, tokens being logged, secrets accidentally committed)
- Privilege escalation (a tool writing to a different user's account, a write firing without `confirm: true`)
- Code injection via tool arguments (input not validated before being passed to `fetch` or `eval`)
- Sensitive data being exfiltrated to a third party (responses being sent anywhere besides the MCP client)
- Auth bypass (a tool succeeding without a valid Cognito token, OR — in HTTP mode — a request to `/mcp` succeeding without a valid bearer token, OR a timing attack against the bearer token compare)
- Logging that leaks the bearer token, refresh token, or any portion of `Authorization` headers

What's NOT a security report (open a normal issue):
- A projection returning incorrect data
- A tool returning empty output
- A Whoop API change breaking a projection
- A schema mismatch
- A 4xx or 5xx from Whoop

## Threat model — stdio mode (default, local)

- **The MCP trusts the user's local environment.** If your machine is compromised, the tokens in `.env` are too.
- **The MCP trusts the AI client.** Claude (or whoever you wire in via MCP) can call any tool. The write-safety harness (`confirm: false` default) is a check against accidental mutations, not against a malicious AI. If you don't want a tool callable at all, comment out its registration in `src/tools/register.ts` and rebuild.
- **The MCP trusts Whoop's API.** A compromised Whoop backend could return arbitrary content and we'd happily pass it to the AI. zod validates shape, not provenance.

## Threat model — HTTP mode (remote, since v1.1.0)

When you set `MCP_TRANSPORT=http` and deploy to a public URL, you add:

- **The bearer token (`MCP_AUTH_TOKEN`) is the only thing protecting your Whoop account.** Anyone with the URL + token gets full read+write. There is no second factor.
- **Token compromise is total.** The server can't distinguish a leaked-token request from a legitimate one. The leaked token grants full account access until you rotate it.
- **HTTPS is required in production.** Plain HTTP exposes the bearer token to anyone on the network path. Every recommended deploy host (Fly, Railway, Render, Cloudflare Tunnel) gives you HTTPS automatically. If you bring your own VPS, put it behind Caddy / Nginx with a TLS cert.
- **The static bearer token is compared with `crypto.timingSafeEqual`** (via a constant-time helper that length-checks first, so a wrong-length token returns 401 without exposing length via timing) to dodge timing-attack side channels. The `/mcp` auth gate is the MCP SDK's `requireBearerAuth`, which also accepts OAuth 2.1 access tokens (the same `MCP_AUTH_TOKEN` signs them — see "OAuth" below). A failed request returns 401 with a `WWW-Authenticate: Bearer` header pointing at the protected-resource metadata (`/.well-known/oauth-protected-resource/mcp`, per RFC 9728) so OAuth clients can discover the authorization server.
- **The MCP host can read your Whoop data.** Whoever operates the host you deploy to — Fly, Railway, your VPS provider, etc. — has root on the box. They can read the env vars (including `WHOOP_IOS_BEARER_TOKEN` + `WHOOP_COGNITO_REFRESH_TOKEN` + `MCP_AUTH_TOKEN`) and the running process memory. Don't deploy to a host you don't trust at the operator level.
- **Logs are minimal but non-zero.** The server logs request errors to stderr. We avoid logging `Authorization` headers, tool arguments, and response bodies. If you fork and add custom logging, scrub these.
- **Concurrent connections share state.** The catalog gate (`session_state.ts`) is process-global. Two clients connected to one deployment share the unlock state. Not a security issue (both are the same Whoop account) but worth noting if you fork it to support multiple users.

### OAuth (claude.ai web + mobile connectors)

Setting `AUTH_PASSWORD` enables a full OAuth 2.1 + PKCE authorization server (the MCP SDK's `mcpAuthRouter` + a custom provider in `src/whoop/oauth_provider.ts`), required for adding the server as a custom connector on claude.ai web / Claude mobile (which have no bearer-token field).

- **A password gates the `/authorize` step.** Adding the connector serves a small password page; the user enters `AUTH_PASSWORD` once. A stranger who finds the URL can't connect without it. The password is checked with the same constant-time compare as the bearer token.
- **Stateless tokens.** Access + refresh tokens are HS256 JWTs signed with a key **derived from `MCP_AUTH_TOKEN`** (HMAC, since 1.2.3 — not the token itself, so the static bearer and the signing secret aren't the same string in two roles); registered clients (dynamic client registration) encode their redirect URIs into a signed `client_id`. Only the 60-second authorization codes live in memory. This survives Fly's auto-stop restarts without a database — but it also means **rotating `MCP_AUTH_TOKEN` invalidates every issued OAuth token** (clients must re-authorize) in addition to the static bearer.
- **Tokens are audience-bound** (RFC 8707, since 1.2.3). An access token carrying a `resource` claim is rejected unless it matches this server's `/mcp` URL, so a token minted for one deployment can't be replayed against another that happens to share the secret.
- **Leave `AUTH_PASSWORD` unset to disable the OAuth path entirely** — then only the static bearer is accepted, as in the bullets above.

## Token hygiene

- **Cognito tokens (Whoop):** the 24h access token is in memory and (in stdio mode) `.env`. The ~30d refresh token is in `.env`. If you suspect either is compromised: revoke via `DELETE /v2/user/access` (the OAuth account-deletion endpoint), then re-bootstrap with a fresh password.
- **`MCP_AUTH_TOKEN` (HTTP mode only):** generate with `openssl rand -hex 32` for 256 bits of entropy. Set it as a secret on your deploy host, never check into source. If it leaks: generate a new one, update both server and client config, redeploy. The token has no automatic rotation — if you want one, set up a cron job that regenerates and redeploys.
- Don't commit any `.env`. The repo's `.gitignore` excludes `.env*` (every variant, including `.env.bak*` backups) — only `.env.example` is tracked.
- Don't paste tokens into chat windows or LLM prompts outside this MCP.
- Don't put the bearer token in the URL (e.g., `?token=…`). It would end up in proxy logs, browser history, and HTTP referer headers. Always send it via the `Authorization` header.

## Disclosure timeline

I'll respond to security reports within 7 days. Critical issues will get a patch within 30 days. Coordinated disclosure preferred.
