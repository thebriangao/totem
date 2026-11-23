// The command table is a plain object, and a plain object answers to names
// nobody put in it (constructor, toString, …). Anything that isn't a command
// must get the "isn't a totem command" screen and exit 2, not a crash.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { runCli, type AppCtx } from "../../src/cli/app.js";
import { fakeWorld, type FakeWorld } from "./helpers.js";

let world: FakeWorld | undefined;
afterEach(() => { world?.cleanup(); world = undefined; });

async function totem(...argv: string[]): Promise<{ code: number; text: string }> {
  const w = fakeWorld();
  world = w;
  const app: AppCtx = { root: w.root, version: "1.5.1", pkgName: "@thebriangao/totem", pkgPath: join(w.root, "package.json"), cliEntry: join(w.root, "dist", "cli", "index.js") };
  const code = await runCli(argv, app, w.io);
  return { code, text: w.transcript() };
}

describe("names every object has are not commands", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])("totem %s", async (name) => {
    const { code, text } = await totem(name);
    expect(code).toBe(2);
    expect(text).toContain(`"${name}" isn't a totem command.`);
    world?.cleanup();
    const help = await totem("help", name);
    expect(help.code).toBe(2);
    expect(help.text).toContain(`"${name}" isn't a totem command.`);
  });

  it("real commands and their aliases still resolve", async () => {
    expect((await totem("status", "--help")).text).toContain("totem status");
    world?.cleanup();
    expect((await totem("info", "--help")).text).toContain("totem status");
    world?.cleanup();
    expect((await totem("help", "config")).text).toContain("totem connect");
  });
});
