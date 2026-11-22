// `totem update`: the updater.
//
//   totem update              pick a version (newest first), install it, redeploy
//   totem update --check      installed vs latest, and whether auto-update is on
//   totem update --auto on    install new releases automatically (launchd / cron)
//   totem update --auto off   stop doing that
//   totem update --auto-run   internal: what the scheduled job runs
//
// Version index: every release is a git tag (git installs) and an npm version
// (npm installs); GitHub Releases supplies the dates and notes in the picker.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter as pathDelimiter, dirname, resolve } from "node:path";
import { lastLine, tildify } from "./clients.js";
import { pkgBin } from "./spawn.js";
import { realIo, type ExecResult, type Io } from "./sys.js";
import { duration, listOf, shellLines } from "./ui.js";

// What the dispatcher hands over, so this module doesn't know the commands.
export interface UpdateCtx {
  root: string;
  version: string;        // the installed version
  pkgPath: string;        // path to package.json
  pkgName: string;        // @thebriangao/totem
  cliEntry: string;       // the running dist/cli/index.js (for the scheduler)
  isGit: boolean;         // git checkout vs npm-global install
  detectDeploy: () => DeployInfo | null;
  /** `totem deploy`, captured: each line it prints goes to `onLine`. */
  redeploy: (onLine: (line: string) => void) => Promise<ExecResult>;
}
interface DeployInfo { platform: string; app?: string | undefined; url?: string | undefined; region?: string | undefined; project?: string | undefined }

export interface VersionInfo {
  version: string;              // "1.4.2"
  tag: string;                  // "v1.4.2"
  date?: string | undefined;    // "2026-06-07"
  notes?: string | undefined;   // release name / first body line
}

const AUTO_LABEL = "com.totem.autoupdate";
const AUTO_INTERVAL_SEC = 6 * 60 * 60; // there is no push channel to a user's machine: poll
const cleanUrl = (u: string): string => u.replace(/\/+$/, "");
const autoLogPath = (root: string): string => resolve(root, ".totem-autoupdate.log");
const HOST_NAME: Record<string, string> = { fly: "Fly", railway: "Railway", cloudrun: "Cloud Run" };

// ── semver ────────────────────────────────────────────────────────────────
// Compare two x.y.z[-pre] strings (leading "v" ignored). -1 / 0 / 1. A
// prerelease sorts below its release (1.6.0-rc.1 < 1.6.0).
export function compareSemver(a: string, b: string): number {
  const [coreA = "", preA = ""] = a.replace(/^v/, "").split(/-(.*)/s);
  const [coreB = "", preB = ""] = b.replace(/^v/, "").split(/-(.*)/s);
  const pa = coreA.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = coreB.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return Math.sign(preA.localeCompare(preB, "en", { numeric: true }));
}

// Only plain x.y.z releases are installable — never prereleases.
export const isRelease = (v: string): boolean => /^\d+\.\d+\.\d+$/.test(v);
export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

// owner/repo for the GitHub Releases API, parsed from package.json repository.url.
function repoSlug(pkgPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { repository?: { url?: string } | string };
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
    const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

// Notes and dates from the GitHub Releases API. Best-effort: without them the
// picker shows bare versions.
export function parseReleases(json: string): Map<string, { date?: string | undefined; notes?: string | undefined }> {
  const out = new Map<string, { date?: string | undefined; notes?: string | undefined }>();
  try {
    const arr = JSON.parse(json) as Array<{ tag_name?: string; name?: string; body?: string; published_at?: string; draft?: boolean }>;
    for (const r of arr) {
      if (r.draft || !r.tag_name) continue;
      const v = r.tag_name.replace(/^v/, "");
      const firstLine = (r.body ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      const notes = (r.name && r.name !== r.tag_name && r.name !== v ? r.name : firstLine).replace(/[*_`#>[\]()]/g, "").trim();
      out.set(v, { date: r.published_at ? r.published_at.slice(0, 10) : undefined, notes: notes || undefined });
    }
  } catch { /* leave empty */ }
  return out;
}

// The installable versions for THIS install type, newest first, with notes.
async function fetchVersions(ctx: UpdateCtx, io: Io): Promise<VersionInfo[]> {
  const { sys } = io;
  const slug = repoSlug(ctx.pkgPath);
  const releases = slug ? await sys.httpGet(`https://api.github.com/repos/${slug}/releases?per_page=100`, 8000) : null;
  const notes = releases?.status === 200 ? parseReleases(releases.body) : new Map<string, { date?: string | undefined; notes?: string | undefined }>();
  let versions: string[] = [];
  const commitDates = new Map<string, string>();
  if (ctx.isGit) {
    await sys.exec("git", ["fetch", "--tags", "--quiet", "origin"], { cwd: ctx.root });
    const out = (await sys.exec("git", ["tag", "--sort=-v:refname"], { cwd: ctx.root })).stdout;
    versions = out.split("\n").map((s) => s.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.replace(/^v/, ""));
    // Date a version by when its code was committed, not when the GitHub
    // release was published: a tag added later would show out of order.
    // `*committerdate` dereferences an annotated tag; the plain one covers a
    // lightweight tag. The first date after the ref is the commit's either way.
    const dates = (await sys.exec("git", ["for-each-ref", "--format=%(refname:short) %(*committerdate:short) %(committerdate:short)", "refs/tags"], { cwd: ctx.root })).stdout;
    for (const line of dates.split("\n")) {
      const m = line.trim().match(/^v(\d+\.\d+\.\d+)\s+(\d{4}-\d{2}-\d{2})/);
      if (m) commitDates.set(m[1]!, m[2]!);
    }
  } else {
    const out = (await sys.exec("npm", ["view", ctx.pkgName, "versions", "--json"])).stdout.trim();
    try {
      const parsed = JSON.parse(out) as string[] | string;
      versions = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRelease);
    } catch { versions = []; }
  }
  versions = [...new Set(versions)].sort((a, b) => compareSemver(b, a));
  return versions.map((v) => ({ version: v, tag: `v${v}`, date: commitDates.get(v) ?? notes.get(v)?.date, notes: notes.get(v)?.notes }));
}

// ── applying a version ───────────────────────────────────────────────────────

const tail = (r: ExecResult, lines = 6): string[] =>
  `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "").slice(-lines);

const RETRY: [string, string] = ["Try again", "totem update"];

/**
 * One captured step: spinner while it runs, then ✓ with how long it took, or
 * why it failed. `retry` adds the command to run again (left off when a
 * rollback follows and says it after).
 */
async function staged(io: Io, label: string, done: string, run: (onLine: (l: string) => void) => Promise<ExecResult>, opts: { slow?: boolean; retry?: boolean } = {}): Promise<boolean> {
  const { ui, sys } = io;
  const started = sys.now();
  const r = await ui.task(label, run, { slow: Boolean(opts.slow) });
  if (r.code === 0) {
    ui.ok(done, duration(sys.now() - started));
    return true;
  }
  ui.problem(`${label} failed.`, { detail: tail(r), fix: opts.retry ? [RETRY] : undefined });
  return false;
}

/** What the update left this install and its server on. */
export type Applied =
  /** Everything is on the new version. */
  | "done"
  /** This install is updated; a server exists that totem couldn't update from here. */
  | "local-only"
  /** Nothing changed (or it was put back). */
  | "failed";

/**
 * Install `target`, rebuild, and bring the server along. A git install checks
 * out the release tag (never `main`); an npm install reinstalls that version.
 */
export async function applyVersion(ctx: UpdateCtx, target: VersionInfo, io: Io = realIo()): Promise<Applied> {
  const { ui, sys } = io;
  const d = ctx.detectDeploy();
  const remote = d && d.platform !== "local" ? d : null;
  const total = remote ? 2 : 1;
  const heading = (n: number, title: string): void => (total > 1 ? ui.step(n, total, title) : ui.section(title));

  // Undo for a git install (set once the checkout is about to move). An npm
  // install has nothing to undo: a failed `npm install -g` leaves the old one.
  let rollback: () => Promise<void> = async () => {};

  heading(1, `Install ${target.version}`);
  if (ctx.isGit) {
    // Never clobber local edits to tracked files (a dev checkout). Untracked
    // files (.env, dist/, fly.toml) don't block a checkout.
    const dirty = (await sys.exec("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ctx.root })).stdout.trim();
    if (dirty) {
      ui.problem("This checkout has uncommitted changes to tracked files.", {
        detail: dirty.split("\n").slice(0, 5),
        fix: [["Commit or stash them, then", "totem update"]],
      });
      return "failed";
    }
    if (!(await staged(io, "Fetching releases", "Releases fetched", () => sys.exec("git", ["fetch", "--tags", "--quiet", "origin"], { cwd: ctx.root }), { retry: true }))) return "failed";
    // Where to go back to if the update doesn't finish: the branch when on one,
    // else the commit (a release tag is a detached checkout).
    const previous = (await sys.exec("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: ctx.root })).stdout.trim()
      || (await sys.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.root })).stdout.trim();
    // `npm install` may rewrite package-lock.json (another npm version writes it
    // its own way). The tracked tree was clean when this began, so that change
    // is npm's, not the person's. Left there, git refuses the checkout that
    // goes back to the old version ("local changes would be overwritten": the
    // lock differs between any two releases), and after a good update the next
    // one stops at "uncommitted changes". Put the committed file back.
    const install = async (onLine?: (l: string) => void): Promise<ExecResult> => {
      const r = await sys.exec("npm", ["install"], { cwd: ctx.root, onLine });
      await sys.exec("git", ["checkout", "--quiet", "--", "package-lock.json"], { cwd: ctx.root });
      return r;
    };
    const build = async (onLine?: (l: string) => void): Promise<ExecResult> => {
      const tsc = pkgBin(ctx.root, "typescript", "tsc");
      return tsc ? sys.exec(sys.node, [tsc], { cwd: ctx.root, onLine }) : { code: 1, stdout: "", stderr: "typescript isn't installed in node_modules" };
    };
    // A half-applied update must not stay: the checkout has already moved
    // package.json to the new version, so the next check would read that, find
    // nothing newer and report "up to date" on top of the old build. Going back
    // (the tracked tree was clean, so this only moves HEAD) means the next run
    // tries again.
    rollback = async (): Promise<void> => {
      if (!previous) return;
      const back = await ui.task(`Going back to ${ctx.version}`, () => sys.exec("git", ["checkout", "--quiet", previous], { cwd: ctx.root }));
      if (back.code !== 0) {
        ui.problem(`Couldn't go back to ${ctx.version}.`, { detail: lastLine(back), fix: [["Do it by hand", `git checkout ${previous} && npm install && totem build`]] });
        return;
      }
      // Put the old build back too. Whatever broke the update may break this.
      const rebuilt = await ui.task(`Rebuilding ${ctx.version}`, async () => (await install()).code === 0 && (await build()).code === 0);
      if (rebuilt) ui.ok(`Back on ${ctx.version}; nothing changed`);
      else ui.warn(`Back on ${ctx.version}'s source, but it didn't rebuild.`, "run: npm install && totem build");
      ui.rows([[RETRY[0], ui.kit.c.accent(RETRY[1])]], 4);
    };
    // Every version, the latest included, is its release tag: a detached
    // checkout. Never `main`: that is unreleased code, and on a fork's clone
    // origin/main can be older than the release being installed.
    if (!(await staged(io, `Checking out ${target.tag}`, `Checked out ${target.tag}`, () => sys.exec("git", ["checkout", "--quiet", target.tag], { cwd: ctx.root }), { retry: true }))) return "failed";
    if (!(await staged(io, "Installing dependencies", "Dependencies installed", install, { slow: true }))) { await rollback(); return "failed"; }
    if (!(await staged(io, "Building", "Built", build, { slow: true }))) { await rollback(); return "failed"; }
  } else {
    const spec = `${ctx.pkgName}@${target.version}`;
    if (!(await staged(io, `Installing ${spec}`, `Installed ${spec}`, (onLine) => sys.exec("npm", ["install", "-g", spec], { onLine }), { slow: true, retry: true }))) return "failed";
  }

  // Bring the server along. What that takes depends on where it runs:
  //   - nowhere / this computer: the client loads the new build when it restarts;
  //   - Fly, Railway, Cloud Run: redeploy from here and check /health;
  //   - a self-hosted container: totem can't reach it, so it must not pretend
  //     to (a health check would pass against the OLD container). Print the steps.
  if (!remote) return "done";
  const host = HOST_NAME[remote.platform];
  if (!host) {
    heading(2, "Your server");
    selfHostSteps(io, ctx, remote);
    return "local-only";
  }
  heading(2, `Deploy to ${host}`);
  // The host's CLI has to be on this machine to deploy from it.
  const cli = remote.platform === "fly" ? ["fly", "flyctl"] : remote.platform === "railway" ? ["railway"] : ["gcloud"];
  if (!cli.some((c) => sys.has(c))) {
    ui.warn(`The ${host} CLI (${cli[cli.length - 1]}) isn't installed on this machine, so the server still runs ${ctx.version}.`);
    ui.hint(`Install it, then: totem deploy`);
    return "local-only";
  }
  const started = sys.now();
  const deploy = await ui.task(`Deploying${remote.app ? ` ${remote.app}` : ""}`, (set) => ctx.redeploy(set), { slow: true });
  if (deploy.code !== 0) {
    ui.problem("The deploy failed. The server is unchanged.", { detail: tail(deploy) });
    // Keep this install on the version the server runs, so the next check sees
    // the release as still to do instead of "up to date".
    await rollback();
    return "failed";
  }
  ui.ok(`Deployed${remote.app ? ` ${remote.app}` : ""}`, duration(sys.now() - started));
  if (remote.url) {
    const health = await ui.task("Checking the server", () => sys.httpGet(`${cleanUrl(remote.url!)}/health`, 10_000));
    if (health.status < 200 || health.status >= 300) {
      ui.problem("The new version is deployed, but the server isn't answering /health.", {
        detail: health.status ? `HTTP ${health.status}` : health.error ?? "no answer",
        fix: [["Read its logs", "totem logs"], ...(remote.platform === "fly" && remote.app ? [["See earlier releases", `fly releases -a ${remote.app}`] as [string, string]] : [])],
      });
      return "failed";
    }
    ui.ok("The server is up", "/health answered");
  }
  if (remote.platform === "cloudrun") ui.warn("A new Cloud Run revision starts without a WHOOP login.", "log in again: totem auth");
  else ui.hint("The WHOOP login lives on the server's volume and carries over. If tools start failing: totem auth");
  return "done";
}

// Self-hosted (Docker on a VPS, a home server, …): totem can't reach the
// container, and how it is run varies, so print the recipe to adapt.
function selfHostSteps(io: Io, ctx: UpdateCtx, d: DeployInfo): void {
  const { ui, sys } = io;
  const envFile = existsSync(resolve(ctx.root, ".env.deploy")) ? ".env.deploy" : "<your env file>";
  ui.para("totem can't reach a self-hosted container. This install is updated; on the host that runs the server:");
  ui.line();
  ui.para("1. Get this version there (git pull the checkout, or copy it over).");
  ui.para("2. Rebuild the image:");
  ui.code(["docker build -t totem ."], 5);
  ui.para("3. Stop the old container, then start the new image the way you did before:");
  ui.code(shellLines(["docker", "run", "-d", "--restart", "unless-stopped", "-p", "3000:3000", "-v", "totem-data:/data", "--env-file", envFile, "totem"], ui.style.width - 7, sys.platform), 5);
  if (d.url) {
    ui.para("4. Check it:");
    ui.code([`curl ${cleanUrl(d.url)}/health`], 5);
  }
}

// ── auto-update scheduler (launchd on macOS, cron on Linux) ──────────────────
const plistPath = (home: string): string => resolve(home, "Library", "LaunchAgents", `${AUTO_LABEL}.plist`);

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A launchd LaunchAgent that runs `totem update --auto-run` every intervalSec.
// `path` becomes the job's PATH: launchd starts jobs with /usr/bin:/bin:/usr/sbin:/sbin,
// where npm and the deploy CLIs usually aren't.
export function launchdPlist(programArgs: string[], intervalSec: number, workingDir: string, logPath: string, path?: string): string {
  const args = programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const env = path
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xmlEscape(path)}</string>\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTO_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${intervalSec}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDir)}</string>
${env}  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

// One cron line, tagged so we can find + remove exactly ours. Every word is
// quoted for sh (cron hands the line to `sh -c`), and `%` is escaped: cron ends
// the command at a bare `%` and feeds the rest to it as stdin.
// `path`, when given, is exported first: cron's own PATH is /usr/bin:/bin.
export function cronLine(programArgs: string[], root: string, logPath: string, path?: string): string {
  const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`.replace(/%/g, "\\%");
  const word = (s: string): string => (/^[A-Za-z0-9_/.:=@+-]+$/.test(s) ? s : shq(s));
  const setPath = path ? `export PATH=${shq(path)}; ` : "";
  return `0 */6 * * * ${setPath}cd ${shq(root)} && ${programArgs.map(word).join(" ")} >> ${shq(logPath)} 2>&1 # ${AUTO_LABEL}`;
}

/**
 * The PATH a scheduled run gets: this node's directory (where npm lives) ahead
 * of the PATH `totem update --auto on` was run with, which can see git and the
 * deploy CLI. launchd and cron would otherwise start the job with a bare system
 * PATH, where `npm install` and `fly deploy` fail with ENOENT.
 */
export function schedulerPath(
  execPath: string = process.execPath,
  envPath: string = process.env.PATH ?? "",
  delimiter: string = pathDelimiter,
): string {
  const dirs = [dirname(execPath), ...envPath.split(delimiter)].map((d) => d.trim()).filter(Boolean);
  return [...new Set(dirs)].join(delimiter);
}

/**
 * The person's crontab without totem's line, or why it couldn't be read.
 *
 * `crontab -l` exits non-zero both when there is no crontab yet (start from an
 * empty one) and when the crontab couldn't be read. Its output is empty either
 * way, and writing back "everything but totem's line" after the second erased
 * every job the person had.
 */
async function otherCronJobs(io: Io): Promise<{ ok: true; lines: string[]; hadTotem: boolean } | { ok: false; why: string }> {
  const r = await io.sys.exec("crontab", ["-l"]);
  // "no crontab for <user>" (cron, cronie); "can't open '<user>': No such file or directory" (BusyBox).
  if (r.code !== 0 && !/no crontab|no such file/i.test(`${r.stderr}\n${r.stdout}`)) return { ok: false, why: lastLine(r) };
  const all = r.code === 0 ? r.stdout.split("\n") : [];
  return { ok: true, lines: all.filter((l) => l && !l.includes(AUTO_LABEL)), hadTotem: all.some((l) => l.includes(AUTO_LABEL)) };
}

export async function isAutoOn(io: Io): Promise<boolean> {
  const { sys } = io;
  if (sys.platform === "darwin") return existsSync(plistPath(sys.home));
  if (sys.platform === "linux") {
    const r = await sys.exec("crontab", ["-l"]);
    return r.code === 0 && r.stdout.includes(AUTO_LABEL);
  }
  return false;
}

async function enableAuto(ctx: UpdateCtx, io: Io): Promise<boolean> {
  const { ui, sys } = io;
  const args = [sys.node, ctx.cliEntry, "update", "--auto-run"];
  const log = autoLogPath(ctx.root);
  const path = schedulerPath(sys.node, sys.env.PATH ?? "");
  let via: string;
  if (sys.platform === "darwin") {
    const p = plistPath(sys.home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, launchdPlist(args, AUTO_INTERVAL_SEC, ctx.root, log, path));
    await sys.exec("launchctl", ["unload", p]); // fine if it wasn't loaded
    const load = await sys.exec("launchctl", ["load", p]);
    if (load.code !== 0) {
      ui.problem("launchd wouldn't load the auto-update job.", { detail: lastLine(load), fix: [["Try again", "totem update --auto on"]] });
      return false;
    }
    via = "launchd";
  } else if (sys.platform === "linux") {
    const others = await otherCronJobs(io);
    if (!others.ok) {
      ui.problem("Couldn't read your crontab, so totem left it as it is.", { detail: others.why, fix: [["Try again", "totem update --auto on"]] });
      return false;
    }
    const existing = [...others.lines, cronLine(args, ctx.root, log, path)];
    const set = await sys.exec("crontab", ["-"], { input: existing.join("\n") + "\n" });
    if (set.code !== 0) {
      ui.problem("cron wouldn't take the auto-update job.", { detail: lastLine(set), fix: [["Try again", "totem update --auto on"]] });
      return false;
    }
    via = "cron";
  } else {
    ui.warn("Auto-update isn't available on this system.");
    ui.para("To get the same, schedule this command every 6 hours:", 4);
    ui.code([args.join(" ")]);
    return false;
  }
  ui.ok("Auto-update is on", `checks every 6 hours, through ${via}`);
  ui.rows([["Log", tildify(log, sys.home)], ["Turn it off", "totem update --auto off"]], 4);
  return true;
}

async function disableAuto(io: Io): Promise<boolean> {
  const { ui, sys } = io;
  if (sys.platform === "darwin") {
    const p = plistPath(sys.home);
    if (existsSync(p)) { await sys.exec("launchctl", ["unload", p]); rmSync(p, { force: true }); }
  } else if (sys.platform === "linux") {
    const others = await otherCronJobs(io);
    if (!others.ok) {
      ui.problem("Couldn't read your crontab, so totem left it as it is.", { detail: others.why, fix: [["Try again", "totem update --auto off"]] });
      return false;
    }
    // Only a crontab with totem's line in it needs rewriting.
    if (others.hadTotem) await sys.exec("crontab", ["-"], { input: others.lines.length ? others.lines.join("\n") + "\n" : "\n" });
  } else {
    ui.warn("totem schedules nothing on this system. If you scheduled it yourself, remove that.");
    return true;
  }
  ui.ok("Auto-update is off", "update by hand with: totem update");
  return true;
}

// ── flows ────────────────────────────────────────────────────────────────────

function finish(io: Io, ctx: UpdateCtx, target: VersionInfo, applied: Applied): number {
  const { ui } = io;
  // The step that failed has said why, what version this is back on, and what to run.
  if (applied === "failed") return 1;
  const d = ctx.detectDeploy();
  if (applied === "local-only") {
    ui.next([`This install is on ${target.version}. The server is not yet: finish the steps above.`]);
    return 0;
  }
  if (!d || d.platform === "local") ui.next([`totem is now ${target.version}.`, "Restart your AI client so it starts the new version."]);
  else { ui.line(); ui.ok(`totem is now ${target.version}, here and on the server`); }
  return 0;
}

async function runInteractive(ctx: UpdateCtx, io: Io): Promise<number> {
  const { ui } = io;
  const { g } = ui.kit;
  ui.header("totem update", `Version ${ctx.version} is installed.`);
  const versions = await ui.task("Looking up releases", () => fetchVersions(ctx, io));
  if (!versions.length) {
    ui.problem("Couldn't get the list of releases.", { detail: "Is this machine online?", fix: [["Try again", "totem update"]] });
    return 1;
  }
  const latest = versions[0]!;
  const choices = versions.map((v) => {
    const facts = [v.version === latest.version ? "latest" : "", v.version === ctx.version ? "installed" : "", v.date ?? "", v.notes ?? ""].filter(Boolean);
    return { label: v.version, hint: facts.join(` ${g.dot} `) };
  });
  const target = versions[await ui.select("Which version?", choices, 0)]!;

  if (target.version !== latest.version) {
    const ahead = versions.filter((v) => compareSemver(v.version, target.version) > 0).map((v) => v.version);
    ui.warn(`${target.version} is older than ${listOf(ahead.length > 3 ? [...ahead.slice(0, 3), `${ahead.length - 3} more`] : ahead)}.`);
    if (!(await ui.confirm(`Install ${target.version} anyway?`, false))) { ui.hint("Nothing changed.", 2); return 0; }
  } else if (target.version === ctx.version) {
    ui.ok(`${ctx.version} is the latest, and it is installed`);
    if (!(await ui.confirm("Install it again anyway?", false))) return 0;
  }

  const applied = await applyVersion(ctx, target, io);
  if (applied !== "failed") {
    // The auto-update switch has to agree with the choice just made.
    const autoOn = await isAutoOn(io);
    if (target.version === latest.version && !autoOn && (io.sys.platform === "darwin" || io.sys.platform === "linux")) {
      ui.line();
      if (await ui.confirm("Install new releases automatically from now on?", false)) await enableAuto(ctx, io);
    } else if (target.version !== latest.version && autoOn) {
      ui.line();
      ui.warn(`Auto-update is on: at its next check it would move you back to ${latest.version}.`);
      if (await ui.confirm(`Turn it off to stay on ${target.version}?`, true)) await disableAuto(io);
    }
  }
  return finish(io, ctx, target, applied);
}

async function runCheck(ctx: UpdateCtx, io: Io): Promise<number> {
  const { ui } = io;
  ui.header("totem update --check");
  const versions = await ui.task("Looking up releases", () => fetchVersions(ctx, io));
  if (!versions.length) {
    ui.problem("Couldn't get the list of releases.", { detail: "Is this machine online?", fix: [["Try again", "totem update --check"]] });
    return 1;
  }
  const latest = versions[0]!;
  ui.rows([
    ["Installed", ctx.version],
    ["Latest", `${latest.version}${latest.date ? `, released ${latest.date}` : ""}`],
    ["Auto-update", (await isAutoOn(io)) ? "on" : "off"],
  ]);
  ui.line();
  if (isNewer(latest.version, ctx.version)) {
    ui.warn(`An update is available: ${latest.version}.`);
    ui.rows([["Install it", ui.kit.c.accent("totem update")]], 4);
  } else {
    ui.ok("Up to date");
  }
  return 0;
}

/**
 * Whether an unattended update may move this checkout: `git rev-parse
 * --abbrev-ref HEAD` says `main`, or `HEAD` when detached (at a release tag).
 * An empty answer (git failed) is not a yes.
 */
export function followsReleases(branch: string): boolean {
  return branch === "main" || branch === "HEAD";
}

// The scheduled job: no questions, install the latest if it is newer, and leave
// one dated line per outcome in the log.
async function runAuto(ctx: UpdateCtx, io: Io): Promise<number> {
  const { ui, sys } = io;
  const log = (message: string): void => ui.line(`[totem auto-update ${new Date(sys.now()).toISOString()}] ${message}`);
  if (ctx.isGit) {
    // An update checks out the release tag. Only do that unattended to a
    // checkout that is following releases: on `main`, or already detached at a
    // tag. Anything else is someone's work in progress (a feature branch whose
    // tracked tree happens to be clean), and silently moving it off its branch
    // loses their place.
    const branch = (await sys.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.root })).stdout.trim();
    if (!followsReleases(branch)) {
      log(`on branch '${branch}', not main or a release tag: skipped (update it yourself with \`totem update\`)`);
      return 0;
    }
  }
  const latest = (await fetchVersions(ctx, io))[0];
  if (!latest) { log("couldn't get the list of releases (offline?): skipped"); return 0; }
  if (!isNewer(latest.version, ctx.version)) { log(`up to date on ${ctx.version}`); return 0; }
  log(`${latest.version} is out (installed: ${ctx.version}): installing`);
  const applied = await applyVersion(ctx, latest, io);
  if (applied === "done") log(`now on ${latest.version}`);
  else if (applied === "local-only") log(`this install is on ${latest.version}; the server was NOT updated (see above)`);
  else log(`FAILED: still on ${ctx.version}; the next check tries again`);
  return applied === "failed" ? 1 : 0;
}

export async function runUpdate(args: string[], ctx: UpdateCtx, io: Io = realIo()): Promise<number> {
  const { ui } = io;
  const autoIdx = args.indexOf("--auto");
  if (autoIdx !== -1) {
    const val = (args[autoIdx + 1] ?? "").toLowerCase();
    if (val === "on") {
      ui.header("totem update --auto on", "Install new releases automatically.");
      if (!(await enableAuto(ctx, io))) return 1;
      // Turning it on means "I want the newest": check once now.
      const latest = (await ui.task("Looking up releases", () => fetchVersions(ctx, io)))[0];
      if (!latest) { ui.warn("Couldn't check for a release right now; the first scheduled check will."); return 0; }
      if (!isNewer(latest.version, ctx.version)) { ui.ok("Up to date", `${ctx.version} is the latest`); return 0; }
      ui.info(`${latest.version} is out: installing it now.`);
      return finish(io, ctx, latest, await applyVersion(ctx, latest, io));
    }
    if (val === "off") {
      ui.header("totem update --auto off");
      return (await disableAuto(io)) ? 0 : 1;
    }
    ui.error(`--auto takes "on" or "off"${val ? `, not "${val}"` : ""}.`, { fix: [["Turn it on", "totem update --auto on"], ["Turn it off", "totem update --auto off"]] });
    return 1;
  }
  if (args.includes("--auto-run")) return runAuto(ctx, io);
  if (args.includes("--check")) return runCheck(ctx, io);
  return runInteractive(ctx, io);
}
