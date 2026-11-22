// Health checks follow the deployment URL's scheme. They used to speak TLS to
// everything, so a plain-http deployment (a container on the LAN, a local
// `totem start --http`) never answered and always looked down.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { httpGet, ping } from "../../src/cli/ui.js";

describe("httpGet / ping over plain http", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok", agent: req.headers["user-agent"] }));
      } else {
        res.statusCode = 404;
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  it("reads an http:// URL", async () => {
    const r = await httpGet(`${base}/health`, 3000);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ status: "ok" });
  });

  it("reports the real status of an http:// URL", async () => {
    expect((await httpGet(`${base}/missing`, 3000)).status).toBe(404);
  });

  it("ping succeeds against an http deployment", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await ping(`${base}/health`, 3000)).toBe(0);
      expect(await ping(`${base}/missing`, 3000)).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it("answers status 0 for something that isn't a URL instead of throwing", async () => {
    expect(await httpGet("not a url", 500)).toEqual({ status: 0, body: "" });
  });

  it("answers status 0 when nothing is listening", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect((await httpGet(`http://127.0.0.1:${port}/health`, 2000)).status).toBe(0);
  });
});
