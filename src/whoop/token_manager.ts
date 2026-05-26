// Holds the current access token + refresh token, auto-refreshes via Cognito
// when the access token is within `refreshSkewSeconds` of expiry. Writes
// rotated tokens to an injected TokenStore so server restarts pick up fresh
// state without re-bootstrapping.
import { decodeJwtExp, refreshCognitoSession } from "./cognito.js";
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

  private isFresh(): boolean {
    return Date.now() < this.expiresAt - this.skewMs;
  }

  private async doRefresh(): Promise<void> {
    const next = await refreshCognitoSession(this.email, this.refreshToken);
    this.accessToken = next.accessToken;
    // Cognito may rotate the refresh token; if it does, persist the new one.
    if (next.refreshToken && next.refreshToken !== this.refreshToken) {
      this.refreshToken = next.refreshToken;
    }
    this.expiresAt = next.expiresAt;
    this.store.save({ accessToken: this.accessToken, refreshToken: this.refreshToken });
  }
}
