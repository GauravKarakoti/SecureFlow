import { describe, expect, it } from "vitest";
import { captureGitHubAccessToken, withGitHubAccessTokenCapture } from "./oauth-token-capture";

describe("captureGitHubAccessToken", () => {
  it("is a no-op outside withGitHubAccessTokenCapture", () => {
    // The contract that keeps /api/auth/session responses token-free.
    expect(() => captureGitHubAccessToken("secret-token")).not.toThrow();
  });

  it("ignores non-string and empty tokens inside a capture scope", async () => {
    for (const bad of [123, "", null, undefined, {}]) {
      const { accessToken } = await withGitHubAccessTokenCapture(async () => {
        captureGitHubAccessToken(bad);
      });
      expect(accessToken).toBeNull();
    }
  });
});

describe("withGitHubAccessTokenCapture", () => {
  it("returns the fn result together with the captured token", async () => {
    const { result, accessToken } = await withGitHubAccessTokenCapture(async () => {
      captureGitHubAccessToken("gho_secret");
      return 42;
    });
    expect(result).toBe(42);
    expect(accessToken).toBe("gho_secret");
  });

  it("returns null when the callback never captured a token", async () => {
    const { accessToken } = await withGitHubAccessTokenCapture(async () => {});
    expect(accessToken).toBeNull();
  });

  it("keeps concurrent capture scopes isolated", async () => {
    // The property that makes AsyncLocalStorage safe here: two interleaved
    // scopes must each see only their own token.
    const slow = withGitHubAccessTokenCapture(async () => {
      captureGitHubAccessToken("token-a");
      await new Promise((resolve) => setTimeout(resolve, 20));
      captureGitHubAccessToken("token-a2");
    });
    const fast = withGitHubAccessTokenCapture(async () => {
      captureGitHubAccessToken("token-b");
    });

    const [a, b] = await Promise.all([slow, fast]);
    expect(a.accessToken).toBe("token-a2");
    expect(b.accessToken).toBe("token-b");
  });

  it("does not leak the token to code running outside the scope", async () => {
    let outside: Promise<{ result: void | null; accessToken: string | null }> | undefined;
    await withGitHubAccessTokenCapture(async () => {
      captureGitHubAccessToken("inside-token");
      outside = withGitHubAccessTokenCapture(async () => {});
    });
    // A nested scope is a fresh slot; unrelated captures stay separate.
    expect((await outside!).accessToken).toBeNull();
  });
});
