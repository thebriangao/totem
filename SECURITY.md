# Security policy

## Reporting a vulnerability

Email **briangaoo2@gmail.com** with the subject `[totem security]`. Please don't open a public issue for a security report. I'll answer within 7 days, and fix critical issues within 30. Coordinated disclosure is welcome.

For other bugs, [open an issue](https://github.com/thebriangao/totem/issues).

## What totem holds

A totem server holds a login to one WHOOP account and can read and change that account's data. Treat the machine it runs on, and its token file, like a logged-in WHOOP app.

- **The WHOOP login** is an access token (about 24 hours) and a refresh token. It lives in one file readable only by its owner: `~/.config/totem/tokens.json` on your computer (`TOTEM_TOKEN_FILE` to move it), `/data/tokens.json` on a server's volume, or the Durable Object's storage on Cloudflare. No WHOOP email or password is ever stored or typed into totem: you log in on WHOOP's own site in a browser window totem opened, and totem reads only the session cookies.
- **On a server**, two more secrets: `MCP_AUTH_TOKEN` (the server's own key) and `AUTH_PASSWORD` (the connector password people type when an app connects). `totem cloud` keeps the token in `.totem-deploy.json` (mode 0600) on your computer and shows the password once.

## What it doesn't do

- No telemetry, analytics or remote logging. The only outgoing traffic is HTTPS to `api.prod.whoop.com` (and, on Cloudflare, nothing else).
- No data kept beyond the login and a bounded in-memory cache of recent reads (memory only, never written to disk or logged, dropped on any write).
- One server, one WHOOP account. There is no multi-user mode.

## What counts as a security issue

- A secret leaking: the login, `MCP_AUTH_TOKEN`, the connector password or an OAuth token in a log, an error, a command line or a file others can read.
- A request to `/mcp` or `/admin/tokens` succeeding without a valid token, or a timing side channel on the comparison.
- A write that happens without `confirm: true` (or a `whoop_raw` write without `allow_write`).
- The consent page naming the wrong destination, or a code going somewhere it doesn't name.
- Data sent anywhere other than the app that asked.

Not a security issue (open a normal issue): wrong or empty data, a WHOOP API change that breaks a tool, a 4xx or 5xx from WHOOP.

## Threat model

**On your computer** (the app starts `totem start` itself, over stdio), the attack surface is your own machine. Anyone who can read your token file can use your WHOOP account.

**On a server** (Fly, Railway, Cloudflare, your own host), there is also a public URL:

- `/mcp` needs either `MCP_AUTH_TOKEN` as a bearer token or an OAuth access token. Comparisons are constant time and length-checked first. A refused request gets `401` with `WWW-Authenticate` pointing at the protected-resource metadata (RFC 9728), so apps can find the sign-in.
- `/admin/tokens` (where `totem auth` sends a login) takes only `MCP_AUTH_TOKEN`, checks it before reading a body, never logs a failed push, and `totem auth` sends to it over HTTPS only and never follows a redirect with it.
- **Sign-in (OAuth 2.1 with PKCE)** is on when `AUTH_PASSWORD` is set. Apps register themselves (dynamic client registration); a registered client id is a signed token holding its redirect addresses. Access and refresh tokens are HS256 JWTs signed with a key derived from `MCP_AUTH_TOKEN`, bound to this server's `/mcp` address (RFC 8707). Authorization codes live 60 seconds, in memory. Rotating `MCP_AUTH_TOKEN` signs every app out.
- **The consent page** asks for the connector password before any code is issued. It names a website only by the address the code is actually sent to (claude.ai, chatgpt.com, vscode.dev, cursor.com, antigravity.google), never by the name a client registered with, so a link that would send your data elsewhere can't call itself Claude. An app on your own computer (a loopback address) is shown by its registered name, because nobody else can receive a code there. The page loads no scripts and nothing from elsewhere (a strict Content-Security-Policy allows its own style and typeface only), refuses framing, and limits wrong passwords per address and across all addresses.
- **The Connect page** (`/connect`) is public, like `/health`. It shows only the server's own address and links to add it to apps; nothing secret.
- **Whoever runs the host can read the login.** The host's operator can read its secrets, its volume and its memory. Deploy only where you trust the operator.
- **HTTPS is required.** Every supported host gives you HTTPS; on your own server, put it behind a TLS proxy.

**Everywhere:**

- totem trusts the AI app you connect: it can call any tool. Previews (`confirm: false` by default) protect against mistakes, not against a hostile app. To remove a tool, take it out of `src/tools/register.ts` and rebuild.
- WHOOP rotates the refresh token on every use, so one process owns a login. A lock file decides the owner on a computer; on Cloudflare there is exactly one Durable Object. A rotated token is saved before it is used.
- Tool inputs are validated before anything is sent to WHOOP. `whoop_raw` writes go through a denylist matched on the canonical path.

## Keeping secrets safe

- Generate `MCP_AUTH_TOKEN` with `openssl rand -hex 32`, set it only as a secret on the host, and never put it in a URL. If it leaks, set a new one and deploy again; every app then signs in again.
- If your WHOOP login may have leaked, change your WHOOP password on WHOOP's site, then run `totem auth` for a fresh login.
- Never commit `.env*`, `.totem-deploy.json` or a token file; `.gitignore` excludes them. totem 2 keeps its own records (`deploy.json`, `fly.toml`, `deploy.env`) in `~/.config/totem/`, outside the checkout.
