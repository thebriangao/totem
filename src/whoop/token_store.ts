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
//     systems (Cloudflare Workers, read-only container disks). Accept that you'll
//     re-bootstrap every 30 days. Opt in via WHOOP_TOKEN_STORE=memory.

import { existsSync } from "node:fs";
import { upsertEnvFile } from "../lib/env_file.js";

export interface TokenStore {
  save(updates: { accessToken: string; refreshToken: string }): void;
}

export class EnvFileTokenStore implements TokenStore {
  constructor(private path: string) {}

  save(updates: { accessToken: string; refreshToken: string }): void {
    // Deliberately does nothing when the file is absent (memory-store hosts).
    if (!existsSync(this.path)) return;
    // Shared writer: quotes anything dotenv would otherwise mangle on read-back,
    // preserves comments/unrelated keys, and writes 0600 (see issue #27).
    upsertEnvFile(this.path, {
      WHOOP_IOS_BEARER_TOKEN: updates.accessToken,
      WHOOP_COGNITO_REFRESH_TOKEN: updates.refreshToken,
    });
  }
}

export class MemoryTokenStore implements TokenStore {
  save(_updates: { accessToken: string; refreshToken: string }): void {
    // intentionally no-op; tokens persist only for the lifetime of this process
  }
}
