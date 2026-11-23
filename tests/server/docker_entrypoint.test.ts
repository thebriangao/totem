// The image's entrypoint runs as root for a moment (volumes mount root-owned),
// hands the token directory to the unprivileged `node` user and drops to it.
// These tests run the script from the Dockerfile with `id`, `chown`, `chmod`
// and `su-exec` replaced by recorders.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCKERFILE = fileURLToPath(new URL("../../Dockerfile", import.meta.url));

/** The entrypoint script, as the Dockerfile's `printf '%s\n' '…' '…' > totem-entrypoint` writes it. */
function entrypointScript(): string {
  const text = readFileSync(DOCKERFILE, "utf8");
  const start = text.indexOf("printf '%s\\n'");
  const end = text.indexOf("> /usr/local/bin/totem-entrypoint");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const lines = [...text.slice(start, end).matchAll(/^\s+'(.*)' \\$/gm)].map((m) => m[1]!);
  expect(lines[0]).toBe("#!/bin/sh");
  return lines.join("\n") + "\n";
}

describe.skipIf(process.platform === "win32")("Docker entrypoint", () => {
  let dir: string;
  let script: string;
  let log: string;
  const stub = (name: string, body: string): void => {
    const p = join(dir, "bin", name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  };
  const run = (uid: number, tokenFile: string, command: string[]): string[] => {
    stub("id", `echo ${uid}`);
    execFileSync("/bin/sh", [script, ...command], { env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, TOTEM_TOKEN_FILE: tokenFile, CALLS: log } });
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "totem-entrypoint-"));
    mkdirSync(join(dir, "bin"));
    script = join(dir, "entrypoint.sh");
    writeFileSync(script, entrypointScript());
    log = join(dir, "calls.log");
    for (const tool of ["chown", "chmod", "su-exec"]) stub(tool, `echo "${tool} $*" >> "$CALLS"`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("as root: hands the token directory to node, then drops to node for the server", () => {
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "tokens.json"), "{}");
    const calls = run(0, join(data, "tokens.json"), ["node", "dist/server.js"]);
    expect(calls).toContain(`chown -h node:node ${data}`);
    expect(calls).toContain(`chown -h node:node ${join(data, "tokens.json")}`);
    expect(calls).toContain(`chmod 700 ${data}`);
    expect(calls.at(-1)).toBe("su-exec node node dist/server.js");
  });

  // The server (uid node) owns the token directory. If it were ever taken over,
  // it could replace tokens.json with a link to a root-owned file; a root-run
  // chown that follows links would then hand that file to node at the next start.
  it("as root: never follows a symlink planted in the token directory", () => {
    const data = join(dir, "data");
    mkdirSync(data);
    const victim = join(dir, "root-owned-file");
    writeFileSync(victim, "x");
    symlinkSync(victim, join(data, "tokens.json"));
    symlinkSync(join(dir, "missing-target"), join(data, "tokens.json.lock")); // dangling
    const calls = run(0, join(data, "tokens.json"), ["node", "dist/server.js"]);
    const chowns = calls.filter((c) => c.startsWith("chown "));
    expect(chowns.length).toBeGreaterThanOrEqual(3);
    for (const c of chowns) expect(c).toMatch(/^chown -h node:node /);
    expect(calls.at(-1)).toBe("su-exec node node dist/server.js");
  });

  it("as root: leaves / and a symlinked token directory alone", () => {
    expect(run(0, "/tokens.json", ["true"]).filter((c) => /^(chown|chmod) /.test(c))).toEqual([]);
    rmSync(log, { force: true });
    const real = join(dir, "elsewhere");
    mkdirSync(real);
    symlinkSync(real, join(dir, "linked"));
    const calls = run(0, join(dir, "linked", "tokens.json"), ["true"]);
    expect(calls.filter((c) => c.startsWith("chmod "))).toEqual([]); // chmod has no -h: it would follow the link
    for (const c of calls.filter((x) => x.startsWith("chown "))) expect(c).toMatch(/^chown -h /);
  });

  it("as another user: changes nothing and runs the command directly", () => {
    const data = join(dir, "data");
    mkdirSync(data);
    expect(run(1000, join(data, "tokens.json"), ["true"])).toEqual([]);
  });
});

// The HEALTHCHECK runs in the container's shell, so it has to probe the port the
// server listens on (PORT, else MCP_HTTP_PORT, else 3000), not a fixed 3000.
describe.skipIf(process.platform === "win32")("Docker HEALTHCHECK", () => {
  const command = (): string => {
    const m = readFileSync(DOCKERFILE, "utf8").match(/^HEALTHCHECK[^\n]*\\\n\s+CMD (.+)$/m);
    expect(m).not.toBeNull();
    return m![1]!;
  };
  const probed = (env: Record<string, string>): string => {
    const bin = mkdtempSync(join(tmpdir(), "totem-health-"));
    try {
      writeFileSync(join(bin, "wget"), '#!/bin/sh\nfor a in "$@"; do last="$a"; done\necho "$last"\n');
      chmodSync(join(bin, "wget"), 0o755);
      return execFileSync("/bin/sh", ["-c", command()], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: "utf8" }).trim();
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  };

  it("probes 3000 by default", () => {
    expect(probed({})).toBe("http://127.0.0.1:3000/health");
    expect(probed({ PORT: "" })).toBe("http://127.0.0.1:3000/health");
  });

  it("follows PORT, then MCP_HTTP_PORT, like the server does", () => {
    expect(probed({ PORT: "8080" })).toBe("http://127.0.0.1:8080/health");
    expect(probed({ MCP_HTTP_PORT: "9090" })).toBe("http://127.0.0.1:9090/health");
    expect(probed({ PORT: "8080", MCP_HTTP_PORT: "9090" })).toBe("http://127.0.0.1:8080/health");
  });
});
