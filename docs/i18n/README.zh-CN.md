<h1 align="center">totem</h1>

<p align="center"><b>你自己的 WHOOP 服务器，供 AI 应用使用。</b><br>
向 Claude、ChatGPT、Cursor 或任何 MCP 应用询问你的恢复、睡眠和训练情况，并让它帮你记录运动、日志等内容。</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="#连接你的应用">连接你的应用</a> ·
  <a href="#托管">托管</a> ·
  <a href="../../TOOLS.md">40 个工具</a> ·
  <a href="#常见问题">常见问题</a>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  简体中文 ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

---

totem 是一个小型开源 [MCP](https://modelcontextprotocol.io) 服务器，它和 WHOOP 应用一样与 WHOOP 通信。你自己运行它，可以在自己的电脑上，也可以在你自己的云服务器上，然后让 AI 应用连接它。你的数据只在 WHOOP、你的服务器和你连接的应用之间传输。

- **40 个工具。** 恢复、睡眠阶段、负荷、压力、心率、趋势、运动、Strength Trainer、日志、WHOOP Coach、体重、周期追踪、Smart Alarm、个人资料和设置。[完整列表](../../TOOLS.md)。
- **写入默认是安全的。** 每个会修改数据的工具都会先给出预览，在应用确认之前不做任何改动。
- **回答很小。** 工具返回紧凑的数据（默认调用约 1.5 KB），不会占满你的上下文窗口。
- **一条命令完成设置。** `totem local` 或 `totem cloud` 会帮你登录 WHOOP，并设置它找到的每一个 AI 应用。

> [!NOTE]
> totem 使用的是 WHOOP 应用的私有 API，而不是公开的开发者 API，并且与 WHOOP 没有任何关联。安装前请先阅读[常见问题](#常见问题)。

## 开始使用

你需要 [Node.js 24](https://nodejs.org) 或更新版本，以及一个 WHOOP 账号。

```bash
npm install -g @thebriangao/totem
```

然后选择 totem 运行的位置：

| | 在这台电脑上运行 | 在云端运行 |
|---|---|---|
| 命令 | `totem local` | `totem cloud` |
| 适用于 | 桌面和终端应用：Claude Desktop、Claude Code、ChatGPT 桌面版和 Codex、Cursor、VS Code、OpenCode、Antigravity | 所有应用，包括 claude.ai、chatgpt.com 和手机应用 |
| 费用 | 免费 | Cloudflare 上免费，Fly.io 上每月约 4 美元 |
| 在线时间 | 电脑开着时 | 一直在线 |

两条命令都会在 WHOOP 自己的网站上打开一个浏览器窗口让你登录（totem 永远看不到你的密码），然后找到你电脑上的 AI 应用并逐一设置。之后就可以问你的应用，比如 *"我昨晚睡得怎么样？"*

### 一键部署

如果你不想用终端部署服务器：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** 会要求填写两个值：`MCP_AUTH_TOKEN`（64 个随机字符，例如 `openssl rand -hex 32` 的输出）和 `AUTH_PASSWORD`（应用连接时你要输入的密码）。它运行在免费的 Workers 套餐上。
- **Railway** 会替你生成这两个值（在服务的 Variables 中查看）。需要 Railway 的付费套餐。
- 无论哪种方式，最后都用一条命令登录 WHOOP 并把登录信息发送到你的服务器：

  ```bash
  npx @thebriangao/totem auth --url https://your-server-address
  ```

**只用 Claude Desktop：** 下载 [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) 并双击打开。用 `npx @thebriangao/totem auth --local` 登录一次。

## 连接你的应用

`totem connect` 会设置它在你电脑上找到的每个应用。云服务器还有一个 **Connect 页面**，地址是 `https://your-server/connect`，上面为每个应用准备了一个按钮或一个可直接复制的步骤，并已填好你的服务器地址。

| 应用 | 在这台电脑上 | 使用云服务器 |
|---|---|---|
| claude.ai、Claude Desktop、Claude 手机版 | Claude Desktop 的配置文件 | 一个链接，打开已填好的 claude.ai "Add custom connector"；之后它也会出现在桌面版和手机上 |
| Claude Code | `claude mcp add` | `claude mcp add --transport http`，然后用 `/mcp` 登录 |
| ChatGPT 桌面版和 Codex | `codex mcp add`（两者共用一个配置） | `codex mcp add --url` 会自己打开登录页 |
| chatgpt.com | （需要云服务器） | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | 一个 "Add to Cursor" 链接 |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | 一个 "Add to VS Code" 链接 |
| OpenCode（1 和 2） | `opencode.json` | `opencode.json`，然后 `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | 同一个文件，写入服务器地址 |

使用云服务器时，每个应用都会把你带到 totem 的登录页一次。页面会显示是哪个应用在请求、访问权限会发送到哪里，并要求输入你的连接密码。

## 托管

`totem cloud` 可以部署到以下任意一个平台，并在部署后检查服务器：

| 平台 | 费用 | 说明 |
|---|---|---|
| **Fly.io**（推荐） | 每月约 4 美元：弗吉尼亚的一台 512 MB 机器和 1 GB 存储卷 | 一直在线。撰写本文时，Fly 不会对每月不足 5 美元的个人账户收费。 |
| **Cloudflare Workers** | 免费套餐（每天 100,000 次请求） | 无需维护机器。登录信息保存在 Durable Object 中。 |
| **Railway** | Railway 付费套餐 | 浏览器中有控制台和日志。 |
| **你自己的服务器** | 由你决定 | 任何 Docker 主机。使用镜像 `ghcr.io/thebriangao/totem` 或构建 Dockerfile，并在 `/data` 挂载一个存储卷。 |

部署后，`totem status` 检查服务器和它的 WHOOP 登录，`totem logs` 显示日志，`totem deploy` 发送新版本。

## 可以问什么

- "我昨晚睡得怎么样？和我这个月比怎么样？"
- "为什么我今天的恢复这么低？"
- "显示我过去 90 天的 HRV 和静息心率。"
- "今早跑步时我的心率是多少？"
- "记录一次下午 6 点、30 分钟的步行。"
- "我昨天喝了咖啡和酒，把它加到我的日志里。"
- "记录今天的力量训练：卧推 3×5 80 公斤，深蹲 3×5 100 公斤。"
- "工作日设置 7:30 的 Smart Alarm。"

每次写入都会先返回预览。你的应用会告诉你将要改变什么，并在执行前询问你。

## 登录是如何工作的

1. `totem auth`（`local` 和 `cloud` 会替你运行它）会在 app.whoop.com 上打开一个全新的浏览器窗口。你在 WHOOP 自己的页面上登录，包括两步验证。
2. totem 只从这个窗口读取 WHOOP 的会话 cookie，然后关闭窗口并删除临时配置。
3. 登录信息保存在一个只有你能读取的文件中（`~/.config/totem/tokens.json`），或保存在你的服务器上：存储卷中，或 Cloudflare 的 Durable Object 存储中。
4. WHOOP 每次使用刷新令牌时都会换一个新的，所以同一个登录只能由一个地方持有。totem 会自动刷新它，每 12 小时一次，并且在过期前刷新，而且总是先保存新的令牌。

重新登录也是同一条命令：`totem auth`。在服务器上可以用 `totem status` 检查。

## 安全

- **你的服务器，你的密钥。** 云服务器有两个自己的密钥：`MCP_AUTH_TOKEN`（服务器的密钥，保存在你电脑上的 `.totem-deploy.json` 中）和应用连接时你输入的连接密码。
- **登录页会写明目的地。** 它显示访问权限真正发送到的地址（claude.ai、chatgpt.com、你自己电脑上的应用），绝不只显示应用自称的名字。
- **不联系其他任何地方。** 唯一的外发流量是发往 WHOOP 的。没有遥测，没有分析。
- **写入需要确认**，`whoop_raw` 的写入还需要 `allow_write`。

详见 [SECURITY.md](../../SECURITY.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `totem local` | 在这台电脑上运行：登录，然后设置你的 AI 应用 |
| `totem cloud` | 部署你自己的服务器，登录，连接你的应用 |
| `totem connect [app]` | 重新设置你的应用，或其中一个（`totem connect --print` 只显示配置） |
| `totem auth` | 登录 WHOOP（`--local`、`--url URL`、`--paste`、`--status`） |
| `totem status` / `ping` / `logs` | 检查服务器和它的登录 |
| `totem deploy` | 把当前版本部署到你的服务器 |
| `totem update` | 更新 totem（`--check`、`--auto on`） |
| `totem tools` | 列出 40 个工具 |

`totem <command> --help` 会解释每个命令。

## 故障排除

**应用里没有显示任何 WHOOP 工具。** 完全重启应用。本地设置请运行 `totem status`；服务器请运行 `totem ping`。

**"No WHOOP login on this server."** 运行 `totem auth`。如果设置了服务器，它会把登录发送过去，否则保存在这台电脑上。

**登录时找不到浏览器。** totem 使用 Chrome、Chromium、Edge 或 Brave。可以用 `TOTEM_BROWSER=/path/to/browser` 指定其他浏览器，或者运行 `totem auth --paste`，粘贴已登录 app.whoop.com 的浏览器中的 `whoop-auth-refresh-token` cookie。

**OpenCode 或其他应用的配置里有注释。** totem 不会改写它无法准确读取的文件。对于 OpenCode，它会让 OpenCode 自己添加服务器；对于其他应用，它会打印需要添加的条目。

**WHOOP 返回 5xx。** WHOOP 出了问题。一分钟后再试。

## 常见问题

**WHOOP 支持这个工具吗？**
不支持。totem 使用 WHOOP 应用的私有 API，WHOOP 并不向第三方提供它，而且 WHOOP 的条款允许他们对使用非官方工具的账号采取措施。totem 的请求和应用的请求看起来一样，频率也保持在正常人的速度，但没有任何保证。如果失去 WHOOP 账号对你来说是个问题，请不要使用它。

**为什么不用 WHOOP 的公开 API？**
它是只读的，只覆盖一小部分数据：没有日志、Strength Trainer、压力、Coach、Smart Alarm、睡眠分期图或趋势，也不能写入。如果恢复分数、睡眠总量和运动列表对你来说已经足够，请使用公开 API。

**我可以和朋友共用我的服务器吗？**
每个人都需要自己的服务器和自己的 WHOOP 登录。登录不能共用：WHOOP 每次使用都会更换刷新令牌。

**支持 WHOOP 4.0 和 5.0/MG 吗？**
支持。API 取决于你的账号，而不是你的手环。

**我的数据会去哪里？**
从 WHOOP 到你的服务器，再到你提问的应用。totem 不保留任何副本，只有一个保存最近读取结果的短暂内存缓存。

## 开发

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install && npx tsc
totem test
```

项目结构请看 [CONTRIBUTING.md](../../CONTRIBUTING.md)，关于 WHOOP API 的已知信息请看 [WHOOP.md](../../WHOOP.md)。

## 致谢

感谢所有为 v1 和 v2 提交 issue 和 pull request 的人，感谢 [Anthropic](https://anthropic.com) 创造了 MCP，也感谢多年来记录 WHOOP API 各个部分的人。

"WHOOP" 是 WHOOP, Inc. 的商标。totem 是一个独立项目，与 WHOOP 没有关联，也未获其认可或与其有任何联系。采用 MIT 许可证。
