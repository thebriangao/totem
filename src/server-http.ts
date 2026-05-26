// HTTP transport entry point. Boots an MCP server over the Streamable HTTP
// transport (current MCP spec, replaces the deprecated SSE transport) behind
// a static bearer-token auth gate.
//
// Usage:
//   MCP_TRANSPORT=http MCP_AUTH_TOKEN=<random> npm start
//
// Client config — point your MCP client at `http(s)://<host>:<port>/mcp` and
// send `Authorization: Bearer <token>` on every request.
//
// Single user only. The bearer token is per-deployment, not per-request.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WhoopClient } from "./whoop/client.js";
import { registerTools } from "./tools/register.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, contentType = "application/json"): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

// Constant-time compare to dodge timing attacks on the bearer token.
function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

export interface HttpServerOptions {
  /** Bearer token clients must present. Required, ≥16 chars. */
  authToken: string;
  /** Port to listen on. Default 3000 (or $PORT / $MCP_HTTP_PORT). */
  port?: number;
  /** Host to bind. Default "0.0.0.0" (all interfaces, for container hosts). */
  host?: string;
}

export async function startHttpServer(client: WhoopClient, opts: HttpServerOptions): Promise<void> {
  if (!opts.authToken || opts.authToken.length < 16) {
    throw new Error(
      "MCP_AUTH_TOKEN must be set and at least 16 chars. Generate one with `openssl rand -hex 32`.",
    );
  }
  const port = opts.port ?? Number(process.env.PORT ?? process.env.MCP_HTTP_PORT ?? 3000);
  const host = opts.host ?? "0.0.0.0";

  // One McpServer + transport pair per active session. The MCP spec requires
  // a fresh McpServer per session because once initialize() runs on a server,
  // it can't be re-initialized. Routing is by mcp-session-id header (after
  // initialize) or by absence-of-session-id (creates a new session).
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  async function getOrCreateSession(
    existingSessionId: string | undefined,
  ): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> {
    if (existingSessionId) {
      const existing = sessions.get(existingSessionId);
      if (existing) return existing;
      // Fall through and create a new one — the transport will return 404
      // when handleRequest sees the unknown session-id header, which is the
      // MCP-spec-compliant behavior.
    }
    const newId = randomUUID();
    const newServer = new McpServer({ name: "whoop", version: "1.1.0" });
    registerTools(newServer, client);
    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newId,
      enableJsonResponse: true,
    });
    newTransport.onclose = (): void => {
      sessions.delete(newId);
    };
    await newServer.connect(newTransport as Parameters<typeof newServer.connect>[0]);
    const entry = { server: newServer, transport: newTransport };
    sessions.set(newId, entry);
    return entry;
  }

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res, getOrCreateSession, opts.authToken);
  });

  httpServer.listen(port, host, () => {
    console.error(`[whoop-mcp] listening on http://${host}:${port}${MCP_PATH}`);
    console.error(`[whoop-mcp] health check: GET ${HEALTH_PATH}`);
    console.error(`[whoop-mcp] auth: Bearer <token from MCP_AUTH_TOKEN>`);
  });

  const close = (): void => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

type SessionResolver = (
  existingSessionId: string | undefined,
) => Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }>;

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getOrCreateSession: SessionResolver,
  authToken: string,
): Promise<void> {
  try {
    const url = req.url ?? "/";

    // Health check — no auth, no body parsing. Container hosts probe this.
    if (url === HEALTH_PATH && req.method === "GET") {
      send(res, 200, JSON.stringify({ status: "ok" }));
      return;
    }

    if (!url.startsWith(MCP_PATH)) {
      send(res, 404, JSON.stringify({ error: "not found" }));
      return;
    }

    // CORS (rare for MCP, but a browser-based client could hit this)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    const presented = extractBearer(req);
    if (!presented || !tokensEqual(presented, authToken)) {
      // Don't reveal whether the token was missing vs wrong.
      res.setHeader("WWW-Authenticate", 'Bearer realm="whoop-mcp"');
      send(res, 401, JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Pre-parse the POST body so the transport can use it directly.
    let parsedBody: unknown = undefined;
    if (req.method === "POST") {
      const buf = await readBody(req);
      if (buf.length > 0) {
        try {
          parsedBody = JSON.parse(buf.toString("utf8"));
        } catch {
          send(res, 400, JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }
    }

    // Route to a per-session McpServer + transport. New clients get a fresh
    // pair; clients sending mcp-session-id reuse their existing pair.
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sid = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
    const session = await getOrCreateSession(sid);
    await session.transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    console.error("[whoop-mcp] request error:", err);
    if (!res.headersSent) {
      send(res, 500, JSON.stringify({ error: "internal server error" }));
    }
  }
}
