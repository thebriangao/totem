#!/usr/bin/env node
// The `totem` executable. Finds the install it belongs to, sets up the
// terminal, and hands over to runCli (app.ts), where the commands live.
//
// This file lives at <root>/dist/cli/index.js (an install) or
// <root>/src/cli/index.ts (run from source): two directories below the root
// either way, so the CLI always acts on its own install, whatever the cwd.
//
// Nothing here writes to stdout: `totem start` hands stdout to the MCP server,
// and `totem version` / `totem token` are read by scripts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./app.js";
import { realSys } from "./sys.js";
import { InputClosedError, Ui } from "./ui.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG_PATH = resolve(ROOT, "package.json");
const PKG = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { name: string; version: string };

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // --no-color anywhere on the line, before anything is drawn.
  const noColor = argv.indexOf("--no-color");
  if (noColor !== -1) {
    argv.splice(noColor, 1);
    process.env.NO_COLOR = "1";
  }
  const ui = new Ui();

  // Ctrl-C stops the command from anywhere and gives the cursor back (a
  // spinner or a menu hides it). Inside a text prompt readline gets the key
  // first; ui.ts handles it there.
  process.on("SIGINT", () => { process.stderr.write("\x1b[?25h\n"); process.exit(130); });
  process.on("exit", () => { if (process.stdout.isTTY) process.stdout.write("\x1b[?25h"); });

  try {
    return await runCli(argv, { root: ROOT, version: PKG.version, pkgName: PKG.name, pkgPath: PKG_PATH, cliEntry: fileURLToPath(import.meta.url) }, { ui, sys: realSys() });
  } catch (error) {
    if (error instanceof InputClosedError) {
      // A question had nobody to answer it. That is never a yes: stop here.
      ui.error(`Stopped at "${error.question}": there was no one to answer.`, {
        detail: "This command asks questions. Run it in a terminal you can type in.",
      });
      return 1;
    }
    ui.error(error instanceof Error ? error.message : String(error), {
      detail: process.env.TOTEM_DEBUG ? (error instanceof Error ? error.stack ?? "" : "").split("\n").slice(1).map((l) => l.trim()) : "For the full trace, run it again with TOTEM_DEBUG=1.",
    });
    return 1;
  }
}

main().then((code) => process.exit(code));
