<p align="center"><img src="../../assets/brand/totem.svg" width="96" alt=""></p>

<h1 align="center">totem</h1>

<p align="center"><b>Votre propre serveur WHOOP pour les applis d'IA.</b><br>
Posez des questions à Claude, ChatGPT, Cursor ou n'importe quelle appli MCP sur votre récupération, votre sommeil et votre entraînement, et laissez-la enregistrer vos séances, vos réponses au journal et plus encore.</p>

<p align="center">
  <a href="#pour-commencer">Pour commencer</a> ·
  <a href="#connecter-vos-applis">Connecter vos applis</a> ·
  <a href="#hébergement">Hébergement</a> ·
  <a href="../../TOOLS.md">Les 41 outils</a> ·
  <a href="#questions-fréquentes">Questions fréquentes</a>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  Français ·
  <a href="README.de.md">Deutsch</a>
</p>

---

totem est un petit serveur [MCP](https://modelcontextprotocol.io) open source qui parle à WHOOP comme le fait l'appli WHOOP. Vous le faites tourner vous-même, sur votre ordinateur ou sur un serveur cloud qui vous appartient, et vos applis d'IA s'y connectent. Vos données ne circulent qu'entre WHOOP, votre serveur et les applis que vous connectez.

- **41 outils.** Récupération, phases de sommeil, effort, stress, fréquence cardiaque, tendances, séances, Strength Trainer, journal, WHOOP Coach, poids, suivi du cycle, Smart Alarm, profil et réglages, ainsi que Healthspan, résultats d'analyses et historique de FA (expérimental). [La liste complète](../../TOOLS.md).
- **Écrire est sûr par défaut.** Chaque outil qui modifie quelque chose affiche d'abord un aperçu et ne fait rien tant que l'appli n'a pas confirmé.
- **Des réponses courtes.** Les outils renvoient des données compactes (environ 1,5 Ko pour un appel standard), elles n'encombrent donc pas votre contexte.
- **Une seule commande.** `totem local` ou `totem cloud` vous connecte à WHOOP et configure toutes les applis d'IA qu'il trouve.

> [!NOTE]
> totem utilise l'API privée de l'appli WHOOP, pas l'API publique pour développeurs, et n'a aucun lien avec WHOOP. Lisez les [questions fréquentes](#questions-fréquentes) avant de l'installer.

## Pour commencer

Il vous faut [Node.js 24](https://nodejs.org) ou plus récent et un compte WHOOP.

```bash
npm install -g @thebriangao/totem
```

Choisissez ensuite où totem tourne :

| | Sur cet ordinateur | Dans le cloud |
|---|---|---|
| Commande | `totem local` | `totem cloud` |
| Fonctionne avec | Les applis de bureau et de terminal : Claude Desktop, Claude Code, ChatGPT pour ordinateur et Codex, Cursor, VS Code, OpenCode, Antigravity | Tout, y compris claude.ai, chatgpt.com et les applis mobiles |
| Coût | Gratuit | Gratuit sur Cloudflare, environ 4 $ par mois sur Fly.io |
| Disponible | Tant que l'ordinateur est allumé | En permanence |

Les deux commandes ouvrent une fenêtre de navigateur sur le site de WHOOP pour que vous vous connectiez (totem ne voit jamais votre mot de passe), puis trouvent les applis d'IA de votre ordinateur et configurent chacune. Demandez ensuite à votre appli quelque chose comme *« Comment ai-je dormi cette nuit ? »*

### En un clic

Si vous préférez ne pas passer par le terminal pour le serveur :

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** demande deux valeurs : `MCP_AUTH_TOKEN` (64 caractères aléatoires, par exemple la sortie de `openssl rand -hex 32`) et `AUTH_PASSWORD` (le mot de passe que vous saisirez quand une appli se connecte). Il tourne sur l'offre gratuite de Workers.
- **Railway** génère les deux pour vous (dans les Variables du service). Il faut l'offre payante de Railway.
- Dans les deux cas, terminez par une commande qui vous connecte à WHOOP et envoie cette connexion à votre serveur :

  ```bash
  npx @thebriangao/totem auth --url https://your-server-address
  ```

**Claude Desktop seulement :** téléchargez [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) et double-cliquez dessus. Connectez-vous une fois avec `npx @thebriangao/totem auth --local`.

## Connecter vos applis

`totem connect` configure toutes les applis qu'il trouve sur votre ordinateur. Un serveur cloud a aussi une **page Connect** à `https://your-server/connect`, avec un bouton ou une étape prête à copier pour chaque appli, déjà remplis avec l'adresse de votre serveur.

| Appli | Sur cet ordinateur | Avec un serveur cloud |
|---|---|---|
| claude.ai, Claude Desktop, Claude mobile | Le fichier de configuration de Claude Desktop | Un lien qui ouvre « Add custom connector » de claude.ai déjà rempli ; il apparaît ensuite aussi sur l'ordinateur et sur le téléphone |
| Claude Code | `claude mcp add` | `claude mcp add --transport http`, puis `/mcp` pour se connecter |
| ChatGPT pour ordinateur et Codex | `codex mcp add` (configuration commune) | `codex mcp add --url` ouvre lui-même la connexion |
| chatgpt.com | (nécessite un serveur cloud) | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | Un lien « Add to Cursor » |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | Un lien « Add to VS Code » |
| OpenCode (1 et 2) | `opencode.json` | `opencode.json`, puis `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | Le même fichier, avec l'adresse du serveur |

Avec un serveur cloud, chaque appli vous envoie une fois sur la page de connexion de totem. Elle indique quelle appli demande l'accès et où il est envoyé, et vous demande votre mot de passe de connexion.

## Hébergement

`totem cloud` déploie sur l'un de ces hébergeurs et vérifie le serveur ensuite :

| Hébergeur | Coût | Remarques |
|---|---|---|
| **Fly.io** (recommandé) | Environ 4 $ par mois : une machine de 512 Mo en Virginie et un volume de 1 Go | Toujours allumé. Au moment de l'écriture, Fly ne facture pas les comptes personnels en dessous de 5 $ par mois. |
| **Cloudflare Workers** | Offre gratuite (100 000 requêtes par jour) | Aucune machine à entretenir. La connexion est gardée dans un Durable Object. |
| **Railway** | Offre payante de Railway | Un tableau de bord et des journaux dans le navigateur. |
| **Votre propre serveur** | À vous de voir | N'importe quel hôte Docker. Utilisez l'image `ghcr.io/thebriangao/totem` ou construisez le Dockerfile, et montez un volume sur `/data`. |

Après un déploiement, `totem status` vérifie le serveur et sa connexion WHOOP, `totem logs` affiche ses journaux et `totem deploy` lui envoie une nouvelle version.

## Ce que vous pouvez demander

- « Comment ai-je dormi cette nuit, et comment ça se compare au mois ? »
- « Pourquoi ma récupération est-elle basse aujourd'hui ? »
- « Montre ma VFC et ma fréquence cardiaque au repos sur les 90 derniers jours. »
- « Quelle était ma fréquence cardiaque pendant la course de ce matin ? »
- « Enregistre une marche de 30 minutes à 18 h. »
- « J'ai pris de la caféine et de l'alcool hier. Ajoute-le à mon journal. »
- « Enregistre la séance d'aujourd'hui : développé couché 3×5 à 80 kg, squat 3×5 à 100 kg. »
- « Règle une Smart Alarm à 7 h 30 en semaine. »

Chaque écriture revient d'abord sous forme d'aperçu. Votre appli vous montre ce qui va changer et vous demande avant de le faire.

## Comment fonctionne la connexion

1. `totem auth` (que `local` et `cloud` lancent pour vous) ouvre une nouvelle fenêtre de navigateur sur app.whoop.com. Vous vous y connectez, sur la page de WHOOP et avec sa vérification en deux étapes.
2. totem ne lit que les cookies de session de WHOOP dans cette fenêtre, puis la ferme et supprime le profil temporaire.
3. La connexion est gardée dans un fichier que vous seul pouvez lire (`~/.config/totem/tokens.json`), ou sur votre serveur : sur son volume, ou dans le stockage d'un Durable Object Cloudflare.
4. WHOOP remplace le jeton de rafraîchissement à chaque utilisation, donc une connexion ne peut appartenir qu'à un seul endroit. totem la renouvelle tout seul, toutes les 12 heures et avant son expiration, en enregistrant toujours d'abord le nouveau jeton.

Pour vous reconnecter, c'est la même commande : `totem auth`. Sur un serveur, vous pouvez vérifier avec `totem status`.

## Sécurité

- **Votre serveur, vos clés.** Un serveur cloud a deux secrets à lui : `MCP_AUTH_TOKEN` (la clé du serveur, gardée dans `.totem-deploy.json` sur votre ordinateur) et le mot de passe de connexion que vous saisissez quand une appli se connecte.
- **La page de connexion nomme la destination.** Elle affiche l'adresse réelle où va l'accès (claude.ai, chatgpt.com, une appli sur votre propre ordinateur), jamais seulement le nom qu'une appli prétend avoir.
- **Rien d'autre n'est contacté.** Le seul trafic sortant va vers WHOOP. Pas de télémétrie, pas d'analytique.
- **Les écritures demandent une confirmation,** et celles de `whoop_raw` demandent aussi `allow_write`.

Plus de détails dans [SECURITY.md](../../SECURITY.md).

## Commandes

| Commande | Ce qu'elle fait |
|---|---|
| `totem local` | Tourner sur cet ordinateur : se connecter, puis configurer vos applis d'IA |
| `totem cloud` | Déployer votre serveur, le connecter et connecter vos applis |
| `totem connect [app]` | Reconfigurer vos applis, ou une seule (`totem connect --print` affiche seulement la configuration) |
| `totem auth` | Se connecter à WHOOP (`--local`, `--url URL`, `--paste`, `--status`) |
| `totem status` / `ping` / `logs` | Vérifier le serveur et sa connexion |
| `totem deploy` | Déployer cette version sur votre serveur |
| `totem update` | Mettre totem à jour (`--check`, `--auto on`) |
| `totem tools` | Lister les 41 outils |

`totem <command> --help` explique chacune.

## Dépannage

**L'appli n'affiche aucun outil WHOOP.** Redémarrez-la complètement. En local, lancez `totem status` ; avec un serveur, `totem ping`.

**« No WHOOP login on this server. »** Lancez `totem auth`. La connexion est envoyée à votre serveur s'il y en a un, sinon elle est enregistrée sur cet ordinateur.

**Aucun navigateur trouvé pour la connexion.** totem utilise Chrome, Chromium, Edge ou Brave. Indiquez-en un autre avec `TOTEM_BROWSER=/path/to/browser`, ou lancez `totem auth --paste` et collez le cookie `whoop-auth-refresh-token` d'un navigateur connecté à app.whoop.com.

**La configuration d'OpenCode ou d'une autre appli contient des commentaires.** totem ne réécrit pas les fichiers qu'il ne peut pas lire exactement. Pour OpenCode, il laisse OpenCode ajouter le serveur lui-même ; pour les autres, il affiche l'entrée à ajouter.

**WHOOP répond 5xx.** WHOOP a un souci. Réessayez dans une minute.

## Questions fréquentes

**WHOOP le prend-il en charge ?**
Non. totem utilise l'API privée de l'appli WHOOP, que WHOOP ne propose pas aux tiers, et les conditions de WHOOP lui permettent d'agir contre les comptes qui utilisent des outils non officiels. Les requêtes de totem ressemblent à celles de l'appli et restent au rythme d'une personne, mais rien n'est garanti. Si perdre votre compte WHOOP vous poserait problème, ne l'utilisez pas.

**Pourquoi pas l'API publique de WHOOP ?**
Elle est en lecture seule et ne couvre qu'une petite partie des données : pas de journal, de Strength Trainer, de stress, de Coach, de Smart Alarm, d'hypnogramme ni de tendances, et aucune écriture. Si la récupération, les totaux de sommeil et une liste de séances vous suffisent, utilisez-la.

**Puis-je partager mon serveur avec un ami ?**
Chacun a besoin de son propre serveur et de sa propre connexion WHOOP. Une connexion ne se partage pas : WHOOP remplace le jeton de rafraîchissement à chaque utilisation.

**Ça marche avec WHOOP 4.0 et 5.0/MG ?**
Oui. L'API dépend de votre compte, pas de votre bracelet.

**Où vont mes données ?**
De WHOOP à votre serveur, puis à l'appli à qui vous avez posé la question. totem ne garde aucune copie, seulement un court cache en mémoire des lectures récentes.

## Développement

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install && npx tsc
totem test
```

Voir [CONTRIBUTING.md](../../CONTRIBUTING.md) pour l'organisation du projet et [WHOOP.md](../../WHOOP.md) pour ce que l'on sait de l'API de WHOOP.

## Remerciements

Merci à toutes les personnes qui ont ouvert des issues et des pull requests pour la v1 et la v2, à [Anthropic](https://anthropic.com) pour MCP, et à celles et ceux qui ont documenté des morceaux de l'API de WHOOP au fil des années.

« WHOOP » est une marque de WHOOP, Inc. totem est un projet indépendant, sans affiliation, approbation ni lien avec WHOOP. Licence MIT.
