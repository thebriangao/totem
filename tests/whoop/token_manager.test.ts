import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/whoop/cognito.js", () => ({
  decodeJwtExp: () => 0,
  decodeJwtClientId: () => null,
  refreshCognitoSession: vi.fn().mockResolvedValue({
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    idToken: "id",
    expiresAt: Date.now() + 3_600_000,
  }),
}));

import { TokenManager } from "../../src/whoop/token_manager.js";

afterEach(() => vi.restoreAllMocks());

describe("TokenManager persistence failures", () => {
  it("keeps using a successfully refreshed in-memory token when persistence fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new TokenManager({
      email: "test@example.com",
      accessToken: "expired",
      refreshToken: "old-refresh",
      store: { save: () => { throw new Error("read-only filesystem"); } },
    });
    await expect(manager.getToken()).resolves.toBe("fresh-access");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("could not persist"));
  });
});

describe("TokenManager.invalidate", () => {
  it("forces a refresh only when the rejected token is still the current one", async () => {
    const { refreshCognitoSession } = await import("../../src/whoop/cognito.js");
    const refresh = vi.mocked(refreshCognitoSession);
    const manager = new TokenManager({
      email: "test@example.com",
      accessToken: "expired",
      refreshToken: "old-refresh",
      store: { save: () => {} },
    });
    await manager.getToken();
    const callsAfterFirst = refresh.mock.calls.length;

    manager.invalidate("some-older-token");
    await expect(manager.getToken()).resolves.toBe("fresh-access");
    expect(refresh.mock.calls.length).toBe(callsAfterFirst);

    // Within a minute of the last refresh, a rejection doesn't refresh again.
    manager.invalidate("fresh-access");
    await manager.getToken();
    expect(refresh.mock.calls.length).toBe(callsAfterFirst);

    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    manager.invalidate("fresh-access");
    await manager.getToken();
    expect(refresh.mock.calls.length).toBe(callsAfterFirst + 1);
  });
});
