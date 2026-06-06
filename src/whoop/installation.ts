// Persist a stable per-install identifier so `x-whoop-installation-identifier`
// stays constant across restarts — a real app install keeps one ID for its
// whole lifetime, and a value that changed every boot would itself be an
// anomaly. Mirrors how the token store writes back to the .env file.
//
// Best-effort: on read-only filesystems (Cloudflare Workers, locked containers)
// the write is skipped and device.ts falls back to a per-process random ID,
// which is stable for that process's lifetime.

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";

/**
 * Ensure `WHOOP_INSTALLATION_ID` exists in the environment, generating and
 * persisting one to the env file on first run. Sets `process.env` so device.ts
 * picks it up on its first header build. Idempotent; call once at boot before
 * any request goes out.
 */
// Derive a STABLE id from the account email — used only when we can't persist a
// random one (read-only host). An id that changes on every cold start is itself
// the anomaly we're avoiding, so a deterministic-per-account value beats a fresh
// random one per process. Shaped like the app's uppercase UUID (8-4-4-4-12).
function deterministicId(email: string | undefined): string | null {
  if (!email) return null;
  const h = createHash("sha256").update(`totem/install/${email.toLowerCase()}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

export function resolveInstallationId(envPath: string): string {
  const existing = process.env.WHOOP_INSTALLATION_ID;
  if (existing) return existing;

  // The app sends an uppercase UUID; match its shape.
  let id = randomUUID().toUpperCase();
  let persisted = false;
  try {
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, "utf8").split("\n");
      if (!lines.some((l) => l.startsWith("WHOOP_INSTALLATION_ID="))) {
        lines.push(`WHOOP_INSTALLATION_ID=${id}`);
        writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
        try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
      }
      persisted = true;
    }
  } catch {
    persisted = false;
  }
  // Couldn't persist (read-only host / no .env): use a deterministic,
  // restart-stable id from the account email rather than a fresh random one
  // every boot. Serverless deployers should still set WHOOP_INSTALLATION_ID.
  if (!persisted) {
    const stable = deterministicId(process.env.WHOOP_EMAIL);
    if (stable) id = stable;
  }
  process.env.WHOOP_INSTALLATION_ID = id;
  return id;
}
