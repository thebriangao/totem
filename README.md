<h1 align="center">totem</h1>

<p align="center"><b>Your own WHOOP server for AI apps.</b><br>
Ask Claude, ChatGPT, Cursor or any MCP app about your recovery, sleep and training, and let it log workouts, journal answers and more.</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#connect-your-apps">Connect your apps</a> ·
  <a href="#hosting">Hosting</a> ·
  <a href="TOOLS.md">The 40 tools</a> ·
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  English ·
  <a href="docs/i18n/README.zh-CN.md">简体中文</a> ·
  <a href="docs/i18n/README.ja.md">日本語</a> ·
  <a href="docs/i18n/README.ko.md">한국어</a> ·
  <a href="docs/i18n/README.es.md">Español</a> ·
  <a href="docs/i18n/README.pt-BR.md">Português</a> ·
  <a href="docs/i18n/README.fr.md">Français</a> ·
  <a href="docs/i18n/README.de.md">Deutsch</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-40-6f6e6a?style=flat-square" alt="40 tools">
  <img src="https://img.shields.io/badge/Node-24%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 24+">
  <img src="https://img.shields.io/badge/MCP-Streamable_HTTP_%2B_stdio-6f6e6a?style=flat-square" alt="MCP">
  <img src="https://img.shields.io/badge/license-MIT-6f6e6a?style=flat-square" alt="MIT">
</p>

---

totem is a small open-source [MCP](https://modelcontextprotocol.io) server that talks to WHOOP the way the WHOOP app does. You run it yourself, on your computer or on a cloud server you own, and your AI apps connect to it. Your data goes only between WHOOP, your server and the apps you connect.

- **40 tools.** Recovery, sleep stages, strain, stress, heart rate, trends, workouts, Strength Trainer, journal, WHOOP Coach, weight, cycle tracking, Smart Alarm, profile and settings. [The full list](TOOLS.md).
- **Writes are safe by default.** Every tool that changes something shows a preview first and does nothing until the app confirms.
- **Small answers.** Tools return compact data (about 1.5 KB for a default call), so they don't eat your context window.
- **One-command setup.** `totem local` or `totem cloud` logs you in to WHOOP and sets up every AI app it finds.

> [!NOTE]
> totem uses WHOOP's private app API, not the public developer API, and isn't affiliated with WHOOP. Read the [FAQ](#faq) before you install it.

## Get started

You need [Node.js 24](https://nodejs.org) or newer and a WHOOP account.

```bash
npm install -g @thebriangao/totem
```

Then pick where totem runs:

| | Run it on this computer | Run it in the cloud |
|---|---|---|
| Command | `totem local` | `totem cloud` |
| Works with | Desktop and terminal apps: Claude Desktop, Claude Code, ChatGPT desktop and Codex, Cursor, VS Code, OpenCode, Antigravity | Everything, including claude.ai, chatgpt.com and the phone apps |
| Cost | Free | Free on Cloudflare, about $4 a month on Fly.io |
| Stays on | While your computer is on | Always |

Both commands open a browser window on WHOOP's own site for you to log in (totem never sees your password), then find the AI apps on your computer and set each one up. Then ask your app something like *"How did I sleep last night?"*

### One click

If you'd rather not use a terminal for the server:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** asks for two values: `MCP_AUTH_TOKEN` (64 random characters, for example from `openssl rand -hex 32`) and `AUTH_PASSWORD` (the password you'll type when an app connects). It runs on the free Workers plan.
- **Railway** generates both for you (find them under the service's Variables). It needs Railway's paid plan.
- Either way, finish with one command that logs you in to WHOOP and sends the login to your server:

  ```bash
  npx @thebriangao/totem auth --url https://your-server-address
  ```

**Claude Desktop only:** download [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) and double-click it. Log in once with `npx @thebriangao/totem auth --local`.

## Connect your apps

`totem connect` sets up every app it finds on your computer. A cloud server also has a **Connect page** at `https://your-server/connect`, with a button or a copy-ready step for each app, already filled in with your server's address.

| App | On this computer | With a cloud server |
|---|---|---|
| claude.ai, Claude Desktop, Claude mobile | Claude Desktop's config file | A link that opens claude.ai's "Add custom connector" filled in; it then shows up in Desktop and on your phone too |
| Claude Code | `claude mcp add` | `claude mcp add --transport http`, then `/mcp` to sign in |
| ChatGPT desktop and Codex | `codex mcp add` (they share one config) | `codex mcp add --url` opens the sign-in itself |
| chatgpt.com | (needs a cloud server) | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | An "Add to Cursor" link |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | An "Add to VS Code" link |
| OpenCode (1 and 2) | `opencode.json` | `opencode.json`, then `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | The same file, with the server's address |

With a cloud server, each app sends you to totem's sign-in page once. It shows which app is asking and where access goes, and asks for your connector password.

## Hosting

`totem cloud` deploys to any of these and checks the server afterwards:

| Host | Cost | Notes |
|---|---|---|
| **Fly.io** (recommended) | About $4 a month: one 512 MB machine in Virginia and a 1 GB volume | Always on. At the time of writing Fly doesn't bill personal accounts for less than $5 a month. |
| **Cloudflare Workers** | Free plan (100,000 requests a day) | No machine to look after. The login lives in a Durable Object. |
| **Railway** | Railway's paid plan | A dashboard and logs in the browser. |
| **Your own server** | Yours | Any Docker host. Use the image `ghcr.io/thebriangao/totem` or build the Dockerfile, and mount a volume at `/data`. |

After a deploy, `totem status` checks the server and its WHOOP login, `totem logs` shows its logs, and `totem deploy` sends it a new version.

## What you can ask

- "How did I sleep last night, and how does it compare to my month?"
- "Why is my recovery low today?"
- "Show my HRV and resting heart rate for the last 90 days."
- "What was my heart rate during this morning's run?"
- "Log a 30-minute walk at 6 pm."
- "I had caffeine and alcohol yesterday. Add that to my journal."
- "Log today's lift: bench press 3×5 at 80 kg, squat 3×5 at 100 kg."
- "Set a Smart Alarm for 7:30 on weekdays."

Every write comes back as a preview first. Your app shows you what will change and asks before it happens.

## How the login works

1. `totem auth` (which `local` and `cloud` run for you) opens a fresh browser window on app.whoop.com. You log in there, with WHOOP's own page and two-factor check.
2. totem reads only WHOOP's session cookies from that window, then closes it and deletes the temporary profile.
3. The login is kept in one file readable only by you (`~/.config/totem/tokens.json`), or on your server: on its volume, or in Cloudflare Durable Object storage.
4. WHOOP replaces the refresh token every time it's used, so exactly one place owns a login. totem refreshes it on its own, every 12 hours and before it expires, and saves the new one first.

Logging in again is the same command: `totem auth`. On a server you can check it with `totem status`.

## Security

- **Your server, your keys.** A cloud server has two secrets of its own: `MCP_AUTH_TOKEN` (the server's key, kept in `.totem-deploy.json` on your computer) and the connector password you type when an app connects.
- **The sign-in page names the destination.** It shows the real address access goes to (claude.ai, chatgpt.com, an app on your own computer), never just the name an app claims.
- **Nothing else is contacted.** The only outgoing traffic is to WHOOP. No telemetry, no analytics.
- **Writes need confirmation,** and `whoop_raw` writes also need `allow_write`.

More in [SECURITY.md](SECURITY.md).

## Commands

| Command | What it does |
|---|---|
| `totem local` | Run on this computer: log in, then set up your AI apps |
| `totem cloud` | Deploy your own server, log it in, connect your apps |
| `totem connect [app]` | Set up your apps again, or one of them (`totem connect --print` shows the config instead) |
| `totem auth` | Log in to WHOOP (`--local`, `--url URL`, `--paste`, `--status`) |
| `totem status` / `ping` / `logs` | Check the server and its login |
| `totem deploy` | Deploy this version to your server |
| `totem update` | Update totem (`--check`, `--auto on`) |
| `totem tools` | List the 40 tools |

`totem <command> --help` explains each one.

## Troubleshooting

**The app doesn't show any WHOOP tools.** Restart it fully. For a local setup, run `totem status`; for a server, `totem ping`.

**"No WHOOP login on this server."** Run `totem auth`. It sends the login to your server when one is set up, or saves it on this computer.

**No browser was found for the login.** totem uses Chrome, Chromium, Edge or Brave. Point it at another one with `TOTEM_BROWSER=/path/to/browser`, or run `totem auth --paste` and paste the `whoop-auth-refresh-token` cookie from a browser that's logged in to app.whoop.com.

**OpenCode or another app's config has comments.** totem doesn't rewrite files it can't read exactly. For OpenCode it lets OpenCode add the server itself; for others it prints the entry to add.

**WHOOP answers 5xx.** WHOOP is having trouble. Try again in a minute.

## FAQ

**Is this supported by WHOOP?**
No. totem uses WHOOP's private app API, which WHOOP doesn't offer to third parties, and WHOOP's terms let them act against accounts that use unsupported tools. totem's requests look like the app's and stay at a person's pace, but there is no guarantee. If losing your WHOOP account would be a problem, don't use it.

**Why not WHOOP's public API?**
It's read-only and covers a small part of the data: no journal, Strength Trainer, stress, Coach, Smart Alarm, hypnogram or trends, and no writes. If recovery, sleep totals and a workout list are enough for you, use it instead.

**Can I share my server with a friend?**
Each person needs their own server and their own WHOOP login. A login can't be shared: WHOOP replaces the refresh token on every use.

**Does it work with WHOOP 4.0 and 5.0/MG?**
Yes. The API depends on your account, not your strap.

**Where does my data go?**
From WHOOP to your server to the app you asked. totem keeps no copy, only a short in-memory cache of recent reads.

## Development

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install && npx tsc
totem test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the project is laid out and [WHOOP.md](WHOOP.md) for what is known about WHOOP's API.

## Acknowledgments

Thanks to everyone who opened issues and pull requests for v1 and v2, to [Anthropic](https://anthropic.com) for MCP, and to the people who documented pieces of WHOOP's API over the years.

"WHOOP" is a trademark of WHOOP, Inc. totem is an independent project and is not affiliated with, endorsed by or connected to WHOOP. MIT licensed.
