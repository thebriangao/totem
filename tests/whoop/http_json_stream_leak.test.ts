// Exercise the SDK over real HTTP: settled JSON streams must not retain each
// response body for the life of a session. No Whoop client or API calls.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { releaseSettledJsonStreams } from "../../src/server-http.js";

function streams(t: StreamableHTTPServerTransport): Map<string, unknown> {
  return (t as unknown as { _webStandardTransport: { _streamMapping: Map<string, unknown> } })
    ._webStandardTransport._streamMapping;
}

describe("HTTP transport: JSON-response stream cleanup", () => {
  let http: Server;
  let server: McpServer;
  let transport: StreamableHTTPServerTransport;
  let url: string;
  let release: boolean;
  let finishSlow: () => void;
  let slowStarted: Promise<void>;

  const post = async (body: unknown, sid?: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      body: JSON.stringify(body),
    });

  const call = (id: number, n = id): Promise<Response> => post({
    jsonrpc: "2.0", id, method: "tools/call", params: { name: "big", arguments: { n } },
  }, "s1");

  beforeEach(async () => {
    release = true;
    let markSlowStarted: () => void;
    slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
    const slow = new Promise<void>((resolve) => { finishSlow = resolve; });
    server = new McpServer({ name: "leak-test", version: "0" });
    server.tool("big", "returns ~100 KB", { n: z.number() }, async ({ n }) => {
      if (n === 0) {
        markSlowStarted();
        await slow;
      }
      return { content: [{ type: "text", text: `${n}:`.padEnd(100_000, "x") }] };
    });
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => "s1",
      enableJsonResponse: true,
    });
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    http = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
          .finally(() => { if (release) releaseSettledJsonStreams(transport); })
          .catch(() => { res.destroy(); });
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    url = `http://127.0.0.1:${address.port}/mcp`;

    const init = await post({
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBe("s1");
    await init.text();
    const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, "s1");
    expect(initialized.status).toBe(202);
    await initialized.text();
    await vi.waitFor(() => expect(streams(transport).size).toBe(0));
  });

  afterEach(async () => {
    finishSlow();
    await server.close();
    await new Promise<void>((resolve, reject) => http.close((err) => err ? reject(err) : resolve()));
  });

  it("releases response bodies across many calls in one session", async () => {
    for (let id = 1; id <= 20; id++) {
      const response = await call(id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const body = await response.json();
      expect(body.id).toBe(id);
      expect(body.result.content[0].text).toBe(`${id}:`.padEnd(100_000, "x"));
    }
    await vi.waitFor(() => expect(streams(transport).size).toBe(0));
  });

  it("preserves an in-flight stream while another request finishes", async () => {
    const slow = call(1, 0);
    try {
      await slowStarted;
      const fast = await call(2);
      expect(fast.status).toBe(200);
      await fast.text();
      await vi.waitFor(() => expect(streams(transport).size).toBe(1));
    } finally {
      finishSlow();
    }
    const response = await slow;
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(1);
    await vi.waitFor(() => expect(streams(transport).size).toBe(0));
  });

  // Canary: if an SDK upgrade fixes this, remove the workaround and this test.
  it("SDK still retains JSON streams without the workaround", async () => {
    release = false;
    for (let id = 1; id <= 5; id++) {
      const response = await call(id);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(streams(transport).size).toBe(5);
  });
});

describe("releaseSettledJsonStreams", () => {
  it("does nothing when the SDK's private maps are absent or changed", () => {
    for (const inner of [undefined, null, {}, { _streamMapping: new Map() },
      { _streamMapping: {}, _requestToStreamMapping: new Map() },
      { _streamMapping: new Map(), _requestToStreamMapping: {} }]) {
      const transport = { _webStandardTransport: inner } as unknown as StreamableHTTPServerTransport;
      expect(releaseSettledJsonStreams(transport)).toBe(0);
    }
  });

  it("leaves pending JSON streams, SSE streams and unknown entries alone", () => {
    const entries = new Map<string, unknown>([
      ["settled", { resolveJson: () => undefined }],
      ["pending", { resolveJson: () => undefined }],
      ["sse", { cleanup: () => undefined }],
      ["unknown", null],
    ]);
    const transport = { _webStandardTransport: {
      _streamMapping: entries,
      _requestToStreamMapping: new Map([[1, "pending"]]),
    } } as unknown as StreamableHTTPServerTransport;
    expect(releaseSettledJsonStreams(transport)).toBe(1);
    expect([...entries.keys()]).toEqual(["pending", "sse", "unknown"]);
    expect(releaseSettledJsonStreams(transport)).toBe(0);
  });
});
