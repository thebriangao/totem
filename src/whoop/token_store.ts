// Persistence layer for Cognito tokens. The TokenManager writes the rotated
// access + refresh tokens after every refresh so server restarts pick up the
// latest state without re-bootstrapping (until the refresh token itself
// expires, ~30 days).
//
// Two implementations:
//   - EnvFileTokenStore: writes to a .env file. Used in local dev and on any
//     host that lets you persist a small file (Fly volumes, Railway disks,
//     a VPS). The default.
//   - MemoryTokenStore: no persistence. Used on hosts with read-only file
//     systems (Cloudflare Workers, Vercel Functions). Accept that you'll
//     re-bootstrap every 30 days. Opt in via WHOOP_TOKEN_STORE=memory.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface TokenStore {
  save(updates: { accessToken: string; refreshToken: string }): void;
}

export class EnvFileTokenStore implements TokenStore {
  constructor(private path: string) {}

  save(updates: { accessToken: string; refreshToken: string }): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, "utf8").split("\n");
    const upsert = (key: string, value: string): void => {
      const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
      const entry = `${key}=${value}`;
      if (idx >= 0) lines[idx] = entry;
      else lines.push(entry);
    };
    upsert("WHOOP_IOS_BEARER_TOKEN", updates.accessToken);
    upsert("WHOOP_COGNITO_REFRESH_TOKEN", updates.refreshToken);
    writeFileSync(this.path, lines.join("\n"));
  }
}

export class MemoryTokenStore implements TokenStore {
  save(_updates: { accessToken: string; refreshToken: string }): void {
    // intentionally no-op; tokens persist only for the lifetime of this process
  }
}
