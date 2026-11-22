// Holds the current access token + refresh token, auto-refreshes via Cognito
// when the access token is within `refreshSkewSeconds` of expiry. Writes
// rotated tokens to an injected TokenStore so server restarts pick up fresh
// state without re-bootstrapping.
import { decodeJwtClientId, decodeJwtExp, refreshCognitoSession } from "./cognito.js";
import { WEB_CLIENT_ID } from "./constants.js";
import { EnvFileTokenStore, type TokenStore } from "./token_store.js";

export interface TokenManagerConfig {
  email: string;
  accessToken: string;
  refreshToken: string;
  /** How many seconds before exp to preemptively refresh. Default 60. */
  refreshSkewSeconds?: number;
  /**
   * Where to persist rotated tokens. Pass `EnvFileTokenStore(path)` (default
   * when `envPath` is given) or `MemoryTokenStore` for ephemeral hosts.
   */
  store?: TokenStore;
  /** Convenience: provide envPath instead of `store` to get the default file store. */
  envPath?: string;
}

export class TokenManager {
  private email: string;
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number; // epoch ms
  private skewMs: number;
  private store: TokenStore;
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt = 0;

  constructor(config: TokenManagerConfig) {
    this.email = config.email;
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
    this.skewMs = (config.refreshSkewSeconds ?? 60) * 1000;
    this.expiresAt = decodeJwtExp(config.accessToken) * 1000;
    if (config.store) {
      this.store = config.store;
    } else if (config.envPath) {
      this.store = new EnvFileTokenStore(config.envPath);
    } else {
      throw new Error("TokenManager: pass either `store` or `envPath`");
    }
  }

  async getToken(): Promise<string> {
    if (this.isFresh()) return this.accessToken;
    // Single-flight: if a refresh is already running, wait on it
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    return this.accessToken;
  }

  /**
   * Force the next getToken() to refresh. Ignored when `rejectedToken` is no
   * longer current, so parallel 401s on the same token cause a single refresh,
   * and within a minute of the last refresh, so a token Whoop keeps rejecting
   * doesn't cost a Cognito call per request.
   */
  invalidate(rejectedToken: string): void {
    if (rejectedToken !== this.accessToken) return;
    if (Date.now() - this.lastRefreshAt < 60_000) return;
    this.expiresAt = 0;
  }

  private isFresh(): boolean {
    return Date.now() < this.expiresAt - this.skewMs;
  }

  private async doRefresh(): Promise<void> {
    // Browser-login tokens refresh against WHOOP's web client; legacy iOS
    // password-flow tokens refresh with "" (WHOOP's proxy fills the iOS client).
    const clientId = decodeJwtClientId(this.accessToken) === WEB_CLIENT_ID ? WEB_CLIENT_ID : "";
    const next = await refreshCognitoSession(this.refreshToken, clientId);
    this.accessToken = next.accessToken;
    // Cognito may rotate the refresh token; if it does, persist the new one.
    if (next.refreshToken && next.refreshToken !== this.refreshToken) {
      this.refreshToken = next.refreshToken;
      // Observable so a memory-store (non-persisting) deploy can tell when a
      // restart would strand the old token. See SECURITY.md → token hygiene.
      console.error("[totem] Cognito rotated the refresh token — persisting the new one.");
    }
    this.expiresAt = next.expiresAt;
    this.lastRefreshAt = Date.now();
    try {
      this.store.save({ accessToken: this.accessToken, refreshToken: this.refreshToken });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[totem] refreshed the Whoop access token but could not persist it: ${detail}. This process will keep using the fresh in-memory token.`);
    }
  }
}
