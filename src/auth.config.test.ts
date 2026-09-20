import { describe, it, expect, vi, beforeEach } from "vitest";
import authConfig from "./auth.config";

describe("auth.config jwt callback", () => {
  const jwt = authConfig.callbacks?.jwt;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("returns token without fetching if accessToken has not expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const token = {
      accessToken: "existing-token",
      accessTokenExpires: Date.now() + 60000,
      refreshToken: "valid-refresh-token",
    };

    const result = await jwt!({ token } as any);
    expect(result).toEqual(token);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns token without fetching if refreshToken is undefined or not a string", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const token = {
      accessToken: "existing-token",
      accessTokenExpires: Date.now() - 1000, // expired
      refreshToken: undefined,
    };

    const result = await jwt!({ token } as any);
    expect(result).toEqual(token);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes the access token when expired and refreshToken exists", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: 3600,
          refresh_token: "new-refresh-token",
        }),
        { status: 200 },
      ),
    );

    const token = {
      accessToken: "old-access-token",
      accessTokenExpires: Date.now() - 1000,
      refreshToken: "existing-refresh-token",
      error: "RefreshAccessTokenError",
    };

    const result = (await jwt!({ token } as any)) as any;

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
      }),
    );
    expect(result.accessToken).toBe("new-access-token");
    expect(result.refreshToken).toBe("new-refresh-token");
    expect(result.accessTokenExpires).toBeGreaterThan(Date.now());
    expect(result.error).toBeUndefined();
    expect("error" in result).toBe(false);
  });

  it("sets backoff timestamp and error when token refresh fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad_refresh_token" }), { status: 400 }),
    );

    const before = Date.now();
    const token = {
      accessToken: "old-access-token",
      accessTokenExpires: before - 1000,
      refreshToken: "invalid-refresh-token",
    };

    const result = (await jwt!({ token } as any)) as any;

    expect(result.error).toBe("RefreshAccessTokenError");
    // Should advance accessTokenExpires by ~60 seconds to avoid immediate retry loops
    expect(result.accessTokenExpires).toBeGreaterThanOrEqual(before + 59000);
  });
});
