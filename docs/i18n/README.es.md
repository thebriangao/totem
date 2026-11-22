<p align="center"><img src="../../assets/brand/totem.svg" width="96" alt=""></p>

<h1 align="center">totem</h1>

<p align="center"><b>Tu propio servidor de WHOOP para apps de IA.</b><br>
Pregúntale a Claude, ChatGPT, Cursor o cualquier app MCP por tu recuperación, tu sueño y tu entrenamiento, y deja que registre entrenamientos, respuestas del diario y más.</p>

<p align="center">
  <a href="#primeros-pasos">Primeros pasos</a> ·
  <a href="#conecta-tus-apps">Conecta tus apps</a> ·
  <a href="#alojamiento">Alojamiento</a> ·
  <a href="../../TOOLS.md">Las 40 herramientas</a> ·
  <a href="#preguntas-frecuentes">Preguntas frecuentes</a>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  Español ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

---

totem es un pequeño servidor [MCP](https://modelcontextprotocol.io) de código abierto que habla con WHOOP igual que la app de WHOOP. Lo ejecutas tú, en tu ordenador o en un servidor en la nube que sea tuyo, y tus apps de IA se conectan a él. Tus datos solo viajan entre WHOOP, tu servidor y las apps que conectes.

- **40 herramientas.** Recuperación, fases del sueño, esfuerzo, estrés, frecuencia cardíaca, tendencias, entrenamientos, Strength Trainer, diario, WHOOP Coach, peso, seguimiento del ciclo, Smart Alarm, perfil y ajustes. [La lista completa](../../TOOLS.md).
- **Escribir es seguro por defecto.** Toda herramienta que cambia algo muestra antes una vista previa y no hace nada hasta que la app lo confirma.
- **Respuestas pequeñas.** Las herramientas devuelven datos compactos (unos 1,5 KB en una llamada normal), así que no se comen tu contexto.
- **Un solo comando.** `totem local` o `totem cloud` te ayuda a iniciar sesión en WHOOP y configura todas las apps de IA que encuentra.

> [!NOTE]
> totem usa la API privada de la app de WHOOP, no la API pública para desarrolladores, y no tiene relación con WHOOP. Lee las [preguntas frecuentes](#preguntas-frecuentes) antes de instalarlo.

## Primeros pasos

Necesitas [Node.js 24](https://nodejs.org) o posterior y una cuenta de WHOOP.

```bash
npm install -g @thebriangao/totem
```

Después elige dónde se ejecuta totem:

| | En este ordenador | En la nube |
|---|---|---|
| Comando | `totem local` | `totem cloud` |
| Funciona con | Apps de escritorio y de terminal: Claude Desktop, Claude Code, ChatGPT de escritorio y Codex, Cursor, VS Code, OpenCode, Antigravity | Todas, incluidas claude.ai, chatgpt.com y las apps del móvil |
| Coste | Gratis | Gratis en Cloudflare, unos 4 $ al mes en Fly.io |
| Disponible | Mientras el ordenador está encendido | Siempre |

Los dos comandos abren una ventana del navegador en la propia web de WHOOP para que inicies sesión (totem nunca ve tu contraseña), y luego buscan las apps de IA de tu ordenador y configuran cada una. Después pregunta a tu app algo como *"¿Qué tal dormí anoche?"*

### Con un clic

Si prefieres no usar la terminal para el servidor:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thebriangao/totem)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Z6CMWF)

- **Cloudflare** pide dos valores: `MCP_AUTH_TOKEN` (64 caracteres aleatorios, por ejemplo la salida de `openssl rand -hex 32`) y `AUTH_PASSWORD` (la contraseña que escribirás cuando una app se conecte). Funciona en el plan gratuito de Workers.
- **Railway** genera los dos por ti (están en las Variables del servicio). Necesita el plan de pago de Railway.
- En ambos casos, termina con un comando que inicia sesión en WHOOP y envía esa sesión a tu servidor:

  ```bash
  npx @thebriangao/totem auth --url https://your-server-address
  ```

**Solo Claude Desktop:** descarga [totem.mcpb](https://github.com/thebriangao/totem/releases/latest/download/totem.mcpb) y haz doble clic. Inicia sesión una vez con `npx @thebriangao/totem auth --local`.

## Conecta tus apps

`totem connect` configura todas las apps que encuentra en tu ordenador. Un servidor en la nube tiene además una **página Connect** en `https://your-server/connect`, con un botón o un paso listo para copiar para cada app, ya rellenado con la dirección de tu servidor.

| App | En este ordenador | Con un servidor en la nube |
|---|---|---|
| claude.ai, Claude Desktop, Claude móvil | El archivo de configuración de Claude Desktop | Un enlace que abre "Add custom connector" de claude.ai ya rellenado; después aparece también en el escritorio y en el móvil |
| Claude Code | `claude mcp add` | `claude mcp add --transport http` y luego `/mcp` para iniciar sesión |
| ChatGPT de escritorio y Codex | `codex mcp add` (comparten configuración) | `codex mcp add --url` abre el inicio de sesión por sí solo |
| chatgpt.com | (necesita un servidor en la nube) | Plugins → Add → Add custom MCP server |
| Cursor | `~/.cursor/mcp.json` | Un enlace "Add to Cursor" |
| VS Code (Copilot) | `~/.copilot/mcp-config.json` | Un enlace "Add to VS Code" |
| OpenCode (1 y 2) | `opencode.json` | `opencode.json` y luego `opencode mcp auth whoop` |
| Antigravity | `~/.gemini/config/mcp_config.json` | El mismo archivo, con la dirección del servidor |

Con un servidor en la nube, cada app te lleva una vez a la página de inicio de sesión de totem. Muestra qué app lo pide y adónde va el acceso, y te pide tu contraseña de conexión.

## Alojamiento

`totem cloud` despliega en cualquiera de estos y comprueba el servidor después:

| Proveedor | Coste | Notas |
|---|---|---|
| **Fly.io** (recomendado) | Unos 4 $ al mes: una máquina de 512 MB en Virginia y un volumen de 1 GB | Siempre encendido. En el momento de escribir esto, Fly no cobra a las cuentas personales menos de 5 $ al mes. |
| **Cloudflare Workers** | Plan gratuito (100.000 solicitudes al día) | Sin máquina que mantener. La sesión se guarda en un Durable Object. |
| **Railway** | Plan de pago de Railway | Panel y registros en el navegador. |
| **Tu propio servidor** | Lo que tú decidas | Cualquier host con Docker. Usa la imagen `ghcr.io/thebriangao/totem` o construye el Dockerfile, y monta un volumen en `/data`. |

Tras desplegar, `totem status` comprueba el servidor y su sesión de WHOOP, `totem logs` muestra sus registros y `totem deploy` le envía una versión nueva.

## Qué puedes preguntar

- "¿Qué tal dormí anoche y cómo se compara con el mes?"
- "¿Por qué tengo la recuperación baja hoy?"
- "Muéstrame mi VFC y mi frecuencia cardíaca en reposo de los últimos 90 días."
- "¿Cuál fue mi frecuencia cardíaca en la carrera de esta mañana?"
- "Registra un paseo de 30 minutos a las 6 de la tarde."
- "Ayer tomé cafeína y alcohol. Añádelo a mi diario."
- "Registra el entrenamiento de hoy: press de banca 3×5 con 80 kg, sentadilla 3×5 con 100 kg."
- "Pon una Smart Alarm a las 7:30 los días laborables."

Cada escritura vuelve primero como vista previa. Tu app te enseña qué va a cambiar y te pregunta antes de hacerlo.

## Cómo funciona el inicio de sesión

1. `totem auth` (que `local` y `cloud` ejecutan por ti) abre una ventana nueva del navegador en app.whoop.com. Inicias sesión allí, en la página de WHOOP y con su verificación en dos pasos.
2. totem solo lee las cookies de sesión de WHOOP de esa ventana; después la cierra y borra el perfil temporal.
3. La sesión se guarda en un archivo que solo tú puedes leer (`~/.config/totem/tokens.json`) o en tu servidor: en su volumen o en el almacenamiento de un Durable Object de Cloudflare.
4. WHOOP cambia el token de actualización cada vez que se usa, así que una sesión solo puede estar en un sitio. totem la renueva por su cuenta, cada 12 horas y antes de que caduque, y guarda siempre primero el token nuevo.

Para volver a iniciar sesión se usa el mismo comando: `totem auth`. En un servidor puedes comprobarlo con `totem status`.

## Seguridad

- **Tu servidor, tus claves.** Un servidor en la nube tiene dos secretos propios: `MCP_AUTH_TOKEN` (la clave del servidor, guardada en `.totem-deploy.json` en tu ordenador) y la contraseña de conexión que escribes cuando una app se conecta.
- **La página de inicio de sesión dice el destino.** Muestra la dirección real a la que va el acceso (claude.ai, chatgpt.com, una app de tu propio ordenador), nunca solo el nombre que dice tener una app.
- **No se contacta con nada más.** El único tráfico saliente va a WHOOP. Sin telemetría ni analítica.
- **Escribir requiere confirmación,** y las escrituras de `whoop_raw` además requieren `allow_write`.

Más en [SECURITY.md](../../SECURITY.md).

## Comandos

| Comando | Qué hace |
|---|---|
| `totem local` | Ejecutar en este ordenador: iniciar sesión y configurar tus apps de IA |
| `totem cloud` | Desplegar tu servidor, iniciar su sesión y conectar tus apps |
| `totem connect [app]` | Volver a configurar tus apps, o una sola (`totem connect --print` solo muestra la configuración) |
| `totem auth` | Iniciar sesión en WHOOP (`--local`, `--url URL`, `--paste`, `--status`) |
| `totem status` / `ping` / `logs` | Comprobar el servidor y su sesión |
| `totem deploy` | Desplegar esta versión en tu servidor |
| `totem update` | Actualizar totem (`--check`, `--auto on`) |
| `totem tools` | Listar las 40 herramientas |

`totem <command> --help` explica cada uno.

## Solución de problemas

**La app no muestra ninguna herramienta de WHOOP.** Reiníciala por completo. En una instalación local, ejecuta `totem status`; con un servidor, `totem ping`.

**"No WHOOP login on this server."** Ejecuta `totem auth`. Envía la sesión a tu servidor si hay uno configurado, o la guarda en este ordenador.

**No se encontró un navegador para iniciar sesión.** totem usa Chrome, Chromium, Edge o Brave. Indica otro con `TOTEM_BROWSER=/path/to/browser`, o ejecuta `totem auth --paste` y pega la cookie `whoop-auth-refresh-token` de un navegador con sesión iniciada en app.whoop.com.

**La configuración de OpenCode u otra app tiene comentarios.** totem no reescribe archivos que no puede leer con exactitud. En OpenCode deja que el propio OpenCode añada el servidor; en otras apps muestra la entrada que hay que añadir.

**WHOOP responde con 5xx.** WHOOP tiene problemas. Vuelve a intentarlo en un minuto.

## Preguntas frecuentes

**¿Tiene el apoyo de WHOOP?**
No. totem usa la API privada de la app de WHOOP, que WHOOP no ofrece a terceros, y sus condiciones le permiten actuar contra las cuentas que usan herramientas no oficiales. Las solicitudes de totem se parecen a las de la app y van al ritmo de una persona, pero no hay garantía. Si perder tu cuenta de WHOOP sería un problema, no lo uses.

**¿Por qué no la API pública de WHOOP?**
Es de solo lectura y cubre una parte pequeña de los datos: sin diario, Strength Trainer, estrés, Coach, Smart Alarm, hipnograma ni tendencias, y sin escrituras. Si te basta con la recuperación, los totales de sueño y una lista de entrenamientos, úsala.

**¿Puedo compartir mi servidor con un amigo?**
Cada persona necesita su propio servidor y su propia sesión de WHOOP. Una sesión no se puede compartir: WHOOP cambia el token de actualización cada vez que se usa.

**¿Funciona con WHOOP 4.0 y 5.0/MG?**
Sí. La API depende de tu cuenta, no de tu pulsera.

**¿Adónde van mis datos?**
De WHOOP a tu servidor y de ahí a la app a la que preguntaste. totem no guarda copias, solo una breve caché en memoria de las lecturas recientes.

## Desarrollo

```bash
git clone https://github.com/thebriangao/totem && cd totem
npm install && npx tsc
totem test
```

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md) para ver cómo está organizado el proyecto y [WHOOP.md](../../WHOOP.md) para lo que se sabe de la API de WHOOP.

## Agradecimientos

Gracias a todas las personas que abrieron issues y pull requests para v1 y v2, a [Anthropic](https://anthropic.com) por MCP y a quienes documentaron partes de la API de WHOOP a lo largo de los años.

"WHOOP" es una marca de WHOOP, Inc. totem es un proyecto independiente y no está afiliado, respaldado ni relacionado con WHOOP. Licencia MIT.
