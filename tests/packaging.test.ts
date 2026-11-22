// What `npm publish` would ship. `bin` points into dist/, which is build output
// and git-ignored: packed from a clean checkout the tarball had no dist/ at all
// (0 of 160 files), so the published `totem` command pointed at nothing, and
// from a dirty one it shipped whatever stale build was lying around.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  bin: Record<string, string>; files: string[]; scripts?: Record<string, string>; engines?: { node?: string };
};
// tsconfig.json is plain JSON here (no comments).
const tsconfig = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8")) as {
  compilerOptions: { outDir: string; rootDir: string };
};

describe("package.json", () => {
  it("builds before packing, so the tarball always has the dist/ that bin needs", () => {
    expect(pkg.scripts?.prepack).toMatch(/\btsc\b/);
  });

  it("points every bin at a file the build emits and the tarball includes", () => {
    const outDir = `${tsconfig.compilerOptions.outDir.replace(/^\.\//, "").replace(/\/$/, "")}/`;
    for (const [name, target] of Object.entries(pkg.bin)) {
      const path = target.replace(/^\.\//, "");
      expect(path.startsWith(outDir), `${name} → ${target}`).toBe(true);
      expect(pkg.files.some((entry) => path.startsWith(entry)), `${name} is under a "files" entry`).toBe(true);
      // …and has a source to be compiled from, with the shebang npm needs for a bin.
      const source = resolve(root, tsconfig.compilerOptions.rootDir, path.slice(outDir.length).replace(/\.js$/, ".ts"));
      expect(readFileSync(source, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });

  it("does not build on plain install (the Docker build runs `npm ci` before src/ is copied)", () => {
    for (const hook of ["prepare", "preinstall", "install", "postinstall"]) {
      expect(pkg.scripts?.[hook], hook).toBeUndefined();
    }
  });
});
