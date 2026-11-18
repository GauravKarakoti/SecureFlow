import { describe, it, expect, vi, beforeEach } from "vitest";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import FindingShortRoutePage from "./page";

describe("FindingShortRoutePage (/findings/[id])", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects short permalink /findings/[id] to /dashboard/findings/[id]", async () => {
    await expect(
      FindingShortRoutePage({ params: Promise.resolve({ id: "finding-abc-123" }) }),
    ).rejects.toThrow("NEXT_REDIRECT: /dashboard/findings/finding-abc-123");

    expect(redirectMock).toHaveBeenCalledWith("/dashboard/findings/finding-abc-123");
  });
});
