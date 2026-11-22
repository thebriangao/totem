<h1 align="center">totem</h1>

<p align="center"><b>Dein eigener WHOOP-Server für KI-Apps.</b><br>
Frag Claude, ChatGPT, Cursor oder jede andere MCP-App nach deiner Erholung, deinem Schlaf und deinem Training, und lass sie Workouts, Tagebuchantworten und mehr eintragen.</p>

<p align="center">
  <a href="#los-gehts">Los geht's</a> ·
  <a href="#apps-verbinden">Apps verbinden</a> ·
  <a href="#hosting">Hosting</a> ·
  <a href="../../TOOLS.md">Die 40 Tools</a> ·
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

---

totem ist ein kleiner Open-Source-[MCP](https://modelcontextprotocol.io)-Server, der mit WHOOP so spricht wie die WHOOP-App. Du betreibst ihn selbst, auf deinem Computer oder auf einem Cloud-Server, der dir gehört, und deine KI-Apps verbinden sich damit. Deine Daten fließen nur zwischen WHOOP, deinem Server und den Apps, die du verbindest.

- **40 Tools.** Erholung, Schlafphasen, Belastung, Stress, Herzfrequenz, Trends, Workouts, Strength Trainer, Tagebuch, WHOOP Coach, Gewicht, Zyklus-Tracking, Smart Alarm, Profil und Einstellungen. [Die vollständige Liste](../../TOOLS.md).
- **Schreiben ist standardmäßig sicher.** Jedes Tool, das etwas ändert, zeigt zuerst eine Vorschau und tut nichts, bis die App bestätigt.
- **Kleine Antworten.** Die Tools liefern kompakte Daten (etwa 1,5 KB bei einem Standardaufruf) und belegen deinen Kontext nicht unnötig.
- **Ein Befehl genügt.** `totem local` oder `totem cloud` meldet dich bei WHOOP an und richtet jede KI-App ein, die es findet.

> [!NOTE]
> totem nutzt die private API der WHOOP-App, nicht die öffentliche Entwickler-API, und steht in keiner Verbindung zu WHOOP. Lies vor der Installation die [häufigen Fragen](#häufige-fragen).

## Los geht's

Du brauchst [Node.js 24](https://nodejs.org) oder neuer und ein WHOOP-Konto.

```bash
npm install -g @thebriangao/totem
```

Dann wählst du, wo totem läuft:

| | Auf diesem Computer | In der Cloud |
|---|---|---|
| Befehl | `totem local` | `totem cloud` |
| Funktioniert mit | Desktop- und Terminal-Apps: Claude Desktop, Claude Code, ChatGPT für den Desktop und Codex, Cursor, VS Code, OpenCode, Antigravity | Allem, auch claude.ai, chatgpt.com und den Handy-Apps |
| Kosten | Kostenlos | Kostenlos bei Cloudflare, etwa 4 $ im Monat bei Fly.io |
| Erreichbar | Solange dein Computer an ist | Immer |

Beide Befehle öffnen ein Browserfenster auf der WHOOP-Website, in dem du dich anmeldest (totem sieht dein Passwort nie), finden dann die KI-Apps auf deinem Computer und richten jede davon ein. Danach fragst du deine App zum Beispiel *„Wie habe ich letzte Nacht geschlafen?"*

### Mit einem Klick

Wenn du für den Server kein Terminal benutzen möchtest:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** fragt nach zwei Werten: `MCP_AUTH_TOKEN` (64 zufällige Zeichen, zum Beispiel die Ausgabe von `openssl rand -hex 32`) und `AUTH_PASSWORD` (das Passwort, das du eingibst, wenn sich eine App verbindet). Es läuft im kostenlosen Workers-Tarif.
- **Railway** erzeugt beide für dich (zu finden unter den Variables des Dienstes). Dafür brauchst du den kostenpflichtigen Tarif von Railway.
- In beiden Fällen schließt du mit einem Befehl ab, der dich bei WHOOP anmeldet und die Anmeldung an deinen Server schickt:

  ```bash
  npx @thebriangao/totem auth --url https://your-server-address
  ```

**Nur Claude Desktop:** Lade [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) herunter und doppelklicke darauf. Melde dich einmal mit `npx @thebriangao/totem auth --local` an.

## Apps verbinden

`totem connect` richtet jede App ein, die es auf deinem Computer findet. Ein Cloud-Server hat außerdem eine **Connect-Seite** unter `https://your-server/connect`, mit einem Button oder einem kopierfertigen Schritt für jede App, schon mit der Adresse deines Servers ausgefüllt.

| App | Auf diesem Computer | Mit einem Cloud-Server |
|---|---|---|
| claude.ai, Claude Desktop, Claude mobil | Die Konfigurationsdatei von Claude Desktop | Ein Link, der „Add custom connector" in claude.ai ausgefüllt öffnet; danach erscheint er auch in Desktop und auf dem Handy |
| Claude Code | `claude mcp add` | `claude mcp add --transport http`, dann `/mcp` zum Anmelden |
| ChatGPT für den Desktop und Codex | `codex mcp add` (gemeinsame Konfiguration) | `codex mcp add --url` öffnet die Anmeldung selbst |
| chatgpt.com | (braucht einen Cloud-Server) | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | Ein „Add to Cursor"-Link |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | Ein „Add to VS Code"-Link |
| OpenCode (1 und 2) | `opencode.json` | `opencode.json`, dann `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | Dieselbe Datei, mit der Adresse des Servers |

Mit einem Cloud-Server schickt dich jede App einmal auf die Anmeldeseite von totem. Sie zeigt, welche App fragt und wohin der Zugriff geht, und fragt nach deinem Verbindungspasswort.

## Hosting

`totem cloud` deployt auf jeden dieser Anbieter und prüft den Server danach:

| Anbieter | Kosten | Hinweise |
|---|---|---|
| **Fly.io** (empfohlen) | Etwa 4 $ im Monat: eine 512-MB-Maschine in Virginia und ein 1-GB-Volume | Immer an. Zum Zeitpunkt des Schreibens berechnet Fly persönlichen Konten keine Beträge unter 5 $ im Monat. |
| **Cloudflare Workers** | Kostenloser Tarif (100.000 Anfragen pro Tag) | Keine Maschine zu pflegen. Die Anmeldung liegt in einem Durable Object. |
| **Railway** | Kostenpflichtiger Tarif von Railway | Dashboard und Logs im Browser. |
| **Dein eigener Server** | Deine Sache | Jeder Docker-Host. Nimm das Image `ghcr.io/thebriangao/totem` oder baue das Dockerfile, und hänge ein Volume unter `/data` ein. |

Nach einem Deployment prüft `totem status` den Server und seine WHOOP-Anmeldung, `totem logs` zeigt seine Logs und `totem deploy` schickt ihm eine neue Version.

## Was du fragen kannst

- „Wie habe ich letzte Nacht geschlafen, und wie war das im Vergleich zum Monat?"
- „Warum ist meine Erholung heute niedrig?"
- „Zeig mir meine HRV und meinen Ruhepuls der letzten 90 Tage."
- „Wie hoch war meine Herzfrequenz beim Lauf heute Morgen?"
- „Trag einen 30-minütigen Spaziergang um 18 Uhr ein."
- „Ich hatte gestern Koffein und Alkohol. Trag das in mein Tagebuch ein."
- „Trag das heutige Training ein: Bankdrücken 3×5 mit 80 kg, Kniebeugen 3×5 mit 100 kg."
- „Stell einen Smart Alarm für 7:30 Uhr an Werktagen."

Jede Änderung kommt zuerst als Vorschau zurück. Deine App zeigt dir, was sich ändern wird, und fragt, bevor es passiert.

## So funktioniert die Anmeldung

1. `totem auth` (das `local` und `cloud` für dich starten) öffnet ein neues Browserfenster auf app.whoop.com. Dort meldest du dich an, auf der Seite von WHOOP und mit dessen Zwei-Faktor-Prüfung.
2. totem liest aus diesem Fenster nur die Sitzungscookies von WHOOP, schließt es dann und löscht das temporäre Profil.
3. Die Anmeldung liegt in einer Datei, die nur du lesen kannst (`~/.config/totem/tokens.json`), oder auf deinem Server: auf seinem Volume oder im Speicher eines Cloudflare Durable Object.
4. WHOOP ersetzt das Refresh-Token bei jeder Nutzung, deshalb kann eine Anmeldung nur an einem Ort liegen. totem erneuert sie selbstständig, alle 12 Stunden und bevor sie abläuft, und speichert das neue Token immer zuerst.

Neu anmelden geht mit demselben Befehl: `totem auth`. Auf einem Server prüfst du es mit `totem status`.

## Sicherheit

- **Dein Server, deine Schlüssel.** Ein Cloud-Server hat zwei eigene Geheimnisse: `MCP_AUTH_TOKEN` (der Schlüssel des Servers, gespeichert in `.totem-deploy.json` auf deinem Computer) und das Verbindungspasswort, das du eingibst, wenn sich eine App verbindet.
- **Die Anmeldeseite nennt das Ziel.** Sie zeigt die echte Adresse, an die der Zugriff geht (claude.ai, chatgpt.com, eine App auf deinem eigenen Computer), nie nur den Namen, den eine App angibt.
- **Sonst wird nichts kontaktiert.** Ausgehender Verkehr geht nur an WHOOP. Keine Telemetrie, keine Analyse.
- **Schreiben braucht eine Bestätigung,** und Schreibzugriffe über `whoop_raw` brauchen zusätzlich `allow_write`.

Mehr dazu in [SECURITY.md](../../SECURITY.md).

## Befehle

| Befehl | Was er tut |
|---|---|
| `totem local` | Auf diesem Computer laufen: anmelden, dann deine KI-Apps einrichten |
| `totem cloud` | Deinen Server deployen, anmelden, deine Apps verbinden |
| `totem connect [app]` | Deine Apps neu einrichten, oder nur eine (`totem connect --print` zeigt nur die Konfiguration) |
| `totem auth` | Bei WHOOP anmelden (`--local`, `--url URL`, `--paste`, `--status`) |
| `totem status` / `ping` / `logs` | Server und Anmeldung prüfen |
| `totem deploy` | Diese Version auf deinen Server deployen |
| `totem update` | totem aktualisieren (`--check`, `--auto on`) |
| `totem tools` | Die 40 Tools auflisten |

`totem <command> --help` erklärt jeden Befehl.

## Fehlerbehebung

**Die App zeigt keine WHOOP-Tools.** Starte sie komplett neu. Bei einer lokalen Einrichtung führst du `totem status` aus, bei einem Server `totem ping`.

**„No WHOOP login on this server."** Führe `totem auth` aus. Die Anmeldung geht an deinen Server, wenn einer eingerichtet ist, sonst wird sie auf diesem Computer gespeichert.

**Für die Anmeldung wurde kein Browser gefunden.** totem nutzt Chrome, Chromium, Edge oder Brave. Gib einen anderen mit `TOTEM_BROWSER=/path/to/browser` an, oder führe `totem auth --paste` aus und füge das Cookie `whoop-auth-refresh-token` aus einem Browser ein, der bei app.whoop.com angemeldet ist.

**Die Konfiguration von OpenCode oder einer anderen App enthält Kommentare.** totem überschreibt keine Dateien, die es nicht exakt lesen kann. Bei OpenCode lässt es OpenCode den Server selbst hinzufügen; bei anderen Apps zeigt es den Eintrag, den du ergänzen musst.

**WHOOP antwortet mit 5xx.** WHOOP hat gerade Probleme. Versuch es in einer Minute noch einmal.

## Häufige Fragen

**Unterstützt WHOOP das?**
Nein. totem nutzt die private API der WHOOP-App, die WHOOP Dritten nicht anbietet, und laut den Bedingungen von WHOOP kann WHOOP gegen Konten vorgehen, die inoffizielle Tools nutzen. Die Anfragen von totem sehen aus wie die der App und bleiben im Tempo eines Menschen, aber es gibt keine Garantie. Wenn der Verlust deines WHOOP-Kontos ein Problem wäre, nutze es nicht.

**Warum nicht die öffentliche API von WHOOP?**
Sie kann nur lesen und deckt einen kleinen Teil der Daten ab: kein Tagebuch, kein Strength Trainer, kein Stress, kein Coach, kein Smart Alarm, kein Hypnogramm, keine Trends und keine Schreibzugriffe. Wenn dir Erholung, Schlafsummen und eine Liste deiner Workouts reichen, nimm sie.

**Kann ich meinen Server mit Freunden teilen?**
Jede Person braucht einen eigenen Server und eine eigene WHOOP-Anmeldung. Eine Anmeldung lässt sich nicht teilen: WHOOP ersetzt das Refresh-Token bei jeder Nutzung.

**Funktioniert es mit WHOOP 4.0 und 5.0/MG?**
Ja. Die API hängt von deinem Konto ab, nicht von deinem Armband.

**Wohin gehen meine Daten?**
Von WHOOP zu deinem Server und von dort zu der App, die du gefragt hast. totem behält keine Kopie, nur einen kurzen Zwischenspeicher der letzten Abfragen im Arbeitsspeicher.

## Entwicklung

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install && npx tsc
totem test
```

Wie das Projekt aufgebaut ist, steht in [CONTRIBUTING.md](../../CONTRIBUTING.md); was über die API von WHOOP bekannt ist, in [WHOOP.md](../../WHOOP.md).

## Danksagung

Danke an alle, die Issues und Pull Requests für v1 und v2 eröffnet haben, an [Anthropic](https://anthropic.com) für MCP und an alle, die über die Jahre Teile der WHOOP-API dokumentiert haben.

„WHOOP" ist eine Marke von WHOOP, Inc. totem ist ein unabhängiges Projekt und steht in keiner Verbindung zu WHOOP, wird von WHOOP weder unterstützt noch gebilligt. MIT-Lizenz.
