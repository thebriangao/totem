import { afterEach, describe, expect, it, vi } from "vitest";
import { CognitoError, refreshCognitoSession } from "../../src/whoop/cognito.js";
import { WEB_CLIENT_ID } from "../../src/whoop/constants.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Cognito request timeout", () => {
  it("aborts a refresh that never receives a response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const pending = refreshCognitoSession("refresh-token", WEB_CLIENT_ID);
    const expectation = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });
});

describe("Cognito refresh errors", () => {
  const reply = (status: number, body: object) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("a refused refresh token is an auth failure (log in again)", async () => {
    reply(400, { __type: "NotAuthorizedException", message: "Refresh Token has expired" });
    const err = await refreshCognitoSession("rt", WEB_CLIENT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CognitoError);
    expect((err as CognitoError).isAuthFailure).toBe(true);
    expect((err as CognitoError).message).toMatch(/NotAuthorizedException: Refresh Token has expired/);
  });

  it("throttling and outages are not", () => {
    expect(new CognitoError("x", 400, "TooManyRequestsException").isAuthFailure).toBe(false);
    expect(new CognitoError("x", 500, "InternalErrorException").isAuthFailure).toBe(false);
    expect(new CognitoError("x", 403, null).isAuthFailure).toBe(false); // a Cloudflare block
    expect(new CognitoError("x", 400, "InvalidParameterException").isAuthFailure).toBe(true);
  });

  it("sends the issuing client id and keeps the old refresh token when none is returned", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ AuthenticationResult: { AccessToken: "a.b.c", ExpiresIn: 86400, TokenType: "Bearer" } })));
    vi.stubGlobal("fetch", fetchMock);
    const tokens = await refreshCognitoSession("rt-old", "");
    expect(tokens.refreshToken).toBe("rt-old");
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({ AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: "rt-old" }, ClientId: "" });
  });

  it("never echoes the response body when tokens are missing", async () => {
    reply(200, { AuthenticationResult: { RefreshToken: "leaky-secret" } });
    await expect(refreshCognitoSession("rt", WEB_CLIENT_ID)).rejects.toThrow(/^Cognito refresh returned no tokens$/);
  });
});
