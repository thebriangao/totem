// `totem cloud` when it does not run straight through: a deploy that finished
// but stopped short of the last screen, and a second run over an existing
// deployment. Driven with the fake world (helpers.ts): no host, no login.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { runCli, type AppCtx } from "../../src/cli/app.js";
import { readDeployRecord, writeDeployRecord } from "../../src/cli/deploy_record.js";
import { secretForms } from "../../src/cli/setup.js";
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

// totem blanks this deploy's secrets in whatever a host CLI prints. A CLI that
// echoes its input rarely echoes it raw: it is inside JSON, or a URL.
describe("totem cloud: a host CLI echoes a chosen password back, escaped", () => {
  const own = 'p@ss word&"quote\\slash-1234';
  const echoed = [
    `Error: could not set secrets`,
    `body={"AUTH_PASSWORD":${JSON.stringify(own)}}`,
    `query=AUTH_PASSWORD=${encodeURIComponent(own)}`,
    `form=AUTH_PASSWORD=${encodeURIComponent(own).replace(/%20/g, "+")}`,
    `raw=AUTH_PASSWORD=${own}`,
  ].join("\n");
  const echoing: WorldOptions = {
    answers: [["Deploy this?", 1], ["Connector password", own], ["What now?", 1]],
    exec: (cmd, args, input, w) => (args.join(" ").startsWith("secrets import") ? { code: 1, stdout: "", stderr: `${echoed}\n` } : fly(cmd, args, input, w)),
  };

  it("blanks it in every form", async () => {
    const { code, text } = await cloud(echoing);
    expect(code).toBe(1);
    for (const line of ['body={"AUTH_PASSWORD":"***"}', "query=AUTH_PASSWORD=***", "form=AUTH_PASSWORD=***", "raw=AUTH_PASSWORD=***"]) expect(text).toContain(line);
    for (const leak of [own, JSON.stringify(own).slice(1, -1), encodeURIComponent(own), "p%40ss", "quote%5Cslash"]) expect(text).not.toContain(leak);
  });

  it("lists each form once, and none for an empty secret", () => {
    expect(secretForms("Kq7m-Rt2x-Vb9n-Lp4w-Hd6s")).toEqual(["Kq7m-Rt2x-Vb9n-Lp4w-Hd6s"]);
    expect(secretForms(own)).toEqual([own, 'p@ss word&\\"quote\\\\slash-1234', "p%40ss%20word%26%22quote%5Cslash-1234", "p%40ss+word%26%22quote%5Cslash-1234"]);
    expect(secretForms("")).toEqual([]);
    expect(secretForms("\ud800 lone surrogate")).toHaveLength(2); // no percent form, and no throw
  });
});

// The deploy record holds the only local copy of a deployed server's
// MCP_AUTH_TOKEN. A second `totem cloud` used to write a new server over it
// without a word, leaving the first one running, billed, and out of reach.
describe("totem cloud: this install already has a server", () => {
  const OLD = { platform: "fly", app: "totem-old", url: "https://totem-old.fly.dev", mcp_auth_token: "0ld".repeat(21) + "0" };
  const deployed = (w: FakeWorld): void => writeDeployRecord(w.root, OLD);

  it("asks first, and by default changes nothing", async () => {
    const { w, code, text } = await cloud({ exec: fly }, deployed);
    expect(code).toBe(1);
    expect(text).toContain("This install already has a server at https://totem-old.fly.dev.");
    expect(text).toContain("? Deploy a new server anyway? (y/N)");
    expect(readDeployRecord(w.root)).toEqual(OLD);
    // Nothing was asked of the host, and no host was even chosen.
    expect(w.commands).toEqual([]);
    expect(text).not.toContain("1/6  Host");
  });

  it("deploys a new one when told to", async () => {
    const { w, code } = await cloud({ exec: fly, answers: [["Deploy a new server anyway?", true]] }, deployed);
    expect(code).toBe(0);
    expect(readDeployRecord(w.root)).toMatchObject({ app: "totem-c0ffee", mcp_auth_token: TOKEN });
  });

  it("doesn't ask on a first run, or over a local install", async () => {
    expect((await cloud({ exec: fly })).text).not.toContain("already has a server");
    world?.cleanup();
    expect((await cloud({ exec: fly }, (w) => writeDeployRecord(w.root, { platform: "local" }))).text).not.toContain("already has a server");
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
