// `.totem-deploy.json`: where `totem cloud` / `totem local` set the server up,
// so `totem auth`, `deploy`, `logs` and `status` know where to act. It also
// keeps the deployment's MCP_AUTH_TOKEN, which `totem auth` needs to push a
// login, so it is written 0600 like the token file.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "../whoop/token_store.js";

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

export function deployRecordPath(root: string): string {
  return resolve(root, ".totem-deploy.json");
}

export function readDeployRecord(root: string): DeployRecord | null {
  const path = deployRecordPath(root);
  if (!existsSync(path)) return null;
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as DeployRecord;
    return r && typeof r.platform === "string" ? r : null;
  } catch {
    return null;
  }
}

export function writeDeployRecord(root: string, record: DeployRecord): void {
  const body = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
  writeFileAtomic(deployRecordPath(root), JSON.stringify(body, null, 2) + "\n");
}

/** Merge fields into the existing record (no-op when there is none). */
export function updateDeployRecord(root: string, patch: Partial<DeployRecord>): void {
  const current = readDeployRecord(root);
  if (current) writeDeployRecord(root, { ...current, ...patch });
}
