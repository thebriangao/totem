// `totem update` — the interactive updater.
//
// Three entry points, all dispatched from runUpdate():
//   totem update              → interactive: pick a version (newest default, older
//                               warns), apply with an animated build, then offer to
//                               turn on auto-update.
//   totem update --auto on    → install a background job that auto-pulls new releases
//   totem update --auto off   → remove it
//   totem update --check      → non-interactive: print installed-vs-latest + auto state
//   totem update --auto-run   → internal: the scheduled job's non-interactive apply
//
// Version index: every release is a git tag (git installs) + an npm version (npm
// installs); GitHub Releases supplies the notes/dates shown in the picker. No
// separate hosting — the tags / registry / releases ARE the index.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  c, capture, captureAsync, spin, withSpinner, select, promptYesNo, ping, httpGet, commandExists,
} from "./ui.js";

// What index.ts hands us so this module stays free of the command registry.
export interface UpdateCtx {
  root: string;
  version: string;        // current version (PKG.version)
  pkgPath: string;        // path to package.json
  pkgName: string;        // @thebriangao/totem
  cliEntry: string;       // absolute path to the running dist/cli/index.js (for the scheduler)
  isGit: boolean;         // git checkout vs npm-global install
  detectDeploy: () => DeployInfo | null;
  redeploy: () => Promise<number>;   // = `totem deploy`
}
interface DeployInfo { platform: string; app?: string; url?: string; region?: string; project?: string; }

interface VersionInfo {
  version: string;              // "1.4.2"
  tag: string;                 // "v1.4.2"
  date?: string | undefined;   // "2026-06-07"
  notes?: string | undefined;  // release name / first body line
}

const AUTO_LABEL = "com.totem.autoupdate";
const AUTO_INTERVAL_SEC = 6 * 60 * 60; // poll every 6h — there's no push channel to a user's machine
const cleanUrl = (u: string): string => u.replace(/\/+$/, "");
const home = (): string => process.env.HOME ?? process.env.USERPROFILE ?? "~";
const autoLogPath = (root: string): string => resolve(root, ".totem-autoupdate.log");

// ── semver ────────────────────────────────────────────────────────────────
// Compare two x.y.z strings (leading "v" ignored). -1 / 0 / 1.
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

// The last meaningful line of captured output, for surfacing a failure reason.
function lastLine(r: { stdout: string; stderr: string }): string {
  const lines = (r.stderr + "\n" + r.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : "";
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

// Best-effort notes/date index from the GitHub Releases API (works for both
// install types; failure just means the picker shows versions without notes).
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

async function fetchReleaseNotes(ctx: UpdateCtx): Promise<Map<string, { date?: string | undefined; notes?: string | undefined }>> {
  const slug = repoSlug(ctx.pkgPath);
  if (!slug) return new Map();
  // GitHub's API requires a User-Agent — httpGet sends one ("totem-setup").
  const r = await httpGet(`https://api.github.com/repos/${slug}/releases?per_page=100`, 8000);
  return r.status === 200 ? parseReleases(r.body) : new Map();
}

// The installable versions for THIS install type, newest first, enriched with notes.
async function fetchVersions(ctx: UpdateCtx): Promise<VersionInfo[]> {
  const notes = await fetchReleaseNotes(ctx);
  let versions: string[] = [];
  const commitDates = new Map<string, string>();
  if (ctx.isGit) {
    await captureAsync("git", ["fetch", "--tags", "--quiet", "origin"], { cwd: ctx.root });
    const out = capture("git", ["tag", "--sort=-v:refname"], { cwd: ctx.root }).stdout;
    versions = out.split("\n").map((s) => s.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.replace(/^v/, ""));
    // Date a version by when its CODE was committed, not the GitHub release's
    // published_at — backfilled tags (e.g. v1.1.0, tagged days after v1.2.0) would
    // otherwise show the wrong, out-of-order date. `*committerdate` dereferences an
    // annotated tag to its commit; the trailing `committerdate` covers a lightweight
    // tag. The regex just grabs the first YYYY-MM-DD after the ref, which is the
    // commit date in both shapes.
    const dates = capture("git", ["for-each-ref", "--format=%(refname:short) %(*committerdate:short) %(committerdate:short)", "refs/tags"], { cwd: ctx.root }).stdout;
    for (const line of dates.split("\n")) {
      const m = line.trim().match(/^v(\d+\.\d+\.\d+)\s+(\d{4}-\d{2}-\d{2})/);
      if (m) commitDates.set(m[1]!, m[2]!);
    }
  } else {
    const out = capture("npm", ["view", ctx.pkgName, "versions", "--json"]).stdout.trim();
    try {
      const parsed = JSON.parse(out) as string[] | string;
      versions = Array.isArray(parsed) ? parsed : [parsed];
    } catch { versions = []; }
  }
  versions = [...new Set(versions)].sort((a, b) => compareSemver(b, a));
  return versions.map((v) => ({ version: v, tag: `v${v}`, date: commitDates.get(v) ?? notes.get(v)?.date, notes: notes.get(v)?.notes }));
}

// ── animated apply ──────────────────────────────────────────────────────────
// Run one captured step under a spinner; ✓ on success, ✗ + reason on failure.
async function staged(label: string, fn: () => Promise<{ code: number; stdout: string; stderr: string }>): Promise<boolean> {
  const s = spin(label);
  const r = await fn();
  if (r.code === 0) { s.stop(`  ${c.green("✓")} ${label}`); return true; }
  s.stop(`  ${c.red("✗")} ${label}`);
  const why = lastLine(r);
  if (why) console.log(c.gray(`      ${why}`));
  return false;
}

// Pull/install `target`, rebuild, and (if deployed) redeploy + health-check.
// Returns 0 on success. `latest` is used only to decide latest-vs-pinned git path.
async function applyVersion(ctx: UpdateCtx, target: VersionInfo, latest: VersionInfo): Promise<number> {
  console.log(c.bold(`\n  Updating to v${target.version}`) + c.gray("  ────────────────────────────"));

  if (ctx.isGit) {
    // Never clobber tracked local edits (a dev checkout). Untracked files (.env,
    // dist/, fly.toml) don't block a checkout, so we ignore them.
    const dirty = capture("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ctx.root }).stdout.trim();
    if (dirty) {
      console.log(c.red("\n  Local changes to tracked files present — commit or stash them first:"));
      console.log(c.gray("    " + dirty.split("\n").slice(0, 5).join("\n    ")));
      return 1;
    }
    if (!(await staged("fetching releases from GitHub", () => captureAsync("git", ["fetch", "--tags", "--quiet", "origin"], { cwd: ctx.root })))) return 1;
    if (target.version === latest.version) {
      // Latest lives on main; make sure we're on the branch, then fast-forward.
      const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.root }).stdout.trim();
      if (branch !== "main" && !(await staged("switching to main", () => captureAsync("git", ["checkout", "main"], { cwd: ctx.root })))) return 1;
      if (!(await staged("pulling latest code", () => captureAsync("git", ["pull", "--ff-only", "origin", "main"], { cwd: ctx.root })))) return 1;
    } else {
      // A pinned older/newer version is a tag → detached checkout.
      if (!(await staged(`checking out ${target.tag}`, () => captureAsync("git", ["checkout", "--quiet", target.tag], { cwd: ctx.root })))) return 1;
    }
    if (!(await staged("installing dependencies", () => captureAsync("npm", ["install"], { cwd: ctx.root })))) return 1;
    const tsc = resolve(ctx.root, "node_modules", ".bin", "tsc");
    if (!(await staged("building", () => captureAsync(process.execPath, [tsc], { cwd: ctx.root })))) return 1;
  } else {
    if (!(await staged(`installing ${ctx.pkgName}@${target.version}`, () => captureAsync("npm", ["install", "-g", `${ctx.pkgName}@${target.version}`])))) return 1;
  }

  // Propagate the new code to wherever the server actually runs. What that takes
  // depends entirely on the user's RECORDED deploy state — branch on it, never
  // assume:
  //   • no record        → nothing remote exists; local code is already updated.
  //   • local (stdio)     → just restart the MCP client to pick up the new build.
  //   • fly/railway/cloudrun → rebuild-from-source on deploy; fully automatic.
  //   • custom / self-host → a container on a box we can't reach; we must NOT fake
  //     a deploy or health-check (it'd pass against the OLD container) — print the
  //     exact rebuild/restart steps instead.
  const d = ctx.detectDeploy();
  const AUTO_DEPLOY = new Set(["fly", "railway", "cloudrun"]);
  if (!d || d.platform === "local") {
    console.log(c.gray(d?.platform === "local"
      ? "\n  Local install — restart your MCP client to load the new build."
      : "\n  No deployment recorded — local code is updated (run `totem cloud` to deploy a server)."));
  } else if (AUTO_DEPLOY.has(d.platform)) {
    // The platform CLI must be present to push from here. If it's gone (a fresh
    // machine, or you ran update from a different box than you deployed from),
    // don't surface a cryptic `spawn fly ENOENT` + "server unchanged" — the local
    // code IS updated; say plainly the redeploy needs the CLI.
    const cliMissing = d.platform === "fly" ? !(commandExists("fly") || commandExists("flyctl"))
      : d.platform === "railway" ? !commandExists("railway")
      : !commandExists("gcloud");
    if (cliMissing) {
      const cli = d.platform === "fly" ? "flyctl" : d.platform === "railway" ? "railway" : "gcloud";
      console.log(c.yellow(`\n  Local code updated — but the ${d.platform} CLI (${cli}) isn't installed here, so the deployment wasn't pushed.`));
      console.log(c.gray(`    Install ${cli} and run \`totem deploy\`, or re-run \`totem cloud\`.`));
      return 0;
    }
    console.log(c.bold(`\n  Redeploying to ${d.platform}${d.app ? ` (${d.app})` : ""}…`));
    if ((await ctx.redeploy()) !== 0) { console.log(c.red("  ✗ deploy failed — your live server is unchanged.")); return 1; }
    if (d.url) {
      const url = `${cleanUrl(d.url)}/health`;
      console.log(c.gray(`  health check → ${url}`));
      if ((await ping(url)) !== 0) {
        console.log(c.red("  ⚠ /health didn't return 200 — the server may be unhealthy."));
        console.log(c.gray(d.platform === "fly" ? `    Roll back: fly releases -a ${d.app} → redeploy the prior release.` : "    Roll back to the previous version on your host."));
        return 1;
      }
    }
    // A redeploy restarts the server. This is a code-only update — secrets persist
    // on the host, so tokens carry over. But /health passing doesn't prove Whoop
    // auth survived the restart (cloud uses the in-memory token store, which can
    // strand a rotated refresh token), so point at the fix if calls start failing.
    console.log(c.gray("  Tokens persist across the redeploy. If Whoop calls start failing afterward, run `totem auth` to refresh + re-push them."));
  } else {
    printSelfHostUpdate(ctx, d);
  }
  return 0;
}

// Self-hosted (Docker on a VPS / Render / a home box / …) — totem can't reach the
// container, and the run command varies per user (compose, ports, restart policy,
// remote host), so we never hardcode it: print the canonical rebuild/restart recipe
// + the env file we wrote at deploy time, and let the user adapt it to their host.
function printSelfHostUpdate(ctx: UpdateCtx, d: DeployInfo): void {
  const hasEnv = existsSync(resolve(ctx.root, ".env.deploy"));
  console.log(c.yellow(`\n  Self-hosted (${d.platform}) — finish the update where your container runs (totem can't reach it):`));
  console.log(`  ${c.violet("1")}  Get this updated code onto that host  ${c.gray("(git pull your checkout there, or copy the build over)")}`);
  console.log(`  ${c.violet("2")}  Rebuild:  ${c.cyan("docker build -t totem .")}`);
  console.log(`  ${c.violet("3")}  Restart:  ${c.cyan(`docker run -d --restart unless-stopped -p 3000:3000 --env-file ${hasEnv ? ".env.deploy" : "<your-env-file>"} totem`)}`);
  console.log(`      ${c.gray("or: docker compose up -d --build  ·  or your host's redeploy (Render/Coolify/etc.)")}`);
  if (d.url) console.log(`  ${c.violet("4")}  Verify:   ${c.gray(`curl ${cleanUrl(d.url)}/health`)}`);
  console.log(c.gray("\n  Your local code + build are already on the new version — only the remote container is left."));
}

function printDone(version: string): void {
  console.log("");
  console.log(`  ${c.green("✓")} ${c.bold(`Now on v${version}`)}`);
  console.log(c.brandDim("   ▁▁▂▂▆▂▁▁▁▁▂▂▆▂▁▁▁▁▂▂▆▂▁▁▁▁▂▂▆▂▁▁"));
  console.log("");
}

// ── auto-update scheduler (launchd on macOS, cron on Linux) ──────────────────
function plistPath(): string { return resolve(home(), "Library", "LaunchAgents", `${AUTO_LABEL}.plist`); }

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A launchd LaunchAgent that runs `totem update --auto-run` every intervalSec.
export function launchdPlist(programArgs: string[], intervalSec: number, workingDir: string, logPath: string): string {
  const args = programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
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
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

// One cron line, tagged so we can find + remove exactly ours.
export function cronLine(programArgs: string[], root: string, logPath: string): string {
  const cmd = programArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  return `0 */6 * * * cd ${root} && ${cmd} >> ${logPath} 2>&1 # ${AUTO_LABEL}`;
}

export function isAutoOn(): boolean {
  if (process.platform === "darwin") return existsSync(plistPath());
  if (process.platform === "linux") {
    const r = capture("crontab", ["-l"]);
    return r.code === 0 && r.stdout.includes(AUTO_LABEL);
  }
  return false;
}

function autoRunArgs(ctx: UpdateCtx): string[] {
  return [process.execPath, ctx.cliEntry, "update", "--auto-run"];
}

async function enableAuto(ctx: UpdateCtx): Promise<boolean> {
  const args = autoRunArgs(ctx);
  const log = autoLogPath(ctx.root);
  if (process.platform === "darwin") {
    const p = plistPath();
    mkdirSync(resolve(home(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(p, launchdPlist(args, AUTO_INTERVAL_SEC, ctx.root, log));
    await captureAsync("launchctl", ["unload", p]); // ignore if not loaded
    const load = await captureAsync("launchctl", ["load", p]);
    if (load.code !== 0) { console.log(c.red(`  ✗ couldn't load the launchd agent: ${lastLine(load)}`)); return false; }
    console.log(c.green("  ✓ auto-update on") + c.gray(`  — checks every 6h via launchd (${p})`));
  } else if (process.platform === "linux") {
    const existing = capture("crontab", ["-l"]).stdout.split("\n").filter((l) => l && !l.includes(AUTO_LABEL));
    existing.push(cronLine(args, ctx.root, log));
    const set = await captureAsync("crontab", ["-"], { input: existing.join("\n") + "\n" });
    if (set.code !== 0) { console.log(c.red(`  ✗ couldn't write crontab: ${lastLine(set)}`)); return false; }
    console.log(c.green("  ✓ auto-update on") + c.gray("  — checks every 6h via cron"));
  } else {
    console.log(c.yellow("  Auto-update isn't wired for this OS. Schedule this command every 6h yourself:"));
    console.log(c.gray(`    ${args.join(" ")}`));
    return false;
  }
  console.log(c.gray(`  Log: ${log}   ·   turn off: totem update --auto off`));
  return true;
}

async function disableAuto(ctx: UpdateCtx): Promise<boolean> {
  if (process.platform === "darwin") {
    const p = plistPath();
    if (existsSync(p)) { await captureAsync("launchctl", ["unload", p]); rmSync(p, { force: true }); }
    console.log(c.green("  ✓ auto-update off"));
  } else if (process.platform === "linux") {
    const kept = capture("crontab", ["-l"]).stdout.split("\n").filter((l) => l && !l.includes(AUTO_LABEL));
    await captureAsync("crontab", ["-"], { input: kept.length ? kept.join("\n") + "\n" : "\n" });
    console.log(c.green("  ✓ auto-update off"));
  } else {
    console.log(c.yellow("  Nothing scheduled by us on this OS — remove any manual schedule yourself."));
  }
  return true;
}

// ── flows ────────────────────────────────────────────────────────────────────
async function runInteractive(ctx: UpdateCtx): Promise<number> {
  console.log(c.bold("\ntotem update") + c.gray(`  — you're on v${ctx.version}\n`));
  const versions = await withSpinner("checking available versions", () => fetchVersions(ctx));
  if (!versions.length) {
    console.log(c.red("  Couldn't list versions (offline, or no releases found)."));
    return 1;
  }
  const latest = versions[0]!;
  const choices = versions.map((v) => {
    const tags: string[] = [];
    if (v.version === latest.version) tags.push(c.green("latest"));
    if (v.version === ctx.version) tags.push(c.cyan("current"));
    if (v.date) tags.push(c.dim(v.date));
    const note = v.notes ? c.dim("· " + (v.notes.length > 44 ? v.notes.slice(0, 43) + "…" : v.notes)) : "";
    return { label: `v${v.version}`, hint: [tags.join(" "), note].filter(Boolean).join("  ") };
  });
  const idx = await select("Update to which version?  (newest is default)", choices, { defaultIndex: 0 });
  const target = versions[idx]!;
  const onLatest = target.version === latest.version;

  if (!onLatest) {
    const ahead = versions.filter((v) => compareSemver(v.version, target.version) > 0).map((v) => "v" + v.version);
    console.log(c.yellow(`\n  ⚠ v${target.version} is NOT the newest — you'd be behind: ${ahead.join(", ")}.`));
    if (!(await promptYesNo("  Install this older version anyway?", false))) { console.log(c.gray("  Cancelled.")); return 0; }
  } else if (target.version === ctx.version) {
    if (!(await promptYesNo(`\n  You're already on v${ctx.version} (the latest). Re-apply anyway?`, false))) { console.log(c.gray("  Nothing to do.")); return 0; }
  }

  const code = await applyVersion(ctx, target, latest);
  if (code !== 0) return code;

  // After a successful apply, manage the auto-update toggle.
  const autoOn = isAutoOn();
  if (onLatest) {
    if (!autoOn) {
      console.log("");
      if (await promptYesNo("  Turn on auto-update? (auto-pulls + sets up every new release)", false)) await enableAuto(ctx);
    } else {
      console.log(c.gray("\n  Auto-update is on — new releases install themselves."));
    }
  } else if (autoOn) {
    console.log(c.yellow("\n  ⚠ Auto-update is ON — it'll move you back to the latest on the next check."));
    if (await promptYesNo("  Turn auto-update OFF to stay pinned to this version?", true)) await disableAuto(ctx);
  }

  printDone(target.version);
  return 0;
}

async function runCheck(ctx: UpdateCtx): Promise<number> {
  console.log(c.bold("\ntotem update --check") + c.gray(`  — installed v${ctx.version}\n`));
  const versions = await withSpinner("checking available versions", () => fetchVersions(ctx));
  if (!versions.length) { console.log(c.red("  Couldn't list versions (offline?).")); return 1; }
  const latest = versions[0]!;
  console.log(`  installed:   v${ctx.version}`);
  console.log(`  latest:      v${latest.version}${latest.date ? c.gray("  " + latest.date) : ""}`);
  console.log(isNewer(latest.version, ctx.version)
    ? c.green(`  ▲ update available — run \`totem update\``)
    : c.green(`  ✓ up to date`));
  console.log(c.gray(`  auto-update: ${isAutoOn() ? "on" : "off"}   ·   ${versions.length} versions available`));
  return 0;
}

// The scheduled job: non-interactive, pull-to-latest-if-newer, log everything.
async function runAuto(ctx: UpdateCtx): Promise<number> {
  const stamp = new Date().toISOString();
  const versions = await fetchVersions(ctx);
  const latest = versions[0];
  if (!latest) { console.log(`[totem auto-update ${stamp}] no version list (offline?) — skipping`); return 0; }
  if (!isNewer(latest.version, ctx.version)) { console.log(`[totem auto-update ${stamp}] up to date on v${ctx.version}`); return 0; }
  console.log(`[totem auto-update ${stamp}] new release v${latest.version} (was v${ctx.version}) — applying`);
  const code = await applyVersion(ctx, latest, latest);
  console.log(`[totem auto-update ${stamp}] ${code === 0 ? `done → v${latest.version}` : `FAILED (exit ${code})`}`);
  return code;
}

export async function runUpdate(args: string[], ctx: UpdateCtx): Promise<number> {
  const autoIdx = args.indexOf("--auto");
  if (autoIdx !== -1) {
    const val = (args[autoIdx + 1] ?? "").toLowerCase();
    if (val === "on") {
      console.log(c.bold("\ntotem update --auto on\n"));
      if (!(await enableAuto(ctx))) return 1;
      // Enabling implies "I want newest" — do one check/pull right now.
      console.log("");
      return runAuto(ctx);
    }
    if (val === "off") { console.log(c.bold("\ntotem update --auto off\n")); return (await disableAuto(ctx)) ? 0 : 1; }
    console.log(c.red("Usage: totem update --auto <on|off>"));
    return 1;
  }
  if (args.includes("--auto-run")) return runAuto(ctx);
  if (args.includes("--check")) return runCheck(ctx);
  return runInteractive(ctx);
}
