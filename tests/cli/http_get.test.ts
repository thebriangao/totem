// Health checks follow the deployment URL's scheme. They used to speak TLS to
// everything, so a plain-http deployment (a container on the LAN, a local
// `totem start --http`) never answered and always looked down.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { runCli } from "../../src/cli/app.js";
import { writeDeployRecord } from "../../src/cli/deploy_record.js";
import { httpGet } from "../../src/cli/sys.js";
import { fakeWorld, type FakeWorld } from "./helpers.js";

describe("health checks over plain http", () => {
  let server: Server;
  let base = "";
  let world: FakeWorld | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok", build: "abc1234" }));
      } else {
        res.statusCode = 404;
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  afterEach(() => { world?.cleanup(); world = undefined; });

  it("reads an http:// URL", async () => {
    const r = await httpGet(`${base}/health`, 3000);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ status: "ok" });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("reports the real status of an http:// URL", async () => {
    expect((await httpGet(`${base}/missing`, 3000)).status).toBe(404);
  });

  it("answers status 0 with a reason for something that isn't a URL, instead of throwing", async () => {
    expect(await httpGet("not a url", 500)).toMatchObject({ status: 0, body: "", error: "not a URL" });
  });

  it("answers status 0 with a reason when nothing is listening", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await httpGet(`http://127.0.0.1:${port}/health`, 2000)).toMatchObject({ status: 0, error: "ECONNREFUSED" });
  });

  // The whole command, with the real HTTP client against a plain-http server.
  it("`totem ping` succeeds against an http deployment", async () => {
    world = fakeWorld();
    world.io.sys.httpGet = httpGet;
    writeDeployRecord(world.root, { platform: "custom", url: base });
    const app = { root: world.root, version: "1.5.1", pkgName: "x", pkgPath: join(world.root, "package.json"), cliEntry: "x" };
    expect(await runCli(["ping"], app, world.io)).toBe(0);
    expect(world.transcript()).toMatch(/The server is up {2}answered in \d+ ms, build abc1234/);
  });
});
