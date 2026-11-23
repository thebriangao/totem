// Where `totem cloud` / `totem local` set the server up, so `totem auth`,
// `deploy`, `logs` and `status` know where to act. It also keeps the
// deployment's MCP_AUTH_TOKEN, which `totem auth` needs to push a login, so it
// is written 0600 like the token file.
//
// It lives in totem's config folder (configDir: ~/.config/totem/deploy.json),
// with the files that describe the deployment (fly.toml, deploy.env). Never in
// the install: `npm install -g` replaces that folder on every update, and a
// root-owned global install can't be written to at all. Installs before 2.0
// kept it as .totem-deploy.json in the install; that one is moved on first read.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { configDir, writeFileAtomic } from "../whoop/token_store.js";
import type { Sys } from "./sys.js";

export interface DeployRecord {
  platform: string;          // fly | railway | cloudflare | custom | local (cloudrun: deployed by totem 1.x)
  app?: string | undefined;  // app/project/service name (none for local)
  url?: string | undefined;
  /** The Railway service totem deployed into (records from 1.x have none). */
  service?: string | undefined;
  region?: string | undefined;   // Fly region; Cloud Run (1.x) needs it to target the service
  project?: string | undefined;  // Cloud Run GCP project
  /** The deployment's MCP_AUTH_TOKEN (gates POST /admin/tokens). */
  mcp_auth_token?: string | undefined;
}

/** Whose config folder: the person running totem. */
export type Where = Pick<Sys, "home" | "env" | "platform">;

/** A file in totem's config folder. */
export function configFile(where: Where, name: string): string {
  return (where.platform === "win32" ? win32.join : join)(configDir(where.env, where.platform, where.home), name);
}

export const deployRecordPath = (where: Where): string => configFile(where, "deploy.json");
/** Where installs before 2.0 kept it. */
const legacyPath = (root: string): string => resolve(root, ".totem-deploy.json");

function parse(path: string): DeployRecord | null {
  if (!existsSync(path)) return null;
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as DeployRecord;
    return r && typeof r.platform === "string" ? r : null;
  } catch {
    return null;
  }
}

export function readDeployRecord(root: string, where: Where): DeployRecord | null {
  const record = parse(deployRecordPath(where));
  if (record) return record;
  const legacy = parse(legacyPath(root));
  // Move it to the config folder; if that can't be written, it still works from here.
  if (legacy) try { writeDeployRecord(root, legacy, where); } catch { /* read-only: keep using it */ }
  return legacy;
}

export function writeDeployRecord(root: string, record: DeployRecord, where: Where): void {
  const body = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
  writeFileAtomic(deployRecordPath(where), JSON.stringify(body, null, 2) + "\n");
  // One record: a stale copy in the install would say something else.
  try { rmSync(legacyPath(root), { force: true }); } catch { /* not ours to remove */ }
}

/** Merge fields into the existing record (no-op when there is none). */
export function updateDeployRecord(root: string, patch: Partial<DeployRecord>, where: Where): void {
  const current = readDeployRecord(root, where);
  if (current) writeDeployRecord(root, { ...current, ...patch }, where);
}

/** The host a server address belongs to, for a server totem didn't deploy itself (a Deploy button). */
export function platformForUrl(url: string): string {
  let host = "";
  try { host = new URL(url).hostname; } catch { return "custom"; }
  if (host.endsWith(".workers.dev")) return "cloudflare";
  if (host.endsWith(".up.railway.app")) return "railway";
  if (host.endsWith(".fly.dev")) return "fly";
  return "custom";
}
