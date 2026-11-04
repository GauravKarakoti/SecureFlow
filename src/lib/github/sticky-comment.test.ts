import { describe, expect, it, vi } from "vitest";
import {
  SECUREFLOW_COMMENT_MARKER,
  ensureSecureFlowMarker,
  findSecureFlowComment,
  isNotFoundError,
  upsertSecureFlowComment,
} from "./sticky-comment";

describe("isNotFoundError", () => {
  it("recognizes status 404 on standard error objects", () => {
    expect(isNotFoundError(Object.assign(new Error("Not Found"), { status: 404 }))).toBe(true);
    expect(isNotFoundError({ status: 404 })).toBe(true);
    expect(isNotFoundError({ statusCode: 404 })).toBe(true);
  });

  it("recognizes status 404 in response object", () => {
    expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
  });

  it("recognizes Not Found in error message", () => {
    expect(isNotFoundError(new Error("Resource not found"))).toBe(true);
  });

  it("returns false for non-404 errors", () => {
    expect(isNotFoundError(new Error("Internal Server Error"))).toBe(false);
    expect(isNotFoundError({ status: 500 })).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError("error")).toBe(false);
  });
});

describe("ensureSecureFlowMarker", () => {
  it("prepends the marker if not present", () => {
    const text = "Some report body";
    const result = ensureSecureFlowMarker(text);
    expect(result).toBe(`${SECUREFLOW_COMMENT_MARKER}\n\n${text}`);
  });

  it("leaves the body unchanged if marker is already present", () => {
    const text = `${SECUREFLOW_COMMENT_MARKER}\n\nExisting report`;
    const result = ensureSecureFlowMarker(text);
    expect(result).toBe(text);
  });
});

describe("findSecureFlowComment", () => {
  it("returns null when octokit does not support listComments", async () => {
    const octokit = { rest: { issues: {} } };
    const found = await findSecureFlowComment(octokit, {
      owner: "acme",
      repo: "app",
      issueNumber: 10,
    });
    expect(found).toBeNull();
  });

  it("returns null when comments list is empty", async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    };
    const found = await findSecureFlowComment(octokit, {
      owner: "acme",
      repo: "app",
      issueNumber: 10,
    });
    expect(found).toBeNull();
  });

  it("returns null when comments exist but none have the marker", async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [
              { id: 1, body: "Great pull request! Looks good to me." },
              { id: 2, body: "Could you add tests for this?" },
            ],
          }),
        },
      },
    };
    const found = await findSecureFlowComment(octokit, {
      owner: "acme",
      repo: "app",
      issueNumber: 10,
    });
    expect(found).toBeNull();
  });

  it("returns the comment when a comment contains the marker", async () => {
    const target = {
      id: 42,
      body: `${SECUREFLOW_COMMENT_MARKER}\n### 🛡️ SecureFlow AI Security Report`,
    };
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [{ id: 1, body: "LGTM" }, target],
          }),
        },
      },
    };
    const found = await findSecureFlowComment(octokit, {
      owner: "acme",
      repo: "app",
      issueNumber: 10,
    });
    expect(found).toEqual(target);
  });

  it("paginates through multiple pages when comment is on page 2", async () => {
    const page1Comments = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `Comment ${i + 1} without marker`,
    }));
    const page2Comments = [{ id: 201, body: `${SECUREFLOW_COMMENT_MARKER}\nFound on page 2` }];

    const listComments = vi
      .fn()
      .mockResolvedValueOnce({ data: page1Comments })
      .mockResolvedValueOnce({ data: page2Comments });

    const octokit = { rest: { issues: { listComments } } };

    const found = await findSecureFlowComment(octokit, {
      owner: "acme",
      repo: "app",
      issueNumber: 10,
    });

    expect(found?.id).toBe(201);
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(listComments).toHaveBeenNthCalledWith(1, {
      owner: "acme",
      repo: "app",
      issue_number: 10,
      per_page: 100,
      page: 1,
    });
    expect(listComments).toHaveBeenNthCalledWith(2, {
      owner: "acme",
      repo: "app",
      issue_number: 10,
      per_page: 100,
      page: 2,
    });
  });
});

describe("upsertSecureFlowComment", () => {
  describe("create case", () => {
    it("creates a new comment if none exists with the marker", async () => {
      const createComment = vi.fn().mockResolvedValue({
        data: { id: 101, body: "created" },
      });
      const updateComment = vi.fn();
      const listComments = vi.fn().mockResolvedValue({ data: [] });

      const octokit = {
        rest: {
          issues: { createComment, updateComment, listComments },
        },
      };

      const result = await upsertSecureFlowComment(octokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 5,
        body: "### ⏳ SecureFlow AI Security Scan\n\nScanned commit: `abc123`",
      });

      expect(result.action).toBe("created");
      expect(result.data.id).toBe(101);
      expect(createComment).toHaveBeenCalledOnce();
      expect(createComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "app",
        issue_number: 5,
        body: expect.stringContaining(SECUREFLOW_COMMENT_MARKER),
      });
      expect(updateComment).not.toHaveBeenCalled();
    });
  });

  describe("update case", () => {
    it("updates existing comment when found via listComments", async () => {
      const existing = {
        id: 42,
        body: `${SECUREFLOW_COMMENT_MARKER}\nOld pending scan`,
      };
      const createComment = vi.fn();
      const updateComment = vi.fn().mockResolvedValue({
        data: { id: 42, body: "updated" },
      });
      const listComments = vi.fn().mockResolvedValue({ data: [existing] });

      const octokit = {
        rest: {
          issues: { createComment, updateComment, listComments },
        },
      };

      const result = await upsertSecureFlowComment(octokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 5,
        body: "### 🛡️ SecureFlow AI Security Report\n\nScanned commit: `def456`",
      });

      expect(result.action).toBe("updated");
      expect(result.data.id).toBe(42);
      expect(updateComment).toHaveBeenCalledOnce();
      expect(updateComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "app",
        comment_id: 42,
        body: expect.stringContaining(SECUREFLOW_COMMENT_MARKER),
      });
      expect(createComment).not.toHaveBeenCalled();
    });

    it("updates directly when commentId is explicitly provided", async () => {
      const createComment = vi.fn();
      const updateComment = vi.fn().mockResolvedValue({
        data: { id: 99, body: "updated" },
      });
      const listComments = vi.fn();

      const octokit = {
        rest: {
          issues: { createComment, updateComment, listComments },
        },
      };

      const result = await upsertSecureFlowComment(octokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 5,
        commentId: 99,
        body: "Updated report",
      });

      expect(result.action).toBe("updated");
      expect(result.data.id).toBe(99);
      expect(updateComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "app",
        comment_id: 99,
        body: expect.stringContaining(SECUREFLOW_COMMENT_MARKER),
      });
      expect(listComments).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
    });
  });

  describe("deleted-comment case", () => {
    it("creates a new comment if updating an existing comment returns 404", async () => {
      const createComment = vi.fn().mockResolvedValue({
        data: { id: 102, body: "re-created comment" },
      });
      const updateComment = vi.fn().mockRejectedValue({
        status: 404,
        message: "Not Found",
      });
      const listComments = vi.fn().mockResolvedValue({
        data: [{ id: 42, body: `${SECUREFLOW_COMMENT_MARKER}\nOld comment` }],
      });

      const octokit = {
        rest: {
          issues: { createComment, updateComment, listComments },
        },
      };

      const result = await upsertSecureFlowComment(octokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 5,
        body: "### 🛡️ SecureFlow AI Security Report\n\nScanned commit: `789xyz`",
      });

      expect(result.action).toBe("created");
      expect(result.data.id).toBe(102);
      expect(updateComment).toHaveBeenCalledOnce();
      expect(createComment).toHaveBeenCalledOnce();
      expect(createComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "app",
        issue_number: 5,
        body: expect.stringContaining(SECUREFLOW_COMMENT_MARKER),
      });
    });

    it("creates a new comment if explicit commentId update fails with 404", async () => {
      const createComment = vi.fn().mockResolvedValue({
        data: { id: 205, body: "brand new comment" },
      });
      const updateComment = vi.fn().mockRejectedValue({
        status: 404,
        message: "Comment not found",
      });

      const octokit = {
        rest: {
          issues: { createComment, updateComment },
        },
      };

      const result = await upsertSecureFlowComment(octokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 5,
        commentId: 55,
        body: "Report after comment deletion",
      });

      expect(result.action).toBe("created");
      expect(result.data.id).toBe(205);
      expect(updateComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "app",
        comment_id: 55,
        body: expect.stringContaining(SECUREFLOW_COMMENT_MARKER),
      });
      expect(createComment).toHaveBeenCalledOnce();
    });

    it("re-throws error if updateComment fails with non-404 status", async () => {
      const createComment = vi.fn();
      const updateComment = vi.fn().mockRejectedValue({
        status: 500,
        message: "Internal Server Error",
      });

      const octokit = {
        rest: {
          issues: { createComment, updateComment },
        },
      };

      await expect(
        upsertSecureFlowComment(octokit, {
          owner: "acme",
          repo: "app",
          issueNumber: 5,
          commentId: 55,
          body: "Report",
        }),
      ).rejects.toMatchObject({ status: 500 });

      expect(createComment).not.toHaveBeenCalled();
    });
  });

  describe("Three pushes to one PR leave a single comment that shows the latest result", () => {
    it("maintains a single comment across three pushes and displays latest commit SHA", async () => {
      // In-memory store representing GitHub's PR comment list
      const store: Array<{ id: number; body: string }> = [];
      let nextId = 1;

      const mockOctokit = {
        rest: {
          issues: {
            listComments: vi.fn().mockImplementation(async () => ({
              data: [...store],
            })),
            createComment: vi.fn().mockImplementation(async ({ body }) => {
              const comment = { id: nextId++, body };
              store.push(comment);
              return { data: comment };
            }),
            updateComment: vi.fn().mockImplementation(async ({ comment_id, body }) => {
              const index = store.findIndex((c) => c.id === comment_id);
              if (index === -1) {
                const err = Object.assign(new Error("Not Found"), { status: 404 });
                throw err;
              }
              store[index] = { id: comment_id, body };
              return { data: store[index] };
            }),
          },
        },
      };

      // --- Push 1: initial commit sha111111 ---
      const push1Sha = "1111111111111111111111111111111111111111";
      // Worker posts pending scan
      const push1Pending = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: `### ⏳ SecureFlow AI Security Scan\n\nScanned commit: \`${push1Sha}\`\n\nEvaluating 3 files...`,
      });
      expect(push1Pending.action).toBe("created");
      expect(store).toHaveLength(1);

      // Scan completes with 2 findings
      const push1Done = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        commentId: push1Pending.data.id,
        body: `### 🛡️ SecureFlow AI Security Report\n\nScanned commit: \`${push1Sha}\`\n\n⚠️ Detected **2** potential issues.`,
      });
      expect(push1Done.action).toBe("updated");
      expect(store).toHaveLength(1);
      expect(store[0].body).toContain(`Scanned commit: \`${push1Sha}\``);
      expect(store[0].body).toContain("Detected **2** potential issues");

      // --- Push 2: commit sha222222 ---
      const push2Sha = "2222222222222222222222222222222222222222";
      // Worker posts pending scan (finds existing comment)
      const push2Pending = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: `### ⏳ SecureFlow AI Security Scan\n\nScanned commit: \`${push2Sha}\`\n\nEvaluating 4 files...`,
      });
      expect(push2Pending.action).toBe("updated");
      expect(store).toHaveLength(1);

      // Scan completes with 1 finding
      const push2Done = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        commentId: push2Pending.data.id,
        body: `### 🛡️ SecureFlow AI Security Report\n\nScanned commit: \`${push2Sha}\`\n\n⚠️ Detected **1** potential issues.`,
      });
      expect(push2Done.action).toBe("updated");
      expect(store).toHaveLength(1);
      expect(store[0].body).toContain(`Scanned commit: \`${push2Sha}\``);
      expect(store[0].body).toContain("Detected **1** potential issues");

      // --- Push 3: commit sha333333 ---
      const push3Sha = "3333333333333333333333333333333333333333";
      // Worker posts pending scan (finds existing comment)
      const push3Pending = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: `### ⏳ SecureFlow AI Security Scan\n\nScanned commit: \`${push3Sha}\`\n\nEvaluating 5 files...`,
      });
      expect(push3Pending.action).toBe("updated");
      expect(store).toHaveLength(1);

      // Scan completes: clean scan (0 vulnerabilities)
      const push3Done = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        commentId: push3Pending.data.id,
        body: `### 🛡️ SecureFlow AI Security Report\n\nScanned commit: \`${push3Sha}\`\n\n✅ Scan completed successfully. No vulnerabilities found in the **5** analyzed files.`,
      });
      expect(push3Done.action).toBe("updated");

      // --- Final assertions across the whole 3-push sequence ---
      expect(store).toHaveLength(1); // Exactly one comment on the PR
      expect(store[0].id).toBe(1); // Same comment ID reused throughout
      expect(store[0].body).toContain(SECUREFLOW_COMMENT_MARKER);
      expect(store[0].body).toContain(`Scanned commit: \`${push3Sha}\``);
      expect(store[0].body).toContain("Scan completed successfully");
      expect(store[0].body).not.toContain(push1Sha);
      expect(store[0].body).not.toContain(push2Sha);

      // createComment called only once at the beginning
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      // updateComment called on every subsequent pending and done
      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledTimes(5);
    });

    it("recovers and leaves a single comment if the comment is deleted prior to push 3", async () => {
      const store: Array<{ id: number; body: string }> = [];
      let nextId = 1;

      const mockOctokit = {
        rest: {
          issues: {
            listComments: vi.fn().mockImplementation(async () => ({
              data: [...store],
            })),
            createComment: vi.fn().mockImplementation(async ({ body }) => {
              const comment = { id: nextId++, body };
              store.push(comment);
              return { data: comment };
            }),
            updateComment: vi.fn().mockImplementation(async ({ comment_id, body }) => {
              const index = store.findIndex((c) => c.id === comment_id);
              if (index === -1) {
                const err = Object.assign(new Error("Not Found"), { status: 404 });
                throw err;
              }
              store[index] = { id: comment_id, body };
              return { data: store[index] };
            }),
          },
        },
      };

      // Push 1
      await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: "Push 1 report (sha1)",
      });
      expect(store).toHaveLength(1);
      expect(store[0].id).toBe(1);

      // Push 2
      await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: "Push 2 report (sha2)",
      });
      expect(store).toHaveLength(1);
      expect(store[0].id).toBe(1);

      // User deletes comment 1 before Push 3
      store.length = 0;

      // Push 3
      const push3Result = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: "Push 3 report (sha3)",
      });

      expect(push3Result.action).toBe("created");
      expect(store).toHaveLength(1);
      expect(store[0].id).toBe(2);
      expect(store[0].body).toContain("Push 3 report (sha3)");
    });
  });
});
