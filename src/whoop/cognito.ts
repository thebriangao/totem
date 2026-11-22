// Token refresh via WHOOP's own Cognito proxy at /auth-service/v3/whoop/.
//
// Login happens in a real browser (`totem auth`, see src/cli/browser_login.ts):
// the user signs in at app.whoop.com and totem reads the session cookies. The old
// USER_PASSWORD_AUTH + SMS flow is gone: WHOOP now requires a SEON device
// fingerprint with it, so a correct password gets "Authentication Failed"
// (issue #38). Refreshing needs no fingerprint, so this file only refreshes.
//
// The proxy forwards to AWS Cognito; we send the iOS AWS Swift SDK's headers so
// Cloudflare lets the request through.
import { randomUUID } from "node:crypto";
import { REQUEST_TIMEOUT_MS, WEB_CLIENT_ID } from "./constants.js";

const ENDPOINT = "https://api.prod.whoop.com/auth-service/v3/whoop/";
const USER_AGENT =
  "aws-sdk-swift/1.7.93 ua/2.1 api/cognito_identity_provider#1.7.93 os/ios#27.0.0 lang/swift#5.10 m/D,N,Z,b";

interface AuthenticationResult {
  AccessToken: string;
  RefreshToken?: string;
  IdToken?: string;
  ExpiresIn: number;
  TokenType: string;
}

interface CognitoResponse {
  AuthenticationResult?: AuthenticationResult;
}

export interface CognitoTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number; // epoch ms
}

/** Cognito answered with an error status. `type` is its `__type` (e.g. NotAuthorizedException). */
export class CognitoError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly type: string | null,
  ) {
    super(message);
    this.name = "CognitoError";
  }

  /**
   * True when Cognito refused the credentials themselves (an expired, revoked or
   * foreign refresh token), as opposed to throttling or an outage. Only this
   * means "log in again".
   */
  get isAuthFailure(): boolean {
    if (this.status !== 400 && this.status !== 401) return false;
    return !/TooManyRequests|LimitExceeded|InternalError|ServiceUnavailable|Throttl/i.test(this.type ?? "");
  }
}

function jwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as unknown;
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `exp` claim in epoch seconds, or 0 when the token can't be decoded. */
export function decodeJwtExp(jwt: string): number {
  const exp = jwtPayload(jwt)?.exp;
  return typeof exp === "number" ? exp : 0;
}

/** The `client_id` claim of an access token (which Cognito client issued it). */
export function decodeJwtClientId(jwt: string): string | null {
  const id = jwtPayload(jwt)?.client_id;
  return typeof id === "string" ? id : null;
}

async function callCognito(target: "InitiateAuth", body: object): Promise<CognitoResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
        "amz-sdk-request": "attempt=1; max=2",
        "amz-sdk-invocation-id": randomUUID(),
        "user-agent": USER_AGENT,
        accept: "*/*",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "en-US,en;q=0.9",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // fetch() resolves on the headers. Read the body under the same timer: a
    // response that stalled mid-body used to hang the refresh forever, and with
    // it every tool call waiting on a token.
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Cognito ${target} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let detail = text.slice(0, 200);
    let type: string | null = null;
    try {
      const j = JSON.parse(text) as { message?: string; __type?: string };
      type = j.__type ?? null;
      detail = `${j.__type ?? "error"}: ${j.message ?? text}`;
    } catch {
      // not JSON
    }
    throw new CognitoError(`Cognito ${target} failed (${response.status}): ${detail}`, response.status, type);
  }
  return JSON.parse(text) as CognitoResponse;
}

/**
 * Use the refresh token to mint a fresh access token.
 *
 * WHOOP rotates the refresh token on EVERY refresh (6/6 in the 2026-11 capture,
 * every probe refresh since). The returned refreshToken must be persisted before
 * the new access token is used; the old one is dead.
 *
 * `clientId` must be the client that issued the refresh token: browser-login
 * tokens come from WHOOP's web client (WEB_CLIENT_ID). Legacy tokens minted by the
 * old iOS password flow used "" (WHOOP's proxy filled in the iOS client).
 */
export async function refreshCognitoSession(
  refreshToken: string,
  clientId: string = WEB_CLIENT_ID,
): Promise<CognitoTokens> {
  const resp = await callCognito("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    AuthParameters: { REFRESH_TOKEN: refreshToken },
    ClientId: clientId,
  });
  const ar = resp.AuthenticationResult;
  if (!ar?.AccessToken) {
    throw new Error("Cognito refresh returned no tokens");
  }
  return {
    accessToken: ar.AccessToken,
    refreshToken: ar.RefreshToken ?? refreshToken,
    idToken: ar.IdToken ?? "",
    expiresAt: decodeJwtExp(ar.AccessToken) * 1000,
  };
}
