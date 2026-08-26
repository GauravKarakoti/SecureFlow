import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import * as authModule from "@/auth";
import * as syncEngine from "@/lib/github/sync-user-repos";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

describe("POST /api/repositories/sync route (#634)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 Unauthorized when no authenticated session exists", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(null);

    const response = await POST();
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("triggers syncUserRepositories and returns 200 with result when authenticated", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-123", githubLogin: "octocat" },
      accessToken: "gho_secret123",
    } as any);

    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 5,
      hasInstallation: true,
      installationId: 443322,
    });

    const response = await POST();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({
      synced: 5,
      hasInstallation: true,
      installationId: 443322,
    });
    expect(syncEngine.syncUserRepositories).toHaveBeenCalledWith(
      "user-123",
      "octocat",
      "gho_secret123"
    );
  });

  it("returns 500 when synchronization engine throws an unexpected error", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-123" },
    } as any);

    vi.spyOn(syncEngine, "syncUserRepositories").mockRejectedValue(
      new Error("Database deadlock")
    );

    const response = await POST();
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe("Failed to synchronize repositories");
  });
});
