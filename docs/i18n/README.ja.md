<p align="center"><img src="../../assets/brand/totem.svg" width="80" alt="totem"></p>

<h1 align="center">totem</h1>

<p align="center"><b>WHOOP のデータを、Claude や ChatGPT など、いつもの AI アプリで。</b><br>
自分で動かすオープンソースの MCP サーバー。コマンド一つでセットアップできます。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@thebriangao/totem"><img src="https://img.shields.io/npm/v/%40thebriangao%2Ftotem?style=flat-square&labelColor=141414&color=7A9CC6" alt="npm version"></a>
  <a href="https://github.com/thebriangao/totem/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/thebriangao/totem/ci.yml?branch=main&style=flat-square&labelColor=141414&label=tests" alt="tests"></a>
  <a href="../../TOOLS.md"><img src="https://img.shields.io/badge/MCP-41%20tools-7A9CC6?style=flat-square&labelColor=141414" alt="41 MCP tools"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-7A9CC6?style=flat-square&labelColor=141414" alt="Node 24 or newer">
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-7A9CC6?style=flat-square&labelColor=141414" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#クイックスタート">クイックスタート</a> ·
  <a href="#聞けること">聞けること</a> ·
  <a href="#アプリをつなぐ">アプリをつなぐ</a> ·
  <a href="#ホスティング">ホスティング</a> ·
  <a href="../../TOOLS.md">ツール</a> ·
  <a href="#よくある質問">よくある質問</a>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  日本語 ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/totem-local-dark.svg">
    <img src="../media/totem-local-light.svg" width="668" alt="totem local を実行しているターミナル。Node.js を確認し、ブラウザのウィンドウで WHOOP にログインして、Claude Desktop、Claude Code、ChatGPT、OpenCode、Antigravity に totem を追加します。">
  </picture>
</p>

totem は WHOOP アカウントを AI アプリにつなぎます。昨夜の睡眠、リカバリーが低い理由、この四半期の HRV の変化などを聞けます。ワークアウトの記録やジャーナルの入力をアプリに任せることもできます。

totem は小さなサーバーです。アプリとは [MCP](https://modelcontextprotocol.io) で話し、WHOOP とは WHOOP アプリと同じ方法で通信します。自分のパソコンか、自分が持つクラウドサーバーで動かします。

- **41 のツール。** リカバリー、睡眠、ストレイン、ストレス、心拍数、トレンド、ワークアウト、Strength Trainer、ジャーナル、WHOOP Coach、体重、サイクル記録、Smart Alarm、プロフィールと設定。[すべて見る](../../TOOLS.md)。
- **「はい」と言うまで何も変わりません。** 書き込みをするツールは必ず先にプレビューを見せ、あなたの確認を待ちます。
- **コンテキストを圧迫しません。** 標準の回答は約 1.5 KB なので、会話のための余裕が残ります。
- **コマンド一つ。** `totem local` か `totem cloud` が WHOOP へのログインを済ませ、見つけた AI アプリに totem を追加します。

> [!NOTE]
> totem は公開の開発者 API ではなく WHOOP アプリの非公開 API を使っており、WHOOP とは無関係です。インストールの前に[よくある質問](#よくある質問)をお読みください。

## クイックスタート

[Node.js 24](https://nodejs.org) 以降と WHOOP アカウントが必要です。

**1. インストールします。**

```bash
npm install -g @thebriangao/totem
```

**2. 動かす場所を選びます。**

| | このパソコンで | クラウドで |
|---|---|---|
| コマンド | `totem local` | `totem cloud` |
| 対応アプリ | デスクトップとターミナルのアプリ：Claude Desktop、Claude Code、ChatGPT デスクトップ版と Codex、Cursor、VS Code、OpenCode、Antigravity | 左のすべてに加えて、claude.ai、chatgpt.com、スマホの Claude |
| 費用 | 無料 | Cloudflare なら無料、Fly.io なら月 4 ドル前後 |
| 使える時間 | パソコンが起動している間 | 常時 |

どちらのコマンドも、WHOOP 自身のサイトでブラウザのウィンドウを開き、そこでログインしてもらいます。totem があなたのパスワードを見ることはありません。そのあとパソコンにある AI アプリを探し、それぞれに totem を追加するかどうかを尋ねます。

**3. 何か聞いてみます。**

アプリを開いて、*「昨夜はよく眠れた？」* と聞いてみてください。

`totem` だけを実行すると、いつでも今の状態を確認できます。

### ボタンで済ませたい場合

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** では値を二つ入力します。`MCP_AUTH_TOKEN`（64 文字のランダムな文字列。例えば `openssl rand -hex 32` の出力）と `AUTH_PASSWORD`（アプリがつながるときに入力するパスワード）です。無料の Workers プランで動きます。
- **Railway** は両方を自動で作ります（サービスの Variables で確認できます）。Railway の有料プランが必要です。

そのあと WHOOP にログインし、そのログインをサーバーに送ります。

```bash
npx @thebriangao/totem auth --url https://your-server-address
```

**Claude Desktop だけを使う場合は、** [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) をダウンロードしてダブルクリックし、`npx @thebriangao/totem auth --local` で一度ログインします。

## 聞けること

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/chat-answer-dark.png">
    <img src="../media/chat-answer-light.png" width="820" alt="totem を使って「今日の調子はどう？」に答える Claude。今日のリカバリー、睡眠、ストレイン、ストレス、歩数、カロリーの表と、昨夜の睡眠、今日のトレーニング、今夜必要な睡眠についてのメモ。">
  </picture>
</p>

- 「昨夜はどれくらい眠れた？今月と比べてどう？」
- 「今日のリカバリーが低いのはなぜ？」
- 「過去 90 日の HRV と安静時心拍数を見せて。」
- 「今朝のランニング中の心拍数は？」
- 「午後 6 時に 30 分の散歩を記録して。」
- 「昨日はカフェインとお酒をとった。ジャーナルに追加して。」
- 「今日の筋トレを記録して：ベンチプレス 80 kg を 3×5、スクワット 100 kg を 3×5。」
- 「平日の 7:30 に Smart Alarm を設定して。」

書き込みはすべて、まずプレビューとして返ってきます。何が変わるかをアプリが示し、実行する前に確認します。

## アプリをつなぐ

`totem connect` はパソコンにあるアプリを設定します。クラウドサーバーには Connect ページ（`https://your-server/connect`）もあり、アプリごとにボタンか、コピーするだけの手順が、サーバーのアドレス入りで用意されています。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/connect-page-dark.png">
    <img src="../media/connect-page-light.png" width="49%" alt="Connect ページ。サーバーのアドレスと、アプリごとのカードがあり、それぞれにボタンかコピー用のコマンドがあります。">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/consent-page-dark.png">
    <img src="../media/consent-page-light.png" width="49%" alt="サインインページ。どのアプリが求めているか、アクセスの送り先、求められている権限、接続パスワードが表示されます。">
  </picture>
</p>

クラウドサーバーの場合、各アプリは一度だけ totem のサインインページを開きます。ページには、どのアプリが求めているか、アクセスがどこへ送られるかが表示され、接続パスワードの入力を求められます。

<details>
<summary><b>アプリごとの手順</b></summary>

<br>

| アプリ | このパソコンで | クラウドサーバーで |
|---|---|---|
| claude.ai、Claude Desktop、Claude モバイル | Claude Desktop の設定ファイル | claude.ai の「Add custom connector」を入力済みで開くリンク。その後はデスクトップ版とスマホにも表示されます |
| Claude Code | `claude mcp add` | `claude mcp add --transport http`、そのあと `/mcp` でサインイン |
| ChatGPT デスクトップ版と Codex | `codex mcp add`（設定は共通） | `codex mcp add --url`。サインインは自動で開きます |
| chatgpt.com | クラウドサーバーが必要 | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | 「Add to Cursor」リンク |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | 「Add to VS Code」リンク |
| OpenCode（1 と 2） | `opencode.json` | `opencode.json`、そのあと `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | 同じファイルにサーバーのアドレスを書きます |

`totem connect <app>` はアプリを一つだけ設定します。`totem connect --print` は、何も変更せずに追加する内容だけを表示します。

</details>

## ホスティング

`totem cloud` は次のどれにでもデプロイでき、そのあとサーバーが応答するかを確認します。

| ホスト | 費用 | 知っておくこと |
|---|---|---|
| **Cloudflare Workers**（おすすめ） | 無料プラン、1 日 100,000 リクエスト | 面倒を見るマシンがありません。ログインは Durable Object に保存されます。 |
| **Fly.io** | 月 4 ドル前後。バージニアの 512 MB マシン 1 台と 1 GB のボリューム | 常時稼働。執筆時点では、Fly は月 5 ドル未満の個人アカウントには請求しません。 |
| **Railway** | Railway の有料プラン | ブラウザでダッシュボードとログを見られます。 |
| **自分のサーバー** | 自分次第 | Docker が動くホストならどこでも。totem が設定を書き出し、実行するコマンドを表示します。イメージ `ghcr.io/thebriangao/totem` を使うこともできます。`/data` にボリュームをマウントしてください。 |

デプロイ後は、`totem status` でサーバーと WHOOP ログインを確認し、`totem logs` でログを見て、`totem deploy` で新しいバージョンを送れます。

## しくみ

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/how-it-works-dark.svg">
    <img src="../media/how-it-works-light.svg" width="820" alt="WHOOP は WHOOP のアプリ API であなたの totem サーバーと通信します。AI アプリは MCP であなたの totem サーバーと通信します。totem はあなたのパソコンか、あなた自身のクラウドサーバーで動きます。">
  </picture>
</p>

データは WHOOP からあなたの totem へ、そして質問したアプリへ流れ、ほかのどこにも行きません。間に totem の会社はなく、共有サーバーも、アクセス解析もありません。

### WHOOP へのログイン

1. `totem auth`（`local` と `cloud` が代わりに実行します）は、app.whoop.com で新しいブラウザのウィンドウを開きます。ログインは WHOOP 自身のページで、二段階認証も含めて行います。
2. totem はそのウィンドウから WHOOP のセッション Cookie だけを読み取り、ウィンドウを閉じて一時プロファイルを削除します。
3. ログインはあなただけが読めるファイル（`~/.config/totem/tokens.json`）か、サーバーのボリューム、または Cloudflare の Durable Object ストレージに保存されます。
4. WHOOP はリフレッシュトークンを使うたびに新しいものに入れ替えるため、一つのログインを持てるのは一か所だけです。totem は 12 時間ごとと期限切れの前に自動で更新し、新しいトークンを必ず先に保存します。

ログインし直すには `totem auth` を実行します。

### セキュリティ

- **あなたのサーバー、あなたの鍵。** クラウドサーバーには固有の秘密が二つあります。`MCP_AUTH_TOKEN`（サーバーの鍵。パソコンの `~/.config/totem/deploy.json` に保存）と、アプリがつながるときに入力する接続パスワードです。
- **サインインページは送り先を明示します。** アクセスが実際に送られるアドレス（claude.ai、chatgpt.com、自分のパソコン上のアプリ）を表示し、アプリが名乗る名前だけを表示することはありません。
- **サーバーが通信する相手は WHOOP とあなたのアプリだけです。** テレメトリもアクセス解析もありません。
- **書き込みには確認が必要です。** `whoop_raw` の書き込みにはさらに `allow_write` が必要です。

詳しくは [SECURITY.md](../../SECURITY.md) をご覧ください。

## コマンド

| コマンド | 内容 |
|---|---|
| `totem` | このインストールの状態と、次に実行するコマンドを表示 |
| `totem local` | このパソコンで動かす：ログインして AI アプリを設定 |
| `totem cloud` | 自分のサーバーをデプロイし、ログインして、アプリをつなぐ |
| `totem connect [app]` | アプリをもう一度設定する。一つだけでも可 |
| `totem auth` | WHOOP にログイン（`--local`、`--url URL`、`--paste`、`--status`） |
| `totem status` / `ping` / `logs` | サーバーとそのログインを確認 |
| `totem deploy` | このバージョンをサーバーにデプロイ |
| `totem update` | totem を更新（`--check`、`--auto on`） |
| `totem tools` | 41 のツールを一覧表示 |

`totem <command> --help` で各コマンドの説明を表示します。

## トラブルシューティング

**アプリに WHOOP のツールが表示されない。** アプリを完全に再起動してください。ローカルの場合は `totem status`、サーバーの場合は `totem ping` を実行します。

**"No WHOOP login on this server."** `totem auth` を実行してください。サーバーが設定されていればログインをそこへ送り、なければこのパソコンに保存します。

**ログイン用のブラウザが見つからない。** totem は Chrome、Chromium、Edge、Brave を使います。ほかのブラウザは `TOTEM_BROWSER=/path/to/browser` で指定できます。または `totem auth --paste` を実行し、app.whoop.com にログイン済みのブラウザから `whoop-auth-refresh-token` Cookie を貼り付けてください。

**OpenCode などの設定ファイルにコメントがある。** totem は正確に読めないファイルを書き換えません。OpenCode の場合は OpenCode 自身にサーバーを追加させ、ほかのアプリでは追加すべき内容を表示します。

**WHOOP が 5xx を返す。** WHOOP 側の問題です。1 分ほどしてからもう一度試してください。

## よくある質問

**WHOOP 公認ですか？**
いいえ。totem は WHOOP アプリの非公開 API を使っています。WHOOP はこれを第三者に提供しておらず、利用規約では非公式のツールを使うアカウントに対して措置をとれることになっています。totem のリクエストはアプリのものと同じように見え、人が使うのと同じくらいのペースに抑えていますが、保証はありません。WHOOP アカウントを失うと困る場合は使わないでください。

**なぜ WHOOP の公開 API を使わないのですか？**
公開 API は読み取り専用で、データのごく一部しか扱えません。ジャーナル、Strength Trainer、ストレス、Coach、Smart Alarm、睡眠のヒプノグラム、トレンドはなく、書き込みもできません。リカバリー、睡眠の合計、ワークアウトの一覧で十分なら、公開 API を使ってください。

**サーバーを友だちと共有できますか？**
いいえ。一人ひとりに自分のサーバーと自分の WHOOP ログインが必要です。WHOOP は使うたびにリフレッシュトークンを入れ替えるため、ログインは共有できません。

**WHOOP 4.0 や 5.0/MG で使えますか？**
使えます。API はバンドではなくアカウントに依存します。

**データはどこへ行きますか？**
WHOOP からあなたのサーバーへ、そして質問したアプリへ。totem はコピーを保存せず、最近の読み取り結果をメモリにキャッシュするだけです。

## コントリビュート

issue や pull request を歓迎します。totem を開発するには：

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install
npx tsc && npm link     # 一度ビルドして `totem` を PATH に通します
totem test
```

プロジェクトの構成は [CONTRIBUTING.md](../../CONTRIBUTING.md) に、WHOOP の API についてわかっていることは [WHOOP.md](../../WHOOP.md) にまとめています。

## 謝辞

v1 と v2 に issue や pull request を送ってくれたすべての方、MCP を作った [Anthropic](https://anthropic.com)、そして長年にわたって WHOOP の API を少しずつ記録してきた方々に感謝します。

## ライセンス

[MIT](../../LICENSE)。「WHOOP」は WHOOP, Inc. の商標です。totem は独立したプロジェクトであり、WHOOP との提携、承認、関係は一切ありません。
