<p align="center"><img src="assets/brand/totem.svg" width="80" alt="totem"></p>

<h1 align="center">totem</h1>

<p align="center"><b>Your WHOOP data in Claude, ChatGPT and the AI apps you already use.</b><br>
An open-source MCP server you run yourself. One command sets it up.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@thebriangao/totem"><img src="https://img.shields.io/npm/v/%40thebriangao%2Ftotem?style=flat-square&labelColor=141414&color=7A9CC6" alt="npm version"></a>
  <a href="https://github.com/thebriangao/totem/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/thebriangao/totem/ci.yml?branch=main&style=flat-square&labelColor=141414&label=tests" alt="tests"></a>
  <a href="TOOLS.md"><img src="https://img.shields.io/badge/MCP-41%20tools-7A9CC6?style=flat-square&labelColor=141414" alt="41 MCP tools"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-7A9CC6?style=flat-square&labelColor=141414" alt="Node 24 or newer">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7A9CC6?style=flat-square&labelColor=141414" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-you-can-ask">What you can ask</a> ·
  <a href="#connect-your-apps">Connect your apps</a> ·
  <a href="#hosting">Hosting</a> ·
  <a href="TOOLS.md">Tools</a> ·
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
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/totem-local-dark.svg">
    <img src="docs/media/totem-local-light.svg" width="668" alt="A terminal running totem local: it checks Node.js, logs in to WHOOP in a browser window, then adds totem to Claude Desktop, Claude Code, ChatGPT, OpenCode and Antigravity.">
  </picture>
</p>

totem connects your WHOOP account to your AI apps. Ask about last night's sleep, why your recovery is low, or how your HRV has moved this quarter. Have the app log a workout or fill in your journal.

It is a small server that speaks [MCP](https://modelcontextprotocol.io) to your apps and talks to WHOOP the way the WHOOP app does. You run it on your own computer or on a cloud server you own.

- **41 tools.** Recovery, sleep, strain, stress, heart rate, trends, workouts, Strength Trainer, journal, WHOOP Coach, weight, cycle tracking, Smart Alarm, profile and settings. [See them all](TOOLS.md).
- **Nothing changes without a yes.** Every tool that writes shows a preview first and waits for you to confirm.
- **Light on context.** A default answer is about 1.5 KB, so the tools leave room for the conversation.
- **One command.** `totem local` or `totem cloud` logs you in to WHOOP and adds totem to the AI apps it finds.

> [!NOTE]
> totem uses WHOOP's private app API, not the public developer API, and isn't affiliated with WHOOP. Read the [FAQ](#faq) before you install it.

## Quick start

You need [Node.js 24](https://nodejs.org) or newer and a WHOOP account.

**1. Install it.**

```bash
npm install -g @thebriangao/totem
```

**2. Pick where it runs.**

| | On this computer | In the cloud |
|---|---|---|
| Command | `totem local` | `totem cloud` |
| Works with | Desktop and terminal apps: Claude Desktop, Claude Code, ChatGPT desktop and Codex, Cursor, VS Code, OpenCode, Antigravity | All of those, plus claude.ai, chatgpt.com and Claude on your phone |
| Cost | Free | Free on Cloudflare, about $4 a month on Fly.io |
| Available | While your computer is on | Always |

Either command opens a browser window on WHOOP's own site for you to log in. totem never sees your password. It then finds the AI apps on your computer and offers to add itself to each one.

**3. Ask something.**

Open your app and try *"How did I sleep last night?"*

Run `totem` on its own any time to see where things stand.

### Prefer a button?

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** asks for two values: `MCP_AUTH_TOKEN` (64 random characters, for example from `openssl rand -hex 32`) and `AUTH_PASSWORD` (the password you'll type when an app connects). It runs on the free Workers plan.
- **Railway** generates both for you (they're under the service's Variables). It needs Railway's paid plan.

Then log in to WHOOP and send the login to your server:

```bash
npx @thebriangao/totem auth --url https://your-server-address
```

**Only use Claude Desktop?** Download [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb), double-click it, and log in once with `npx @thebriangao/totem auth --local`.

## What you can ask

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/chat-answer-dark.png">
    <img src="docs/media/chat-answer-light.png" width="820" alt="Claude answering “How’s my day looking?” with totem: a table of today’s recovery, sleep, strain, stress, steps and calories, then notes on last night’s sleep, today’s training and tonight’s sleep need.">
  </picture>
</p>

- "How did I sleep last night, and how does it compare to my month?"
- "Why is my recovery low today?"
- "Show my HRV and resting heart rate for the last 90 days."
- "What was my heart rate during this morning's run?"
- "Log a 30-minute walk at 6 pm."
- "I had caffeine and alcohol yesterday. Add that to my journal."
- "Log today's lift: bench press 3×5 at 80 kg, squat 3×5 at 100 kg."
- "Set a Smart Alarm for 7:30 on weekdays."

Anything that writes comes back as a preview first. Your app shows you what will change and asks before it happens.

## Connect your apps

`totem connect` sets up the apps on your computer. A cloud server also has a Connect page at `https://your-server/connect`, with a button or a copy-ready step for each app, already filled in with your server's address.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/connect-page-dark.png">
    <img src="docs/media/connect-page-light.png" width="49%" alt="The Connect page: the server's address and a card for each app, with a button or a command to copy.">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/consent-page-dark.png">
    <img src="docs/media/consent-page-light.png" width="49%" alt="The sign-in page: which app is asking, where access will be sent, the permissions, and the connector password.">
  </picture>
</p>

With a cloud server, each app sends you to totem's sign-in page once. It names the app that's asking, shows where access will go, and asks for your connector password.

<details>
<summary><b>Every app, step by step</b></summary>

<br>

| App | On this computer | With a cloud server |
|---|---|---|
| claude.ai, Claude Desktop, Claude mobile | Claude Desktop's config file | A link that opens claude.ai's "Add custom connector" filled in. It then shows up in Desktop and on your phone too |
| Claude Code | `claude mcp add` | `claude mcp add --transport http`, then `/mcp` to sign in |
| ChatGPT desktop and Codex | `codex mcp add` (they share one config) | `codex mcp add --url`, which opens the sign-in itself |
| chatgpt.com | Needs a cloud server | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | An "Add to Cursor" link |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | An "Add to VS Code" link |
| OpenCode (1 and 2) | `opencode.json` | `opencode.json`, then `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | The same file, with the server's address |

`totem connect <app>` sets up one app, and `totem connect --print` shows what it would add without touching anything.

</details>

## Hosting

`totem cloud` deploys to any of these, then checks that the server answers.

| Host | Cost | Good to know |
|---|---|---|
| **Cloudflare Workers** (recommended) | Free plan, 100,000 requests a day | No machine to look after. The login lives in a Durable Object. |
| **Fly.io** | About $4 a month for one 512 MB machine in Virginia and a 1 GB volume | Always on. At the time of writing, Fly doesn't bill personal accounts for less than $5 a month. |
| **Railway** | Railway's paid plan | A dashboard and logs in the browser. |
| **Your own server** | Yours | Any Docker host. totem writes the settings and prints the commands, or use the image `ghcr.io/thebriangao/totem`. Mount a volume at `/data`. |

Afterwards, `totem status` checks the server and its WHOOP login, `totem logs` shows its logs, and `totem deploy` sends it a new version.

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/how-it-works-dark.svg">
    <img src="docs/media/how-it-works-light.svg" width="820" alt="WHOOP talks to your totem server over WHOOP's app API. Your AI apps talk to your totem server over MCP. totem runs on your computer or your own cloud server.">
  </picture>
</p>

Your data goes from WHOOP to your totem to the app you asked, and nowhere else. There is no totem company in the middle, no shared server and no analytics.

### The WHOOP login

1. `totem auth`, which `local` and `cloud` run for you, opens a fresh browser window on app.whoop.com. You log in on WHOOP's own page, two-factor check included.
2. totem reads only WHOOP's session cookies from that window, then closes it and deletes the temporary profile.
3. The login is kept in one file that only you can read (`~/.config/totem/tokens.json`), or on your server: on its volume, or in Cloudflare Durable Object storage.
4. WHOOP replaces the refresh token every time it's used, so exactly one place owns a login. totem refreshes it on its own, every 12 hours and before it expires, and saves the new one first.

To log in again, run `totem auth`.

### Security

- **Your server, your keys.** A cloud server has two secrets of its own: `MCP_AUTH_TOKEN`, the server's key, kept in `~/.config/totem/deploy.json` on your computer, and the connector password you type when an app connects.
- **The sign-in page names the destination.** It shows the real address access goes to (claude.ai, chatgpt.com, an app on your own computer), never just the name an app claims.
- **The server talks to WHOOP and your apps, nothing else.** No telemetry, no analytics.
- **Writes need confirmation,** and `whoop_raw` writes also need `allow_write`.

More in [SECURITY.md](SECURITY.md).

## Commands

| Command | What it does |
|---|---|
| `totem` | Show where this install stands and what to run next |
| `totem local` | Run on this computer: log in, then set up your AI apps |
| `totem cloud` | Deploy your own server, log it in, connect your apps |
| `totem connect [app]` | Set up your apps again, or just one |
| `totem auth` | Log in to WHOOP (`--local`, `--url URL`, `--paste`, `--status`) |
| `totem status` / `ping` / `logs` | Check the server and its login |
| `totem deploy` | Deploy this version to your server |
| `totem update` | Update totem (`--check`, `--auto on`) |
| `totem tools` | List the 41 tools |

`totem <command> --help` explains each one.

## Troubleshooting

**The app doesn't show any WHOOP tools.** Restart it fully. For a local setup, run `totem status`. For a server, run `totem ping`.

**"No WHOOP login on this server."** Run `totem auth`. It sends the login to your server when one is set up, or saves it on this computer.

**No browser was found for the login.** totem uses Chrome, Chromium, Edge or Brave. Point it at another one with `TOTEM_BROWSER=/path/to/browser`, or run `totem auth --paste` and paste the `whoop-auth-refresh-token` cookie from a browser that's logged in to app.whoop.com.

**OpenCode or another app's config has comments.** totem doesn't rewrite files it can't read exactly. For OpenCode it lets OpenCode add the server itself. For others it prints the entry to add.

**WHOOP answers 5xx.** WHOOP is having trouble. Try again in a minute.

## FAQ

**Is this supported by WHOOP?**
No. totem uses WHOOP's private app API, which WHOOP doesn't offer to third parties, and WHOOP's terms let them act against accounts that use unsupported tools. totem's requests look like the app's and stay at a person's pace, but there is no guarantee. If losing your WHOOP account would be a problem, don't use it.

**Why not WHOOP's public API?**
It's read-only and covers a small part of the data: no journal, Strength Trainer, stress, Coach, Smart Alarm, hypnogram or trends, and no writes. If recovery, sleep totals and a workout list are enough for you, use it instead.

**Can I share my server with a friend?**
No. Each person needs their own server and their own WHOOP login. A login can't be shared, because WHOOP replaces the refresh token on every use.

**Does it work with WHOOP 4.0 and 5.0/MG?**
Yes. The API depends on your account, not your strap.

**Where does my data go?**
From WHOOP to your server to the app you asked. totem keeps no copy, only an in-memory cache of recent reads.

## Contributing

Issues and pull requests are welcome. To work on totem:

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install
npx tsc && npm link     # builds once and puts `totem` on your PATH
totem test
```

[CONTRIBUTING.md](CONTRIBUTING.md) explains how the project is laid out, and [WHOOP.md](WHOOP.md) documents what is known about WHOOP's API.

## Acknowledgments

Thanks to everyone who opened issues and pull requests for v1 and v2, to [Anthropic](https://anthropic.com) for MCP, and to the people who documented pieces of WHOOP's API over the years.

## License

[MIT](LICENSE). "WHOOP" is a trademark of WHOOP, Inc. totem is an independent project and is not affiliated with, endorsed by or connected to WHOOP.
