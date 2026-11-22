<h1 align="center">totem</h1>

<p align="center"><b>Seu próprio servidor do WHOOP para apps de IA.</b><br>
Pergunte ao Claude, ao ChatGPT, ao Cursor ou a qualquer app MCP sobre sua recuperação, seu sono e seu treino, e deixe que ele registre treinos, respostas do diário e mais.</p>

<p align="center">
  <a href="#primeiros-passos">Primeiros passos</a> ·
  <a href="#conecte-seus-apps">Conecte seus apps</a> ·
  <a href="#hospedagem">Hospedagem</a> ·
  <a href="../../TOOLS.md">As 40 ferramentas</a> ·
  <a href="#perguntas-frequentes">Perguntas frequentes</a>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  Português ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

---

O totem é um pequeno servidor [MCP](https://modelcontextprotocol.io) de código aberto que conversa com o WHOOP do mesmo jeito que o app do WHOOP. Você mesmo o executa, no seu computador ou em um servidor na nuvem que seja seu, e seus apps de IA se conectam a ele. Seus dados só passam entre o WHOOP, o seu servidor e os apps que você conectar.

- **40 ferramentas.** Recuperação, estágios do sono, esforço, estresse, frequência cardíaca, tendências, treinos, Strength Trainer, diário, WHOOP Coach, peso, acompanhamento do ciclo, Smart Alarm, perfil e configurações. [A lista completa](../../TOOLS.md).
- **Escrever é seguro por padrão.** Toda ferramenta que muda algo mostra uma prévia antes e não faz nada até o app confirmar.
- **Respostas pequenas.** As ferramentas devolvem dados compactos (cerca de 1,5 KB numa chamada padrão), então não consomem seu contexto.
- **Um comando só.** `totem local` ou `totem cloud` ajuda você a entrar no WHOOP e configura todos os apps de IA que encontrar.

> [!NOTE]
> O totem usa a API privada do app do WHOOP, não a API pública para desenvolvedores, e não tem ligação com o WHOOP. Leia as [perguntas frequentes](#perguntas-frequentes) antes de instalar.

## Primeiros passos

Você precisa do [Node.js 24](https://nodejs.org) ou mais recente e de uma conta do WHOOP.

```bash
npm install -g @thebriangao/totem
```

Depois escolha onde o totem vai rodar:

| | Neste computador | Na nuvem |
|---|---|---|
| Comando | `totem local` | `totem cloud` |
| Funciona com | Apps de desktop e de terminal: Claude Desktop, Claude Code, ChatGPT para desktop e Codex, Cursor, VS Code, OpenCode, Antigravity | Todos, incluindo claude.ai, chatgpt.com e os apps de celular |
| Custo | Grátis | Grátis no Cloudflare, cerca de US$ 4 por mês no Fly.io |
| Disponível | Enquanto o computador estiver ligado | Sempre |

Os dois comandos abrem uma janela do navegador no próprio site do WHOOP para você entrar (o totem nunca vê sua senha), depois encontram os apps de IA do seu computador e configuram cada um. Então pergunte ao seu app algo como *"Como eu dormi ontem à noite?"*

### Com um clique

Se você prefere não usar o terminal para o servidor:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- O **Cloudflare** pede dois valores: `MCP_AUTH_TOKEN` (64 caracteres aleatórios, por exemplo a saída de `openssl rand -hex 32`) e `AUTH_PASSWORD` (a senha que você vai digitar quando um app se conectar). Roda no plano gratuito do Workers.
- O **Railway** gera os dois para você (veja nas Variables do serviço). Precisa do plano pago do Railway.
- Nos dois casos, termine com um comando que entra no WHOOP e envia esse login ao seu servidor:

  ```bash
  npx @thebriangao/totem auth --url https://your-server-address
  ```

**Só Claude Desktop:** baixe o [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) e dê dois cliques. Entre uma vez com `npx @thebriangao/totem auth --local`.

## Conecte seus apps

O `totem connect` configura todos os apps que encontra no seu computador. Um servidor na nuvem também tem uma **página Connect** em `https://your-server/connect`, com um botão ou um passo pronto para copiar para cada app, já preenchido com o endereço do seu servidor.

| App | Neste computador | Com um servidor na nuvem |
|---|---|---|
| claude.ai, Claude Desktop, Claude no celular | O arquivo de configuração do Claude Desktop | Um link que abre o "Add custom connector" do claude.ai já preenchido; depois ele aparece também no desktop e no celular |
| Claude Code | `claude mcp add` | `claude mcp add --transport http` e depois `/mcp` para entrar |
| ChatGPT para desktop e Codex | `codex mcp add` (compartilham a configuração) | `codex mcp add --url` abre o login sozinho |
| chatgpt.com | (precisa de um servidor na nuvem) | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | Um link "Add to Cursor" |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | Um link "Add to VS Code" |
| OpenCode (1 e 2) | `opencode.json` | `opencode.json` e depois `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | O mesmo arquivo, com o endereço do servidor |

Com um servidor na nuvem, cada app leva você uma vez à página de login do totem. Ela mostra qual app está pedindo e para onde vai o acesso, e pede sua senha de conexão.

## Hospedagem

O `totem cloud` publica em qualquer um destes e verifica o servidor depois:

| Hospedagem | Custo | Observações |
|---|---|---|
| **Fly.io** (recomendado) | Cerca de US$ 4 por mês: uma máquina de 512 MB na Virgínia e um volume de 1 GB | Sempre ligado. No momento em que isto foi escrito, o Fly não cobra contas pessoais por menos de US$ 5 por mês. |
| **Cloudflare Workers** | Plano gratuito (100.000 requisições por dia) | Nenhuma máquina para cuidar. O login fica em um Durable Object. |
| **Railway** | Plano pago do Railway | Painel e logs no navegador. |
| **Seu próprio servidor** | Você decide | Qualquer host com Docker. Use a imagem `ghcr.io/thebriangao/totem` ou construa o Dockerfile, e monte um volume em `/data`. |

Depois de publicar, `totem status` verifica o servidor e o login do WHOOP, `totem logs` mostra os logs e `totem deploy` envia uma versão nova.

## O que você pode perguntar

- "Como eu dormi ontem à noite e como isso se compara ao meu mês?"
- "Por que minha recuperação está baixa hoje?"
- "Mostre minha VFC e minha frequência cardíaca em repouso dos últimos 90 dias."
- "Qual foi minha frequência cardíaca na corrida de hoje de manhã?"
- "Registre uma caminhada de 30 minutos às 18h."
- "Ontem tomei cafeína e álcool. Coloque isso no meu diário."
- "Registre o treino de hoje: supino 3×5 com 80 kg, agachamento 3×5 com 100 kg."
- "Coloque um Smart Alarm para 7h30 nos dias úteis."

Toda escrita volta primeiro como prévia. Seu app mostra o que vai mudar e pergunta antes de fazer.

## Como o login funciona

1. `totem auth` (que `local` e `cloud` executam por você) abre uma janela nova do navegador em app.whoop.com. Você entra ali, na página do próprio WHOOP, com a verificação em duas etapas.
2. O totem lê só os cookies de sessão do WHOOP dessa janela; depois fecha a janela e apaga o perfil temporário.
3. O login fica em um arquivo que só você pode ler (`~/.config/totem/tokens.json`) ou no seu servidor: no volume dele ou no armazenamento de um Durable Object do Cloudflare.
4. O WHOOP troca o token de atualização toda vez que ele é usado, então um login só pode ficar em um lugar. O totem renova sozinho, a cada 12 horas e antes de expirar, e sempre salva o token novo primeiro.

Para entrar de novo, é o mesmo comando: `totem auth`. Num servidor, você confere com `totem status`.

## Segurança

- **Seu servidor, suas chaves.** Um servidor na nuvem tem dois segredos próprios: `MCP_AUTH_TOKEN` (a chave do servidor, guardada em `.totem-deploy.json` no seu computador) e a senha de conexão que você digita quando um app se conecta.
- **A página de login diz o destino.** Ela mostra o endereço real para onde o acesso vai (claude.ai, chatgpt.com, um app no seu próprio computador), nunca só o nome que um app diz ter.
- **Nada mais é contatado.** O único tráfego de saída vai para o WHOOP. Sem telemetria, sem análises.
- **Escrever exige confirmação,** e as escritas do `whoop_raw` também exigem `allow_write`.

Mais em [SECURITY.md](../../SECURITY.md).

## Comandos

| Comando | O que faz |
|---|---|
| `totem local` | Rodar neste computador: entrar e configurar seus apps de IA |
| `totem cloud` | Publicar seu servidor, fazer o login dele e conectar seus apps |
| `totem connect [app]` | Configurar seus apps de novo, ou só um (`totem connect --print` só mostra a configuração) |
| `totem auth` | Entrar no WHOOP (`--local`, `--url URL`, `--paste`, `--status`) |
| `totem status` / `ping` / `logs` | Verificar o servidor e o login |
| `totem deploy` | Publicar esta versão no seu servidor |
| `totem update` | Atualizar o totem (`--check`, `--auto on`) |
| `totem tools` | Listar as 40 ferramentas |

`totem <command> --help` explica cada um.

## Solução de problemas

**O app não mostra nenhuma ferramenta do WHOOP.** Reinicie o app por completo. Na instalação local, rode `totem status`; com um servidor, `totem ping`.

**"No WHOOP login on this server."** Rode `totem auth`. Ele envia o login ao seu servidor se houver um configurado, ou salva neste computador.

**Nenhum navegador foi encontrado para o login.** O totem usa Chrome, Chromium, Edge ou Brave. Indique outro com `TOTEM_BROWSER=/path/to/browser`, ou rode `totem auth --paste` e cole o cookie `whoop-auth-refresh-token` de um navegador conectado ao app.whoop.com.

**A configuração do OpenCode ou de outro app tem comentários.** O totem não reescreve arquivos que não consegue ler com exatidão. No OpenCode, ele deixa o próprio OpenCode adicionar o servidor; nos outros, mostra a entrada a adicionar.

**O WHOOP responde 5xx.** O WHOOP está com problemas. Tente de novo em um minuto.

## Perguntas frequentes

**O WHOOP apoia isto?**
Não. O totem usa a API privada do app do WHOOP, que o WHOOP não oferece a terceiros, e os termos do WHOOP permitem agir contra contas que usam ferramentas não oficiais. As requisições do totem parecem as do app e seguem o ritmo de uma pessoa, mas não há garantia. Se perder sua conta do WHOOP seria um problema, não use.

**Por que não a API pública do WHOOP?**
Ela é só de leitura e cobre uma parte pequena dos dados: sem diário, Strength Trainer, estresse, Coach, Smart Alarm, hipnograma ou tendências, e sem escritas. Se recuperação, totais de sono e uma lista de treinos bastam para você, use-a.

**Posso dividir meu servidor com um amigo?**
Cada pessoa precisa do próprio servidor e do próprio login do WHOOP. Um login não pode ser compartilhado: o WHOOP troca o token de atualização a cada uso.

**Funciona com WHOOP 4.0 e 5.0/MG?**
Sim. A API depende da sua conta, não da sua pulseira.

**Para onde vão meus dados?**
Do WHOOP para o seu servidor e dele para o app a quem você perguntou. O totem não guarda cópias, só um cache curto em memória das leituras recentes.

## Desenvolvimento

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install && npx tsc
totem test
```

Veja o [CONTRIBUTING.md](../../CONTRIBUTING.md) para entender a organização do projeto e o [WHOOP.md](../../WHOOP.md) para o que se sabe sobre a API do WHOOP.

## Agradecimentos

Obrigado a todos que abriram issues e pull requests para a v1 e a v2, à [Anthropic](https://anthropic.com) pelo MCP e às pessoas que documentaram partes da API do WHOOP ao longo dos anos.

"WHOOP" é uma marca da WHOOP, Inc. O totem é um projeto independente e não é afiliado, endossado nem ligado ao WHOOP. Licença MIT.
