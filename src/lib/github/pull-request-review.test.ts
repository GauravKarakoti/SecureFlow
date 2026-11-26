import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  syncPullRequestReview,
  SECUREFLOW_REVIEW_MARKER,
  type ReviewClient,
} from "./pull-request-review";

describe("Pull Request Review Mode (#2095)", () => {
  let mockClient: ReviewClient;
  let createReviewMock: ReturnType<typeof vi.fn>;
  let listReviewsMock: ReturnType<typeof vi.fn>;
  let dismissReviewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createReviewMock = vi.fn().mockResolvedValue({ id: 101 });
    listReviewsMock = vi.fn().mockResolvedValue({ data: [] });
    dismissReviewMock = vi.fn().mockResolvedValue({});

    mockClient = {
      rest: {
        pulls: {
          createReview: createReviewMock,
          listReviews: listReviewsMock,
          dismissReview: dismissReviewMock,
        },
      },
    };
  });

  describe("Opt-in Behavior", () => {
    it("skips review creation when pull request review mode is not enabled", async () => {
      const result = await syncPullRequestReview({
        client: mockClient,
        owner: "acme",
        repo: "api",
        prNumber: 42,
        isBlocked: true,
        findingsCount: 3,
        config: { enabled: false },
      });

      expect(result.action).toBe("SKIPPED_NOT_CONFIGURED");
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(dismissReviewMock).not.toHaveBeenCalled();
    });
  });

  describe("Blocked Scans — REQUEST_CHANGES", () => {
    it("creates a REQUEST_CHANGES review when scan is blocked in opt-in repo", async () => {
      const result = await syncPullRequestReview({
        client: mockClient,
        owner: "acme",
        repo: "api",
        prNumber: 42,
        isBlocked: true,
        findingsCount: 5,
        config: { enabled: true },
      });

      expect(result.action).toBe("REQUESTED_CHANGES");
      expect(createReviewMock).toHaveBeenCalledTimes(1);
      expect(createReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "acme",
          repo: "api",
          pull_number: 42,
          event: "REQUEST_CHANGES",
          body: expect.stringContaining(SECUREFLOW_REVIEW_MARKER),
        }),
      );
    });

    it("does not create a second REQUEST_CHANGES review if one is already active", async () => {
      listReviewsMock.mockResolvedValueOnce({
        data: [
          {
            id: 888,
            user: { login: "secureflow-app[bot]" },
            state: "CHANGES_REQUESTED",
            body: `${SECUREFLOW_REVIEW_MARKER}\nprevious review`,
          },
        ],
      });

      const result = await syncPullRequestReview({
        client: mockClient,
        owner: "acme",
        repo: "api",
        prNumber: 42,
        isBlocked: true,
        findingsCount: 2,
        config: { enabled: true },
        appLogin: "secureflow-app[bot]",
      });

      expect(result.action).toBe("SKIPPED_ALREADY_REQUESTED");
      expect(result.reviewId).toBe(888);
      expect(createReviewMock).not.toHaveBeenCalled();
    });
  });

  describe("Passing Scans — Dismissal", () => {
    it("dismisses previous CHANGES_REQUESTED review when scan passes", async () => {
      listReviewsMock.mockResolvedValueOnce({
        data: [
          {
            id: 999,
            user: { login: "secureflow-app[bot]" },
            state: "CHANGES_REQUESTED",
            body: `${SECUREFLOW_REVIEW_MARKER}\nblocking findings`,
          },
        ],
      });

      const result = await syncPullRequestReview({
        client: mockClient,
        owner: "acme",
        repo: "api",
        prNumber: 42,
        isBlocked: false,
        findingsCount: 0,
        config: { enabled: true, dismissOnPass: true },
        appLogin: "secureflow-app[bot]",
      });

      expect(result.action).toBe("DISMISSED_REVIEW");
      expect(result.dismissedReviewIds).toEqual([999]);
      expect(dismissReviewMock).toHaveBeenCalledTimes(1);
      expect(dismissReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "acme",
          repo: "api",
          pull_number: 42,
          review_id: 999,
          message: expect.stringContaining("passed"),
        }),
      );
      // Absolute guarantee: Never APPROVE
      expect(createReviewMock).not.toHaveBeenCalled();
    });

    it("does NOT dismiss non-secureflow reviews", async () => {
      listReviewsMock.mockResolvedValueOnce({
        data: [
          {
            id: 111,
            user: { login: "human-reviewer" },
            state: "CHANGES_REQUESTED",
            body: "Please fix variable naming",
          },
        ],
      });

      const result = await syncPullRequestReview({
        client: mockClient,
        owner: "acme",
        repo: "api",
        prNumber: 42,
        isBlocked: false,
        findingsCount: 0,
        config: { enabled: true },
        appLogin: "secureflow-app[bot]",
      });

      expect(result.action).toBe("COMMENTED_PASS");
      expect(dismissReviewMock).not.toHaveBeenCalled();
      expect(createReviewMock).not.toHaveBeenCalled();
    });
  });

  describe("Never APPROVE Guarantee", () => {
    it("never submits an APPROVE review under any circumstance", async () => {
      const result = await syncPullRequestReview({
        client: mockClient,
        owner: "acme",
        repo: "api",
        prNumber: 42,
        isBlocked: false,
        findingsCount: 0,
        config: { enabled: true },
      });

      for (const call of createReviewMock.mock.calls) {
        expect(call[0].event).not.toBe("APPROVE");
      }
      expect(result.action).not.toBe("APPROVED" as any);
    });
  });

  describe("Error and Missing Permissions Handling", () => {
    it("handles missing review permissions gracefully with warning without throwing", async () => {
      createReviewMock.mockRejectedValueOnce(
        new Error(
          "Resource not accessible by integration: pull_requests write permission required",
        ),
      );

      const result = await syncPullRequestReview({
        client: mockClient,
        owner: "acme",
        repo: "api",
        prNumber: 42,
        isBlocked: true,
        findingsCount: 1,
        config: { enabled: true },
      });

      expect(result.action).toBe("FAILED_GRACEFULLY");
      expect(result.warning).toContain("Resource not accessible by integration");
    });
  });
});
