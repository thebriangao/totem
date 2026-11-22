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
