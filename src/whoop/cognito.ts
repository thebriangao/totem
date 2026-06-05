// Auth via Whoop's own Cognito proxy at /auth-service/v3/whoop/.
// Whoop's backend fills in the ClientId + SECRET_HASH and forwards to AWS Cognito,
// so we don't need the iOS app's client secret. We just impersonate the iOS
// AWS Swift SDK headers to pass through Cloudflare.
//
// Flow:
//   1. InitiateAuth with USER_PASSWORD_AUTH (ClientId="")
//   2. If SMS_MFA challenge → RespondToAuthChallenge with the SMS code
//   3. Get AccessToken + RefreshToken from AuthenticationResult
//   4. To refresh: InitiateAuth with REFRESH_TOKEN_AUTH (no MFA needed)
import { randomUUID } from "node:crypto";

const ENDPOINT = "https://api.prod.whoop.com/auth-service/v3/whoop/";
const USER_AGENT =
  "aws-sdk-swift/1.5.86 ua/2.1 api/cognito_identity_provider#1.5.86 os/ios#26.3.1 lang/swift#5.10 m/D,N,Z,b";

interface AuthenticationResult {
  AccessToken: string;
  RefreshToken?: string; // omitted on refresh-token flow
  IdToken: string;
  ExpiresIn: number;
  TokenType: string;
}

interface CognitoResponse {
  AuthenticationResult?: AuthenticationResult;
  ChallengeName?: string;
  Session?: string;
  ChallengeParameters?: Record<string, string>;
}

export interface CognitoTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number; // epoch ms
}

export function decodeJwtExp(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length < 2) return 0;
  const padded = parts[1]!.padEnd(parts[1]!.length + ((4 - (parts[1]!.length % 4)) % 4), "=");
  const json = Buffer.from(padded, "base64").toString("utf8");
  try {
    const payload = JSON.parse(json) as { exp?: number };
    return payload.exp ?? 0;
  } catch {
    return 0;
  }
}

async function callCognito(
  target: "InitiateAuth" | "RespondToAuthChallenge",
  body: object,
): Promise<CognitoResponse> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
      "amz-sdk-request": "attempt=1; max=1",
      "amz-sdk-invocation-id": randomUUID(),
      "user-agent": USER_AGENT,
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br",
      "accept-language": "en-US,en;q=0.9",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { message?: string; __type?: string };
      detail = `${j.__type ?? "error"}: ${j.message ?? text}`;
    } catch {
      // not JSON
    }
    throw new Error(`Cognito ${target} failed (${response.status}): ${detail}`);
  }
  return JSON.parse(text) as CognitoResponse;
}

function tokensFromAuth(ar: AuthenticationResult, fallbackRefresh?: string): CognitoTokens {
  return {
    accessToken: ar.AccessToken,
    refreshToken: ar.RefreshToken ?? fallbackRefresh ?? "",
    idToken: ar.IdToken,
    expiresAt: decodeJwtExp(ar.AccessToken) * 1000,
  };
}

export interface BootstrapInput {
  email: string;
  password: string;
  /** Called when SMS_MFA challenge fires. Return the 6-digit code. */
  mfaPrompt: () => Promise<string>;
}

export async function bootstrapCognito(input: BootstrapInput): Promise<CognitoTokens> {
  const init = await callCognito("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: input.email, PASSWORD: input.password },
    ClientId: "",
  });

  if (init.AuthenticationResult) {
    return tokensFromAuth(init.AuthenticationResult);
  }

  if (init.ChallengeName === "SMS_MFA" || init.ChallengeName === "SOFTWARE_TOKEN_MFA" || init.ChallengeName === "EMAIL_OTP") {
    if (!init.Session) throw new Error("Cognito MFA challenge missing Session token");
    const code = (await input.mfaPrompt()).trim();
    const resp = await callCognito("RespondToAuthChallenge", {
      ClientId: "",
      ChallengeName: init.ChallengeName,
      Session: init.Session,
      ChallengeResponses: {
        USERNAME: input.email,
        [init.ChallengeName === "SMS_MFA" ? "SMS_MFA_CODE" : init.ChallengeName === "SOFTWARE_TOKEN_MFA" ? "SOFTWARE_TOKEN_MFA_CODE" : "EMAIL_OTP_CODE"]: code,
      },
    });
    if (!resp.AuthenticationResult) {
      throw new Error(`MFA verification did not return tokens: ${JSON.stringify(resp)}`);
    }
    return tokensFromAuth(resp.AuthenticationResult);
  }

  throw new Error(`Unexpected challenge from Cognito: ${init.ChallengeName ?? "<none>"}`);
}

/**
 * Use the long-lived refresh token to mint a fresh access token.
 * No MFA needed — refresh tokens are pre-authenticated.
 * Returns new access token; refresh token usually NOT rotated (reuse the existing one).
 */
export async function refreshCognitoSession(
  _email: string,
  refreshToken: string,
): Promise<CognitoTokens> {
  const resp = await callCognito("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    AuthParameters: { REFRESH_TOKEN: refreshToken },
    ClientId: "",
  });
  if (!resp.AuthenticationResult) {
    throw new Error(`Refresh did not return tokens: ${JSON.stringify(resp)}`);
  }
  return tokensFromAuth(resp.AuthenticationResult, refreshToken);
}
