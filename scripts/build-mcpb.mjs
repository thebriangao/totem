#!/usr/bin/env node
// Builds totem.mcpb: totem as a Claude Desktop extension. Double-click it and
// Claude Desktop installs it, running the server on its own built-in Node, so
// nothing else needs installing. The WHOOP login comes from `totem auth
// --local` (or `npx @thebriangao/totem auth --local`), which the server finds
// in its usual place.
//
//   node scripts/build-mcpb.mjs        -> build/totem.mcpb
//
// It needs a built dist/ (npx tsc) and the official packer, which it runs
// through npx (@anthropic-ai/mcpb).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "build");
const stage = join(out, "mcpb");
if (!existsSync(join(root, "dist", "server.js"))) {
  console.error("No dist/server.js: build first (npx tsc).");
  process.exit(1);
}
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// The server and only what it needs at run time: no source maps, no CLI-only
// assets, no Cloudflare entry.
cpSync(join(root, "dist"), join(stage, "dist"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map") && !src.includes(`${join("dist", "cloudflare")}`),
});
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
const runtime = { name: pkg.name, version: pkg.version, type: pkg.type, dependencies: pkg.dependencies };
writeFileSync(join(stage, "package.json"), JSON.stringify(runtime, null, 2) + "\n");
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: stage, stdio: "inherit" });

const manifest = {
  manifest_version: "0.3",
  name: "totem",
  display_name: "WHOOP (totem)",
  version: pkg.version,
  description: "Your WHOOP data in Claude: recovery, sleep, strain, workouts, journal and more.",
  long_description:
    "totem is an open-source server that connects Claude to your WHOOP account. It runs on this computer; your data goes only between WHOOP and Claude.\n\n" +
    "Before the first use, log in to WHOOP once in a terminal: `npx @thebriangao/totem auth --local`. " +
    "A browser window opens on WHOOP's own site; totem keeps the login on this computer and refreshes it.\n\n" +
    "totem is not affiliated with WHOOP.",
  author: { name: "totem contributors", url: "https://github.com/thebriangao/totem" },
  repository: { type: "git", url: "https://github.com/thebriangao/totem" },
  homepage: "https://github.com/thebriangao/totem",
  documentation: "https://github.com/thebriangao/totem#readme",
  support: "https://github.com/thebriangao/totem/issues",
  license: "MIT",
  keywords: ["whoop", "health", "fitness", "sleep", "recovery"],
  server: {
    type: "node",
    entry_point: "dist/server.js",
    mcp_config: { command: "node", args: ["${__dirname}/dist/server.js"], env: {} },
  },
  tools_generated: true,
  compatibility: { platforms: ["darwin", "win32"], runtimes: { node: ">=24.0.0" } },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const mcpb = (args) => execFileSync("npx", ["--yes", "@anthropic-ai/mcpb@2", ...args], { cwd: root, stdio: "inherit" });
mcpb(["validate", join(stage, "manifest.json")]);
mcpb(["pack", stage, join(out, "totem.mcpb")]);
console.log(`\nBuilt ${join("build", "totem.mcpb")}`);
