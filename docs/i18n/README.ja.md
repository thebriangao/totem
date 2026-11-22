<h1 align="center">totem</h1>

<p align="center"><b>AI アプリのための、あなた専用の WHOOP サーバー。</b><br>
Claude、ChatGPT、Cursor などの MCP アプリに、リカバリー、睡眠、トレーニングについて質問したり、ワークアウトやジャーナルの記録を任せたりできます。</p>

<p align="center">
  <a href="#はじめに">はじめに</a> ·
  <a href="#アプリをつなぐ">アプリをつなぐ</a> ·
  <a href="#ホスティング">ホスティング</a> ·
  <a href="../../TOOLS.md">40 のツール</a> ·
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

---

totem は小さなオープンソースの [MCP](https://modelcontextprotocol.io) サーバーで、WHOOP アプリと同じ方法で WHOOP と通信します。自分のパソコンか、自分が持つクラウドサーバーで自分で動かし、そこに AI アプリをつなぎます。データは WHOOP、あなたのサーバー、つないだアプリの間だけを流れます。

- **40 のツール。** リカバリー、睡眠ステージ、ストレイン、ストレス、心拍数、トレンド、ワークアウト、Strength Trainer、ジャーナル、WHOOP Coach、体重、サイクル記録、Smart Alarm、プロフィールと設定。[一覧はこちら](../../TOOLS.md)。
- **書き込みは最初から安全。** データを変えるツールはまずプレビューを返し、アプリが確認するまで何もしません。
- **答えが小さい。** ツールはコンパクトなデータを返す（標準の呼び出しで約 1.5 KB）ので、コンテキストを圧迫しません。
- **コマンド一つで準備完了。** `totem local` か `totem cloud` が WHOOP へのログインを手伝い、見つけた AI アプリをすべて設定します。

> [!NOTE]
> totem は公開の開発者 API ではなく WHOOP アプリの非公開 API を使っており、WHOOP とは無関係です。インストールの前に[よくある質問](#よくある質問)をお読みください。

## はじめに

[Node.js 24](https://nodejs.org) 以降と WHOOP アカウントが必要です。

```bash
npm install -g @thebriangao/totem
```

次に、totem を動かす場所を選びます。

| | このパソコンで動かす | クラウドで動かす |
|---|---|---|
| コマンド | `totem local` | `totem cloud` |
| 対応アプリ | デスクトップとターミナルのアプリ：Claude Desktop、Claude Code、ChatGPT デスクトップ版と Codex、Cursor、VS Code、OpenCode、Antigravity | すべて。claude.ai、chatgpt.com、スマホアプリも含む |
| 費用 | 無料 | Cloudflare なら無料、Fly.io なら月 4 ドル前後 |
| 稼働 | パソコンが起動している間 | 常時 |

どちらのコマンドも、WHOOP 自身のサイトでブラウザのウィンドウを開いてログインしてもらい（totem があなたのパスワードを見ることはありません）、パソコンにある AI アプリを探してそれぞれ設定します。あとはアプリに *「昨夜はよく眠れた？」* のように聞くだけです。

### ワンクリックで

サーバーのためにターミナルを使いたくない場合：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** では値を二つ入力します：`MCP_AUTH_TOKEN`（64 文字のランダムな文字列。例えば `openssl rand -hex 32` の出力）と `AUTH_PASSWORD`（アプリがつながるときに入力するパスワード）。無料の Workers プランで動きます。
- **Railway** は両方を自動で作ります（サービスの Variables で確認できます）。Railway の有料プランが必要です。
- どちらの場合も、最後に一つのコマンドで WHOOP にログインし、そのログインをサーバーに送ります。

  ```bash
  npx @thebriangao/totem auth --url https://your-server-address
  ```

**Claude Desktop だけ使う場合：** [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) をダウンロードしてダブルクリックします。`npx @thebriangao/totem auth --local` で一度ログインしてください。

## アプリをつなぐ

`totem connect` はパソコンで見つけたアプリをすべて設定します。クラウドサーバーには **Connect ページ**（`https://your-server/connect`）もあり、アプリごとにボタンかコピーするだけの手順が、サーバーのアドレス入りで用意されています。

| アプリ | このパソコンで | クラウドサーバーで |
|---|---|---|
| claude.ai、Claude Desktop、Claude モバイル | Claude Desktop の設定ファイル | claude.ai の "Add custom connector" を入力済みで開くリンク。デスクトップ版とスマホにも表示されます |
| Claude Code | `claude mcp add` | `claude mcp add --transport http` のあと `/mcp` でサインイン |
| ChatGPT デスクトップ版と Codex | `codex mcp add`（設定は共通） | `codex mcp add --url` がサインインを自動で開きます |
| chatgpt.com | （クラウドサーバーが必要） | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | "Add to Cursor" リンク |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | "Add to VS Code" リンク |
| OpenCode（1 と 2） | `opencode.json` | `opencode.json` のあと `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | 同じファイルにサーバーのアドレスを書きます |

クラウドサーバーの場合、各アプリは一度だけ totem のサインインページに案内します。どのアプリが求めているか、アクセスがどこに送られるかを表示し、接続パスワードを尋ねます。

## ホスティング

`totem cloud` は次のどれにもデプロイでき、デプロイ後にサーバーを確認します。

| ホスト | 費用 | 補足 |
|---|---|---|
| **Fly.io**（おすすめ） | 月 4 ドル前後：バージニアの 512 MB マシン 1 台と 1 GB のボリューム | 常時稼働。執筆時点では、Fly は個人アカウントの月 5 ドル未満の利用を請求しません。 |
| **Cloudflare Workers** | 無料プラン（1 日 10 万リクエスト） | 管理するマシンはありません。ログインは Durable Object に保存されます。 |
| **Railway** | Railway の有料プラン | ブラウザのダッシュボードとログ。 |
| **自分のサーバー** | 自由 | Docker が動く環境ならどこでも。イメージ `ghcr.io/thebriangao/totem` を使うか Dockerfile をビルドし、`/data` にボリュームをマウントします。 |

デプロイ後は、`totem status` でサーバーと WHOOP のログインを確認し、`totem logs` でログを見て、`totem deploy` で新しいバージョンを送ります。

## 聞けること

- 「昨夜はどれくらい眠れた？今月と比べてどう？」
- 「今日のリカバリーが低いのはなぜ？」
- 「過去 90 日の HRV と安静時心拍数を見せて。」
- 「今朝のランニング中の心拍数は？」
- 「午後 6 時に 30 分の散歩を記録して。」
- 「昨日はカフェインとお酒をとった。ジャーナルに追加して。」
- 「今日の筋トレを記録して：ベンチプレス 80 kg を 3×5、スクワット 100 kg を 3×5。」
- 「平日の 7:30 に Smart Alarm を設定して。」

書き込みはすべて、まずプレビューとして返ってきます。何が変わるかをアプリが示し、実行前に確認します。

## ログインのしくみ

1. `totem auth`（`local` と `cloud` が代わりに実行します）は、app.whoop.com で新しいブラウザのウィンドウを開きます。ログインは WHOOP 自身のページで、二段階認証も含めて行います。
2. totem はそのウィンドウから WHOOP のセッション Cookie だけを読み取り、ウィンドウを閉じて一時プロファイルを削除します。
3. ログインはあなただけが読めるファイル（`~/.config/totem/tokens.json`）か、サーバーのボリューム、または Cloudflare の Durable Object ストレージに保存されます。
4. WHOOP はリフレッシュトークンを使うたびに新しいものに入れ替えるため、一つのログインを持てるのは一か所だけです。totem は 12 時間ごとと期限切れの前に自動で更新し、新しいトークンを必ず先に保存します。

ログインし直すときも同じコマンド `totem auth` です。サーバーでは `totem status` で確認できます。

## セキュリティ

- **あなたのサーバー、あなたの鍵。** クラウドサーバーには固有の秘密が二つあります：`MCP_AUTH_TOKEN`（サーバーの鍵。パソコンの `.totem-deploy.json` に保存）と、アプリがつながるときに入力する接続パスワードです。
- **サインインページは送り先を明示します。** アクセスが実際に送られるアドレス（claude.ai、chatgpt.com、自分のパソコン上のアプリ）を表示し、アプリが名乗る名前だけを表示することはありません。
- **ほかには一切接続しません。** 外部への通信は WHOOP だけです。テレメトリーも分析もありません。
- **書き込みには確認が必要**で、`whoop_raw` の書き込みにはさらに `allow_write` が必要です。

詳しくは [SECURITY.md](../../SECURITY.md) を参照してください。

## コマンド

| コマンド | 内容 |
|---|---|
| `totem local` | このパソコンで動かす：ログインして AI アプリを設定 |
| `totem cloud` | 自分のサーバーをデプロイし、ログインし、アプリをつなぐ |
| `totem connect [app]` | アプリを設定し直す、または一つだけ（`totem connect --print` は設定を表示するだけ） |
| `totem auth` | WHOOP にログイン（`--local`、`--url URL`、`--paste`、`--status`） |
| `totem status` / `ping` / `logs` | サーバーとログインを確認 |
| `totem deploy` | このバージョンをサーバーにデプロイ |
| `totem update` | totem を更新（`--check`、`--auto on`） |
| `totem tools` | 40 のツールを一覧表示 |

`totem <command> --help` で各コマンドの説明が見られます。

## トラブルシューティング

**アプリに WHOOP のツールが表示されない。** アプリを完全に再起動してください。ローカルなら `totem status`、サーバーなら `totem ping` を実行します。

**"No WHOOP login on this server."** `totem auth` を実行してください。サーバーが設定されていればそこへログインを送り、なければこのパソコンに保存します。

**ログイン用のブラウザが見つからない。** totem は Chrome、Chromium、Edge、Brave を使います。別のブラウザは `TOTEM_BROWSER=/path/to/browser` で指定するか、`totem auth --paste` を実行して、app.whoop.com にログイン済みのブラウザから `whoop-auth-refresh-token` Cookie を貼り付けてください。

**OpenCode などの設定ファイルにコメントがある。** totem は正確に読めないファイルを書き換えません。OpenCode の場合は OpenCode 自身にサーバーを追加させ、ほかのアプリでは追加すべき内容を表示します。

**WHOOP が 5xx を返す。** WHOOP 側の問題です。1 分ほどしてから再試行してください。

## よくある質問

**WHOOP 公認ですか？**
いいえ。totem は WHOOP アプリの非公開 API を使っています。WHOOP はこれを第三者に提供しておらず、利用規約では非公式のツールを使うアカウントに対して措置をとれることになっています。totem のリクエストはアプリのものと同じように見え、人が使うのと同じくらいのペースに抑えていますが、保証はありません。WHOOP アカウントを失うと困る場合は使わないでください。

**なぜ WHOOP の公開 API を使わないのですか？**
公開 API は読み取り専用で、データのごく一部しか扱えません。ジャーナル、Strength Trainer、ストレス、Coach、Smart Alarm、睡眠のヒプノグラム、トレンドはなく、書き込みもできません。リカバリー、睡眠の合計、ワークアウトの一覧で十分なら、公開 API を使ってください。

**サーバーを友だちと共有できますか？**
一人ひとりに自分のサーバーと自分の WHOOP ログインが必要です。WHOOP は使うたびにリフレッシュトークンを入れ替えるため、ログインは共有できません。

**WHOOP 4.0 や 5.0/MG で使えますか？**
使えます。API はバンドではなくアカウントに依存します。

**データはどこへ行きますか？**
WHOOP からあなたのサーバーへ、そして質問したアプリへ。totem はコピーを保存せず、最近の読み取り結果を短時間だけメモリにキャッシュします。

## 開発

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install && npx tsc
totem test
```

プロジェクトの構成は [CONTRIBUTING.md](../../CONTRIBUTING.md)、WHOOP の API についてわかっていることは [WHOOP.md](../../WHOOP.md) を参照してください。

## 謝辞

v1 と v2 に issue や pull request を寄せてくださった皆さん、MCP を作った [Anthropic](https://anthropic.com)、そして長年にわたり WHOOP の API の一部を記録してきた方々に感謝します。

"WHOOP" は WHOOP, Inc. の商標です。totem は独立したプロジェクトであり、WHOOP とは提携、承認、その他いかなる関係もありません。MIT ライセンスです。
