<p align="center"><img src="../../assets/brand/totem.svg" width="80" alt="totem"></p>

<h1 align="center">totem</h1>

<p align="center"><b>在 Claude、ChatGPT 和你常用的 AI 应用里使用你的 WHOOP 数据。</b><br>
一个由你自己运行的开源 MCP 服务器，一条命令就能装好。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@thebriangao/totem"><img src="https://img.shields.io/npm/v/%40thebriangao%2Ftotem?style=flat-square&labelColor=141414&color=7A9CC6" alt="npm version"></a>
  <a href="https://github.com/thebriangao/totem/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/thebriangao/totem/ci.yml?branch=main&style=flat-square&labelColor=141414&label=tests" alt="tests"></a>
  <a href="../../TOOLS.md"><img src="https://img.shields.io/badge/MCP-41%20tools-7A9CC6?style=flat-square&labelColor=141414" alt="41 MCP tools"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-7A9CC6?style=flat-square&labelColor=141414" alt="Node 24 or newer">
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-7A9CC6?style=flat-square&labelColor=141414" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#可以问什么">可以问什么</a> ·
  <a href="#连接你的应用">连接你的应用</a> ·
  <a href="#托管">托管</a> ·
  <a href="../../TOOLS.md">工具</a> ·
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

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/totem-local-dark.svg">
    <img src="../media/totem-local-light.svg" width="668" alt="终端里运行 totem local：检查 Node.js，在浏览器窗口中登录 WHOOP，然后把 totem 添加到 Claude Desktop、Claude Code、ChatGPT、OpenCode 和 Antigravity。">
  </picture>
</p>

totem 把你的 WHOOP 账号连接到你的 AI 应用。你可以问昨晚睡得怎么样、今天的恢复为什么低、这个季度的 HRV 有什么变化，也可以让应用帮你记录一次运动或填写日志。

它是一个小型服务器，用 [MCP](https://modelcontextprotocol.io) 和你的应用对话，并用和 WHOOP 应用相同的方式与 WHOOP 通信。你可以在自己的电脑上运行它，也可以放在你自己的云服务器上。

- **41 个工具。** 恢复、睡眠、负荷、压力、心率、趋势、运动、Strength Trainer、日志、WHOOP Coach、体重、周期追踪、Smart Alarm、个人资料和设置。[查看全部](../../TOOLS.md)。
- **没有你的同意，什么都不会改。** 每个会写入数据的工具都会先给出预览，等你确认后才执行。
- **不占上下文。** 默认的一次回答约 1.5 KB，为对话留出空间。
- **一条命令。** `totem local` 或 `totem cloud` 会帮你登录 WHOOP，并把 totem 添加到它找到的 AI 应用里。

> [!NOTE]
> totem 使用的是 WHOOP 应用的私有 API，而不是公开的开发者 API，并且与 WHOOP 没有任何关联。安装前请先阅读[常见问题](#常见问题)。

## 快速开始

你需要 [Node.js 24](https://nodejs.org) 或更新版本，以及一个 WHOOP 账号。

**1. 安装。**

```bash
npm install -g @thebriangao/totem
```

**2. 选择运行的位置。**

| | 在这台电脑上 | 在云端 |
|---|---|---|
| 命令 | `totem local` | `totem cloud` |
| 适用于 | 桌面和终端应用：Claude Desktop、Claude Code、ChatGPT 桌面版和 Codex、Cursor、VS Code、OpenCode、Antigravity | 左边的全部，再加上 claude.ai、chatgpt.com 和手机上的 Claude |
| 费用 | 免费 | Cloudflare 上免费，Fly.io 上每月约 4 美元 |
| 可用时间 | 电脑开着的时候 | 一直在线 |

两条命令都会在 WHOOP 自己的网站上打开一个浏览器窗口让你登录，totem 永远看不到你的密码。然后它会找到你电脑上的 AI 应用，并询问是否把自己添加到每个应用里。

**3. 问点什么。**

打开你的应用，试着问：*“我昨晚睡得怎么样？”*

随时可以单独运行 `totem`，查看当前的状态。

### 想一键部署？

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** 会要求填写两个值：`MCP_AUTH_TOKEN`（64 个随机字符，例如 `openssl rand -hex 32` 的输出）和 `AUTH_PASSWORD`（应用连接时你要输入的密码）。它运行在免费的 Workers 套餐上。
- **Railway** 会替你生成这两个值（在服务的 Variables 里可以看到）。需要 Railway 的付费套餐。

然后登录 WHOOP，并把登录信息发送到你的服务器：

```bash
npx @thebriangao/totem auth --url https://your-server-address
```

**只用 Claude Desktop？** 下载 [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb)，双击打开，再用 `npx @thebriangao/totem auth --local` 登录一次。

## 可以问什么

- “我昨晚睡得怎么样？和这个月相比呢？”
- “为什么我今天的恢复这么低？”
- “显示我过去 90 天的 HRV 和静息心率。”
- “今早跑步时我的心率是多少？”
- “记录一次下午 6 点、30 分钟的步行。”
- “我昨天喝了咖啡和酒，把它加到我的日志里。”
- “记录今天的力量训练：卧推 3×5 80 公斤，深蹲 3×5 100 公斤。”
- “工作日设置 7:30 的 Smart Alarm。”

所有写入都会先返回预览。你的应用会告诉你将要改变什么，并在执行前征求你的同意。

## 连接你的应用

`totem connect` 会设置你电脑上的应用。云服务器还有一个 Connect 页面，地址是 `https://your-server/connect`，上面为每个应用准备了一个按钮或一个可直接复制的步骤，并且已经填好你的服务器地址。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/connect-page-dark.png">
    <img src="../media/connect-page-light.png" width="49%" alt="Connect 页面：服务器地址，以及每个应用的一张卡片，上面有一个按钮或一条可复制的命令。">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/consent-page-dark.png">
    <img src="../media/consent-page-light.png" width="49%" alt="登录页：是哪个应用在请求、访问权限会发送到哪里、请求的权限，以及连接密码。">
  </picture>
</p>

使用云服务器时，每个应用都会把你带到 totem 的登录页一次。页面会写明是哪个应用在请求、访问权限会发送到哪里，并要求输入你的连接密码。

<details>
<summary><b>每个应用的具体步骤</b></summary>

<br>

| 应用 | 在这台电脑上 | 使用云服务器 |
|---|---|---|
| claude.ai、Claude Desktop、Claude 手机版 | Claude Desktop 的配置文件 | 一个链接，打开已填好的 claude.ai “Add custom connector”。之后它也会出现在桌面版和手机上 |
| Claude Code | `claude mcp add` | `claude mcp add --transport http`，然后用 `/mcp` 登录 |
| ChatGPT 桌面版和 Codex | `codex mcp add`（两者共用一个配置） | `codex mcp add --url`，它会自己打开登录页 |
| chatgpt.com | 需要云服务器 | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | 一个 “Add to Cursor” 链接 |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | 一个 “Add to VS Code” 链接 |
| OpenCode（1 和 2） | `opencode.json` | `opencode.json`，然后运行 `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | 同一个文件，写入服务器地址 |

`totem connect <app>` 只设置一个应用，`totem connect --print` 只显示它会添加的内容，不做任何改动。

</details>

## 托管

`totem cloud` 可以部署到下面任意一个平台，并在部署后检查服务器是否有响应。

| 平台 | 费用 | 说明 |
|---|---|---|
| **Cloudflare Workers**（推荐） | 免费套餐，每天 100,000 次请求 | 没有机器需要维护。登录信息保存在 Durable Object 中。 |
| **Fly.io** | 每月约 4 美元：弗吉尼亚的一台 512 MB 机器和 1 GB 存储卷 | 一直在线。撰写本文时，Fly 不会对每月不足 5 美元的个人账户收费。 |
| **Railway** | Railway 的付费套餐 | 浏览器里有控制台和日志。 |
| **你自己的服务器** | 由你决定 | 任何 Docker 主机。totem 会写好配置并打印要运行的命令，你也可以直接用镜像 `ghcr.io/thebriangao/totem`。在 `/data` 挂载一个存储卷。 |

部署之后，`totem status` 检查服务器和它的 WHOOP 登录，`totem logs` 显示日志，`totem deploy` 把新版本发送上去。

## 工作原理

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../media/how-it-works-dark.svg">
    <img src="../media/how-it-works-light.svg" width="820" alt="WHOOP 通过 WHOOP 的应用 API 与你的 totem 服务器通信。你的 AI 应用通过 MCP 与你的 totem 服务器通信。totem 运行在你的电脑或你自己的云服务器上。">
  </picture>
</p>

你的数据从 WHOOP 到你的 totem，再到你提问的应用，不会去别的地方。中间没有 totem 公司，没有共享服务器，也没有任何统计分析。

### WHOOP 登录

1. `totem auth`（`local` 和 `cloud` 会替你运行它）会在 app.whoop.com 上打开一个全新的浏览器窗口。你在 WHOOP 自己的页面上登录，包括两步验证。
2. totem 只从这个窗口读取 WHOOP 的会话 cookie，然后关闭窗口并删除临时配置文件。
3. 登录信息保存在一个只有你能读取的文件中（`~/.config/totem/tokens.json`），或保存在你的服务器上：存储卷中，或 Cloudflare 的 Durable Object 存储中。
4. WHOOP 每次使用刷新令牌时都会换一个新的，所以一个登录只能由一个地方持有。totem 会自动刷新它，每 12 小时一次，并且赶在过期之前，而且总是先保存新的令牌。

要重新登录，运行 `totem auth`。

### 安全

- **你的服务器，你的密钥。** 云服务器有两个自己的密钥：`MCP_AUTH_TOKEN`（服务器的密钥，保存在你电脑上的 `~/.config/totem/deploy.json` 中）和应用连接时你输入的连接密码。
- **登录页会写明目的地。** 它显示访问权限真正发送到的地址（claude.ai、chatgpt.com、你自己电脑上的应用），绝不只显示应用自称的名字。
- **服务器只和 WHOOP 以及你的应用通信。** 没有遥测，没有统计分析。
- **写入需要确认**，`whoop_raw` 的写入还需要 `allow_write`。

详见 [SECURITY.md](../../SECURITY.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `totem` | 显示当前安装的状态，以及下一步该运行什么 |
| `totem local` | 在这台电脑上运行：登录，然后设置你的 AI 应用 |
| `totem cloud` | 部署你自己的服务器，登录，连接你的应用 |
| `totem connect [app]` | 重新设置你的应用，或只设置其中一个 |
| `totem auth` | 登录 WHOOP（`--local`、`--url URL`、`--paste`、`--status`） |
| `totem status` / `ping` / `logs` | 检查服务器和它的登录 |
| `totem deploy` | 把当前版本部署到你的服务器 |
| `totem update` | 更新 totem（`--check`、`--auto on`） |
| `totem tools` | 列出 41 个工具 |

`totem <command> --help` 会解释每个命令。

## 故障排除

**应用里没有显示任何 WHOOP 工具。** 完全重启应用。本地运行的话，执行 `totem status`。用服务器的话，执行 `totem ping`。

**"No WHOOP login on this server."** 运行 `totem auth`。如果设置了服务器，它会把登录发送过去，否则保存在这台电脑上。

**登录时找不到浏览器。** totem 使用 Chrome、Chromium、Edge 或 Brave。可以用 `TOTEM_BROWSER=/path/to/browser` 指定其他浏览器，或者运行 `totem auth --paste`，粘贴已登录 app.whoop.com 的浏览器中的 `whoop-auth-refresh-token` cookie。

**OpenCode 或其他应用的配置里有注释。** totem 不会改写它无法准确读取的文件。对于 OpenCode，它会让 OpenCode 自己添加服务器。对于其他应用，它会打印需要添加的条目。

**WHOOP 返回 5xx。** WHOOP 出了问题。一分钟后再试。

## 常见问题

**WHOOP 支持这个工具吗？**
不支持。totem 使用 WHOOP 应用的私有 API，WHOOP 并不向第三方提供它，而且 WHOOP 的条款允许他们对使用非官方工具的账号采取措施。totem 的请求和应用的请求看起来一样，频率也保持在正常人使用的速度，但没有任何保证。如果失去 WHOOP 账号对你来说是个问题，请不要使用它。

**为什么不用 WHOOP 的公开 API？**
它是只读的，只覆盖一小部分数据：没有日志、Strength Trainer、压力、Coach、Smart Alarm、睡眠分期图或趋势，也不能写入。如果恢复、睡眠总量和运动列表对你来说已经足够，请使用公开 API。

**我可以和朋友共用我的服务器吗？**
不可以。每个人都需要自己的服务器和自己的 WHOOP 登录。登录不能共用，因为 WHOOP 每次使用都会更换刷新令牌。

**支持 WHOOP 4.0 和 5.0/MG 吗？**
支持。API 取决于你的账号，而不是你的手环。

**我的数据会去哪里？**
从 WHOOP 到你的服务器，再到你提问的应用。totem 不保留任何副本，只在内存中缓存最近读取的结果。

## 参与贡献

欢迎提交 issue 和 pull request。要在本地开发 totem：

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install
npx tsc && npm link     # 构建一次，并把 `totem` 放到你的 PATH 中
totem test
```

[CONTRIBUTING.md](../../CONTRIBUTING.md) 介绍了项目的结构，[WHOOP.md](../../WHOOP.md) 记录了目前对 WHOOP API 的了解。

## 致谢

感谢所有为 v1 和 v2 提交 issue 和 pull request 的人，感谢 [Anthropic](https://anthropic.com) 创造了 MCP，也感谢多年来记录 WHOOP API 各个部分的人。

## 许可证

[MIT](../../LICENSE)。“WHOOP” 是 WHOOP, Inc. 的商标。totem 是一个独立项目，与 WHOOP 没有关联，也未获其认可或与其有任何联系。
