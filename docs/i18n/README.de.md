<p align="center"><img src="../../assets/brand/totem.svg" width="80" alt="totem"></p>

<h1 align="center">totem</h1>

<p align="center"><b>Deine WHOOP-Daten in Claude, ChatGPT und den KI-Apps, die du schon nutzt.</b><br>
Ein Open-Source-MCP-Server, den du selbst betreibst. Ein Befehl richtet alles ein.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@thebriangao/totem"><img src="https://img.shields.io/npm/v/%40thebriangao%2Ftotem?style=flat-square&labelColor=141414&color=7A9CC6" alt="npm version"></a>
  <a href="https://github.com/thebriangao/totem/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/thebriangao/totem/ci.yml?branch=main&style=flat-square&labelColor=141414&label=tests" alt="tests"></a>
  <a href="../../TOOLS.md"><img src="https://img.shields.io/badge/MCP-41%20tools-7A9CC6?style=flat-square&labelColor=141414" alt="41 MCP tools"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-7A9CC6?style=flat-square&labelColor=141414" alt="Node 24 or newer">
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-7A9CC6?style=flat-square&labelColor=141414" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#schnellstart">Schnellstart</a> ·
  <a href="#was-du-fragen-kannst">Was du fragen kannst</a> ·
  <a href="#apps-verbinden">Apps verbinden</a> ·
  <a href="#hosting">Hosting</a> ·
  <a href="../../TOOLS.md">Tools</a> ·
  <a href="#häufige-fragen">Häufige Fragen</a>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.fr.md">Français</a> ·
  Deutsch
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/totem-local-dark.svg">
    <img src="../media/totem-local-light.svg" width="668" alt="Ein Terminal, in dem totem local läuft: Es prüft Node.js, meldet sich in einem Browserfenster bei WHOOP an und fügt totem dann zu Claude Desktop, Claude Code, ChatGPT, OpenCode und Antigravity hinzu.">
  </picture>
</p>

totem verbindet dein WHOOP-Konto mit deinen KI-Apps. Frag nach dem Schlaf der letzten Nacht, warum deine Erholung niedrig ist oder wie sich deine HRV in diesem Quartal entwickelt hat. Lass die App ein Workout eintragen oder dein Tagebuch ausfüllen.

Es ist ein kleiner Server, der mit deinen Apps über [MCP](https://modelcontextprotocol.io) spricht und mit WHOOP so wie die WHOOP-App. Du betreibst ihn auf deinem Computer oder auf einem Cloud-Server, der dir gehört.

- **41 Tools.** Erholung, Schlaf, Belastung, Stress, Herzfrequenz, Trends, Workouts, Strength Trainer, Tagebuch, WHOOP Coach, Gewicht, Zyklus-Tracking, Smart Alarm, Profil und Einstellungen. [Alle ansehen](../../TOOLS.md).
- **Nichts ändert sich ohne dein Ja.** Jedes Tool, das schreibt, zeigt zuerst eine Vorschau und wartet auf deine Bestätigung.
- **Schont den Kontext.** Eine normale Antwort ist etwa 1,5 KB groß, so bleibt Platz für das Gespräch.
- **Ein Befehl.** `totem local` oder `totem cloud` meldet dich bei WHOOP an und fügt totem zu den KI-Apps hinzu, die es findet.

> [!NOTE]
> totem nutzt die private API der WHOOP-App, nicht die öffentliche Entwickler-API, und steht in keiner Verbindung zu WHOOP. Lies vor der Installation die [häufigen Fragen](#häufige-fragen).

## Schnellstart

Du brauchst [Node.js 24](https://nodejs.org) oder neuer und ein WHOOP-Konto.

**1. Installieren.**

```bash
npm install -g @thebriangao/totem
```

**2. Wähle, wo totem läuft.**

| | Auf diesem Computer | In der Cloud |
|---|---|---|
| Befehl | `totem local` | `totem cloud` |
| Funktioniert mit | Desktop- und Terminal-Apps: Claude Desktop, Claude Code, ChatGPT für den Desktop und Codex, Cursor, VS Code, OpenCode, Antigravity | All diesen Apps, dazu claude.ai, chatgpt.com und Claude auf deinem Handy |
| Kosten | Kostenlos | Kostenlos bei Cloudflare, etwa 4 $ im Monat bei Fly.io |
| Erreichbar | Solange dein Computer an ist | Immer |

Beide Befehle öffnen ein Browserfenster auf der WHOOP-Website, in dem du dich anmeldest. totem sieht dein Passwort nie. Danach sucht es die KI-Apps auf deinem Computer und bietet an, sich zu jeder hinzuzufügen.

**3. Frag etwas.**

Öffne deine App und probier es mit *„Wie habe ich letzte Nacht geschlafen?“*

Mit `totem` allein siehst du jederzeit, wie der Stand ist.

### Lieber per Knopfdruck?

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** fragt nach zwei Werten: `MCP_AUTH_TOKEN` (64 zufällige Zeichen, zum Beispiel die Ausgabe von `openssl rand -hex 32`) und `AUTH_PASSWORD` (das Passwort, das du eingibst, wenn sich eine App verbindet). Es läuft im kostenlosen Workers-Tarif.
- **Railway** erzeugt beide für dich (du findest sie in den Variables des Service). Dafür brauchst du Railways Bezahltarif.

Danach meldest du dich bei WHOOP an und schickst die Anmeldung an deinen Server:

```bash
npx @thebriangao/totem auth --url https://your-server-address
```

**Du nutzt nur Claude Desktop?** Lade [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) herunter, öffne die Datei per Doppelklick und melde dich einmal mit `npx @thebriangao/totem auth --local` an.

## Was du fragen kannst

- „Wie habe ich letzte Nacht geschlafen, und wie war das im Vergleich zum Monat?“
- „Warum ist meine Erholung heute niedrig?“
- „Zeig mir meine HRV und meinen Ruhepuls der letzten 90 Tage.“
- „Wie hoch war meine Herzfrequenz beim Lauf heute Morgen?“
- „Trag einen 30-minütigen Spaziergang um 18 Uhr ein.“
- „Ich hatte gestern Koffein und Alkohol. Trag das in mein Tagebuch ein.“
- „Trag das heutige Training ein: Bankdrücken 3×5 mit 80 kg, Kniebeugen 3×5 mit 100 kg.“
- „Stell einen Smart Alarm für 7:30 Uhr an Werktagen.“

Alles, was schreibt, kommt zuerst als Vorschau zurück. Deine App zeigt dir, was sich ändern wird, und fragt, bevor es passiert.

## Apps verbinden

`totem connect` richtet die Apps auf deinem Computer ein. Ein Cloud-Server hat außerdem eine Connect-Seite unter `https://your-server/connect`, mit einem Button oder einem Schritt zum Kopieren für jede App, in dem die Adresse deines Servers schon eingetragen ist.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/connect-page-dark.png">
    <img src="../media/connect-page-light.png" width="49%" alt="Die Connect-Seite: die Adresse des Servers und eine Karte pro App, mit einem Button oder einem Befehl zum Kopieren.">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/consent-page-dark.png">
    <img src="../media/consent-page-light.png" width="49%" alt="Die Anmeldeseite: welche App anfragt, wohin der Zugriff geht, die Berechtigungen und das Verbindungspasswort.">
  </picture>
</p>

Mit einem Cloud-Server schickt dich jede App einmal auf die Anmeldeseite von totem. Sie nennt die App, die anfragt, zeigt, wohin der Zugriff geht, und fragt nach deinem Verbindungspasswort.

<details>
<summary><b>Alle Apps, Schritt für Schritt</b></summary>

<br>

| App | Auf diesem Computer | Mit einem Cloud-Server |
|---|---|---|
| claude.ai, Claude Desktop, Claude auf dem Handy | Die Konfigurationsdatei von Claude Desktop | Ein Link, der „Add custom connector“ auf claude.ai fertig ausgefüllt öffnet. Danach erscheint es auch in Desktop und auf deinem Handy |
| Claude Code | `claude mcp add` | `claude mcp add --transport http`, dann `/mcp` zum Anmelden |
| ChatGPT für den Desktop und Codex | `codex mcp add` (sie teilen sich eine Konfiguration) | `codex mcp add --url`, das die Anmeldung selbst öffnet |
| chatgpt.com | Braucht einen Cloud-Server | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | Ein „Add to Cursor“-Link |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | Ein „Add to VS Code“-Link |
| OpenCode (1 und 2) | `opencode.json` | `opencode.json`, dann `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | Dieselbe Datei, mit der Adresse des Servers |

`totem connect <app>` richtet eine einzelne App ein, und `totem connect --print` zeigt, was es hinzufügen würde, ohne etwas anzufassen.

</details>

## Hosting

`totem cloud` deployt zu jedem dieser Anbieter und prüft danach, ob der Server antwortet.

| Anbieter | Kosten | Gut zu wissen |
|---|---|---|
| **Cloudflare Workers** (empfohlen) | Kostenloser Tarif, 100.000 Anfragen pro Tag | Keine Maschine, um die du dich kümmern musst. Die Anmeldung liegt in einem Durable Object. |
| **Fly.io** | Etwa 4 $ im Monat für eine 512-MB-Maschine in Virginia und ein 1-GB-Volume | Immer an. Zum Zeitpunkt des Schreibens stellt Fly Privatkonten unter 5 $ im Monat nichts in Rechnung. |
| **Railway** | Railways Bezahltarif | Dashboard und Logs im Browser. |
| **Dein eigener Server** | Deine Sache | Jeder Docker-Host. totem schreibt die Einstellungen und gibt die Befehle aus, oder du nimmst das Image `ghcr.io/thebriangao/totem`. Binde ein Volume unter `/data` ein. |

Danach prüft `totem status` den Server und seine WHOOP-Anmeldung, `totem logs` zeigt seine Logs, und `totem deploy` schickt ihm eine neue Version.

## So funktioniert es

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/how-it-works-dark.svg">
    <img src="../media/how-it-works-light.svg" width="820" alt="WHOOP spricht mit deinem totem-Server über die App-API von WHOOP. Deine KI-Apps sprechen mit deinem totem-Server über MCP. totem läuft auf deinem Computer oder auf deinem eigenen Cloud-Server.">
  </picture>
</p>

Deine Daten gehen von WHOOP zu deinem totem und von dort zu der App, die du gefragt hast, und nirgendwohin sonst. Es gibt keine totem-Firma dazwischen, keinen geteilten Server und keine Analytics.

### Die WHOOP-Anmeldung

1. `totem auth`, das `local` und `cloud` für dich starten, öffnet ein neues Browserfenster auf app.whoop.com. Du meldest dich auf der Seite von WHOOP an, inklusive Zwei-Faktor-Prüfung.
2. totem liest aus diesem Fenster nur die Sitzungscookies von WHOOP, schließt es dann und löscht das temporäre Profil.
3. Die Anmeldung liegt in einer Datei, die nur du lesen kannst (`~/.config/totem/tokens.json`), oder auf deinem Server: auf seinem Volume oder im Speicher eines Cloudflare Durable Object.
4. WHOOP ersetzt das Refresh-Token bei jeder Nutzung, deshalb kann eine Anmeldung nur an einem Ort liegen. totem erneuert sie selbstständig, alle 12 Stunden und bevor sie abläuft, und speichert das neue Token immer zuerst.

Um dich neu anzumelden, führe `totem auth` aus.

### Sicherheit

- **Dein Server, deine Schlüssel.** Ein Cloud-Server hat zwei eigene Geheimnisse: `MCP_AUTH_TOKEN`, den Schlüssel des Servers, der in `~/.config/totem/deploy.json` auf deinem Computer liegt, und das Verbindungspasswort, das du eingibst, wenn sich eine App verbindet.
- **Die Anmeldeseite nennt das Ziel.** Sie zeigt die echte Adresse, an die der Zugriff geht (claude.ai, chatgpt.com, eine App auf deinem eigenen Computer), nie nur den Namen, den eine App angibt.
- **Der Server spricht mit WHOOP und deinen Apps, mit sonst niemandem.** Keine Telemetrie, keine Analytics.
- **Schreibzugriffe brauchen eine Bestätigung,** und die von `whoop_raw` brauchen zusätzlich `allow_write`.

Mehr dazu in [SECURITY.md](../../SECURITY.md).

## Befehle

| Befehl | Was er tut |
|---|---|
| `totem` | Zeigt, wie es um diese Installation steht und was als Nächstes dran ist |
| `totem local` | Läuft auf diesem Computer: meldet dich an und richtet deine KI-Apps ein |
| `totem cloud` | Deployt deinen eigenen Server, meldet ihn an und verbindet deine Apps |
| `totem connect [app]` | Richtet deine Apps noch einmal ein, oder nur eine |
| `totem auth` | Meldet dich bei WHOOP an (`--local`, `--url URL`, `--paste`, `--status`) |
| `totem status` / `ping` / `logs` | Prüft den Server und seine Anmeldung |
| `totem deploy` | Deployt diese Version auf deinen Server |
| `totem update` | Aktualisiert totem (`--check`, `--auto on`) |
| `totem tools` | Listet die 41 Tools auf |

`totem <command> --help` erklärt jeden Befehl.

## Fehlerbehebung

**Die App zeigt keine WHOOP-Tools.** Starte sie komplett neu. Bei einer lokalen Einrichtung führst du `totem status` aus, bei einem Server `totem ping`.

**"No WHOOP login on this server."** Führe `totem auth` aus. Es schickt die Anmeldung an deinen Server, wenn einer eingerichtet ist, oder speichert sie auf diesem Computer.

**Für die Anmeldung wurde kein Browser gefunden.** totem nutzt Chrome, Chromium, Edge oder Brave. Mit `TOTEM_BROWSER=/path/to/browser` gibst du einen anderen an. Oder du führst `totem auth --paste` aus und fügst das Cookie `whoop-auth-refresh-token` aus einem Browser ein, der bei app.whoop.com angemeldet ist.

**Die Konfiguration von OpenCode oder einer anderen App enthält Kommentare.** totem schreibt keine Dateien um, die es nicht exakt lesen kann. Bei OpenCode lässt es OpenCode den Server selbst hinzufügen. Bei anderen gibt es den Eintrag aus, den du hinzufügen musst.

**WHOOP antwortet mit 5xx.** WHOOP hat gerade Probleme. Versuch es in einer Minute noch einmal.

## Häufige Fragen

**Unterstützt WHOOP das?**
Nein. totem nutzt die private API der WHOOP-App, die WHOOP Dritten nicht anbietet, und laut den Bedingungen von WHOOP kann WHOOP gegen Konten vorgehen, die inoffizielle Tools nutzen. Die Anfragen von totem sehen aus wie die der App und bleiben im Tempo eines Menschen, aber es gibt keine Garantie. Wenn der Verlust deines WHOOP-Kontos ein Problem wäre, nutze es nicht.

**Warum nicht die öffentliche API von WHOOP?**
Sie kann nur lesen und deckt einen kleinen Teil der Daten ab: kein Tagebuch, kein Strength Trainer, kein Stress, kein Coach, kein Smart Alarm, kein Hypnogramm, keine Trends und keine Schreibzugriffe. Wenn dir Erholung, Schlafsummen und eine Liste deiner Workouts reichen, nimm sie.

**Kann ich meinen Server mit Freunden teilen?**
Nein. Jede Person braucht einen eigenen Server und eine eigene WHOOP-Anmeldung. Eine Anmeldung lässt sich nicht teilen, weil WHOOP das Refresh-Token bei jeder Nutzung ersetzt.

**Funktioniert es mit WHOOP 4.0 und 5.0/MG?**
Ja. Die API hängt von deinem Konto ab, nicht von deinem Armband.

**Wohin gehen meine Daten?**
Von WHOOP zu deinem Server und von dort zu der App, die du gefragt hast. totem behält keine Kopie, nur einen Cache im Arbeitsspeicher mit den letzten Abfragen.

## Mitmachen

Issues und Pull Requests sind willkommen. So arbeitest du an totem:

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install
npx tsc && npm link     # baut einmal und legt `totem` in deinen PATH
totem test
```

[CONTRIBUTING.md](../../CONTRIBUTING.md) erklärt, wie das Projekt aufgebaut ist, und [WHOOP.md](../../WHOOP.md) dokumentiert, was über die API von WHOOP bekannt ist.

## Danksagung

Danke an alle, die Issues und Pull Requests für v1 und v2 geöffnet haben, an [Anthropic](https://anthropic.com) für MCP und an die Menschen, die über die Jahre Teile der WHOOP-API dokumentiert haben.

## Lizenz

[MIT](../../LICENSE). „WHOOP“ ist eine Marke von WHOOP, Inc. totem ist ein unabhängiges Projekt, das weder mit WHOOP verbunden ist noch von WHOOP unterstützt wird.
