// `totem cloud` when it does not run straight through: a deploy that finished
// but stopped short of the last screen, and a second run over an existing
// deployment. Driven with the fake world (helpers.ts): no host, no login.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { runCli, type AppCtx } from "../../src/cli/app.js";
import { readDeployRecord } from "../../src/cli/deploy_record.js";
import type { ExecResult } from "../../src/cli/sys.js";
import { fakeWorld, PASSWORD, TOKEN, type FakeWorld, type WorldOptions } from "./helpers.js";

const out = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
/** A Fly account that is signed in and has no volume yet; everything else succeeds. */
const fly: NonNullable<WorldOptions["exec"]> = (_cmd, args) => {
  const a = args.join(" ");
  if (a === "auth whoami") return out("you@example.com\n");
  if (a.startsWith("volumes list")) return out("[]");
  return undefined;
};

let world: FakeWorld | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });

async function cloud(opts: WorldOptions, setup: (w: FakeWorld) => void = () => {}): Promise<{ w: FakeWorld; code: number; text: string }> {
  const w = fakeWorld(opts);
  world = w;
  setup(w);
  const app: AppCtx = { root: w.root, version: "1.5.1", pkgName: "@thebriangao/totem", pkgPath: join(w.root, "package.json"), cliEntry: join(w.root, "dist", "cli", "index.js") };
  const code = await runCli(["cloud"], app, w.io);
  return { w, code, text: w.transcript() };
}

describe("totem cloud: the deploy finished but the server isn't answering yet", () => {
  const notAnswering: WorldOptions = { exec: fly, http: () => ({ status: 0, body: "", ms: 3000, error: "ENOTFOUND" }) };

  // The password is set on the server by then, and no later command can show
  // it: stopping without it left a server nobody could sign in to.
  it("still hands over the connector password, once, after saying what is wrong", async () => {
    const { code, text } = await cloud(notAnswering);
    expect(code).toBe(1);
    expect(text).toContain("The deploy finished, but the server isn't answering.");
    expect(text.split(PASSWORD)).toHaveLength(2);
    expect(text.indexOf(PASSWORD)).toBeGreaterThan(text.indexOf("The deploy finished, but the server isn't answering."));
    expect(text).toContain("https://totem-c0ffee.fly.dev/mcp");
    expect(text).not.toContain(TOKEN);
  });

  it("records the server, so totem ping / auth can pick it up", async () => {
    const { w } = await cloud(notAnswering);
    expect(readDeployRecord(w.root)).toMatchObject({ platform: "fly", app: "totem-c0ffee", url: "https://totem-c0ffee.fly.dev", mcp_auth_token: TOKEN });
  });

  it("shows nothing for a password the person chose themselves", async () => {
    const own = "my own passphrase 42";
    const { text } = await cloud({ ...notAnswering, answers: [["Deploy this?", 1], ["Connector password", own]] });
    expect(text).toContain("The deploy finished, but the server isn't answering.");
    expect(text).not.toContain(own);
    expect(text).not.toContain(PASSWORD);
  });
});

// /health can say 200 at an address that is not this server (a mistyped URL, a
// host's own page). What tells a totem server apart is that /mcp refuses a
// request without the token. The WHOOP login and the server's token must not
// be sent to an address that failed that check.
describe("totem cloud: /mcp is not locked at the address", () => {
  /** Count what the login step would do: open a browser, send the login. */
  const watchLogin = (w: FakeWorld): { browser: number; pushed: number } => {
    const seen = { browser: 0, pushed: 0 };
    const auth = w.io.auth!;
    const { captureBrowserLogin, pushLogin } = auth;
    auth.captureBrowserLogin = (...args) => { seen.browser++; return captureBrowserLogin(...args); };
    auth.pushLogin = (...args) => { seen.pushed++; return pushLogin(...args); };
    return seen;
  };
  const mcpAnswers = (status: number): WorldOptions => ({
    exec: fly,
    http: (url) => (url.endsWith("/mcp") && !url.includes(".well-known") ? { status, body: "<html>hello</html>" } : undefined),
  });

  it.each([200, 404, 0])("stops before the WHOOP login when /mcp answers %i without a token", async (status) => {
    let seen = { browser: 0, pushed: 0 };
    const { code, text } = await cloud(mcpAnswers(status), (w) => { seen = watchLogin(w); });
    expect(code).toBe(1);
    expect(seen).toEqual({ browser: 0, pushed: 0 });
    expect(text).toContain("totem didn't send a WHOOP login");
    expect(text).not.toContain("5/6  WHOOP login");
    // The server may well be the right one behind a misconfigured front: the
    // deployment is recorded and the password handed over, as for any stop here.
    expect(text.split(PASSWORD)).toHaveLength(2);
  });

  it("goes on to the login when /mcp answers 401", async () => {
    let seen = { browser: 0, pushed: 0 };
    const { code, text } = await cloud({ exec: fly }, (w) => { seen = watchLogin(w); });
    expect(code).toBe(0);
    expect(seen).toEqual({ browser: 1, pushed: 1 });
    expect(text).toContain("/mcp is locked");
  });
});
