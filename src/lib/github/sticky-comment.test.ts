import { describe, expect, it, vi } from "vitest";
import {
  SECUREFLOW_COMMENT_MARKER,
  ensureSecureFlowMarker,
  findSecureFlowComment,
  findAllSecureFlowComments,
  formatScanMetadata,
  isNotFoundError,
  isSecureFlowComment,
  minimizeOutdatedComment,
  deleteCommentSafely,
  replaceSecureFlowComment,
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

describe("isSecureFlowComment", () => {
  it("returns true for comments containing the default marker", () => {
    expect(isSecureFlowComment(`${SECUREFLOW_COMMENT_MARKER}\n\nReport body`)).toBe(true);
  });

  it("returns true for comments containing alternative secureflow markers", () => {
    expect(isSecureFlowComment("<!-- secureflow:pr-comment -->\n\nReport")).toBe(true);
    expect(isSecureFlowComment("<!-- secureflow-ai-security-report -->\n\nReport")).toBe(true);
  });

  it("returns false for non-secureflow comments or non-strings", () => {
    expect(isSecureFlowComment("LGTM, good work!")).toBe(false);
    expect(isSecureFlowComment(null)).toBe(false);
    expect(isSecureFlowComment(undefined)).toBe(false);
    expect(isSecureFlowComment("")).toBe(false);
  });
});

describe("formatScanMetadata", () => {
  it("formats both commit SHA and scan time as ISO string", () => {
    const meta = formatScanMetadata({
      commitSha: "abc1234",
      scanTime: "2026-11-22T10:00:00.000Z",
    });
    expect(meta).toBe("Scanned commit: `abc1234`\nScan time: `2026-11-22T10:00:00.000Z`\n\n");
  });

  it("formats scan time when passed as a Date object", () => {
    const d = new Date("2026-11-22T12:30:00.000Z");
    const meta = formatScanMetadata({
      commitSha: "def5678",
      scanTime: d,
    });
    expect(meta).toBe("Scanned commit: `def5678`\nScan time: `2026-11-22T12:30:00.000Z`\n\n");
  });

  it("formats only commit SHA when scan time is omitted", () => {
    const meta = formatScanMetadata({ commitSha: "abc1234" });
    expect(meta).toBe("Scanned commit: `abc1234`\n\n");
  });

  it("formats only scan time when commit SHA is omitted", () => {
    const meta = formatScanMetadata({ scanTime: "2026-11-22T10:00:00.000Z" });
    expect(meta).toBe("Scan time: `2026-11-22T10:00:00.000Z`\n\n");
  });

  it("returns empty string when neither is provided", () => {
    expect(formatScanMetadata({})).toBe("");
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
    it("maintains a single comment across three pushes and displays latest commit SHA and scan time", async () => {
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
      const push1Time = "2026-11-22T10:00:00.000Z";
      // Worker posts pending scan
      const push1Pending = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: `### ⏳ SecureFlow AI Security Scan\n\nScanned commit: \`${push1Sha}\`\nScan time: \`${push1Time}\`\n\nEvaluating 3 files...`,
      });
      expect(push1Pending.action).toBe("created");
      expect(store).toHaveLength(1);

      // Scan completes with 2 findings
      const push1Done = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        commentId: push1Pending.data.id,
        body: `### 🛡️ SecureFlow AI Security Report\n\nScanned commit: \`${push1Sha}\`\nScan time: \`${push1Time}\`\n\n⚠️ Detected **2** potential issues.`,
      });
      expect(push1Done.action).toBe("updated");
      expect(store).toHaveLength(1);
      expect(store[0].body).toContain(`Scanned commit: \`${push1Sha}\``);
      expect(store[0].body).toContain(`Scan time: \`${push1Time}\``);
      expect(store[0].body).toContain("Detected **2** potential issues");

      // --- Push 2: commit sha222222 ---
      const push2Sha = "2222222222222222222222222222222222222222";
      const push2Time = "2026-11-22T11:00:00.000Z";
      // Worker posts pending scan (finds existing comment)
      const push2Pending = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: `### ⏳ SecureFlow AI Security Scan\n\nScanned commit: \`${push2Sha}\`\nScan time: \`${push2Time}\`\n\nEvaluating 4 files...`,
      });
      expect(push2Pending.action).toBe("updated");
      expect(store).toHaveLength(1);

      // Scan completes with 1 finding
      const push2Done = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        commentId: push2Pending.data.id,
        body: `### 🛡️ SecureFlow AI Security Report\n\nScanned commit: \`${push2Sha}\`\nScan time: \`${push2Time}\`\n\n⚠️ Detected **1** potential issues.`,
      });
      expect(push2Done.action).toBe("updated");
      expect(store).toHaveLength(1);
      expect(store[0].body).toContain(`Scanned commit: \`${push2Sha}\``);
      expect(store[0].body).toContain(`Scan time: \`${push2Time}\``);
      expect(store[0].body).toContain("Detected **1** potential issues");

      // --- Push 3: commit sha333333 ---
      const push3Sha = "3333333333333333333333333333333333333333";
      const push3Time = "2026-11-22T12:00:00.000Z";
      // Worker posts pending scan (finds existing comment)
      const push3Pending = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        body: `### ⏳ SecureFlow AI Security Scan\n\nScanned commit: \`${push3Sha}\`\nScan time: \`${push3Time}\`\n\nEvaluating 5 files...`,
      });
      expect(push3Pending.action).toBe("updated");
      expect(store).toHaveLength(1);

      // Scan completes: clean scan (0 vulnerabilities)
      const push3Done = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "app",
        issueNumber: 42,
        commentId: push3Pending.data.id,
        body: `### 🛡️ SecureFlow AI Security Report\n\nScanned commit: \`${push3Sha}\`\nScan time: \`${push3Time}\`\n\n✅ Scan completed successfully. No vulnerabilities found in the **5** analyzed files.`,
      });
      expect(push3Done.action).toBe("updated");

      // --- Final assertions across the whole 3-push sequence ---
      expect(store).toHaveLength(1); // Exactly one comment on the PR
      expect(store[0].id).toBe(1); // Same comment ID reused throughout
      expect(store[0].body).toContain(SECUREFLOW_COMMENT_MARKER);
      expect(store[0].body).toContain(`Scanned commit: \`${push3Sha}\``);
      expect(store[0].body).toContain(`Scan time: \`${push3Time}\``);
      expect(store[0].body).toContain("Scan completed successfully");
      expect(store[0].body).not.toContain(push1Sha);
      expect(store[0].body).not.toContain(push2Sha);
      expect(store[0].body).not.toContain(push1Time);
      expect(store[0].body).not.toContain(push2Time);

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

  describe("replaceSecureFlowComment & delete-old-and-create strategy (#2012)", () => {
    it("deletes existing SecureFlow comments and creates a clean new comment", async () => {
      const deletedIds: number[] = [];
      const commentsStore = [
        { id: 10, node_id: "IC_kw10", body: `${SECUREFLOW_COMMENT_MARKER}\nOld Push 1 comment` },
        { id: 11, node_id: "IC_kw11", body: `${SECUREFLOW_COMMENT_MARKER}\nOld Push 2 comment` },
        { id: 99, node_id: "IC_kw99", body: "User review comment without marker" },
      ];

      const mockOctokit = {
        rest: {
          issues: {
            listComments: vi.fn().mockResolvedValue({
              data: [...commentsStore],
            }),
            deleteComment: vi.fn().mockImplementation(async ({ comment_id }) => {
              deletedIds.push(comment_id);
              const idx = commentsStore.findIndex((c) => c.id === comment_id);
              if (idx !== -1) commentsStore.splice(idx, 1);
              return {};
            }),
            createComment: vi.fn().mockImplementation(async ({ body }) => {
              const newComment = { id: 12, node_id: "IC_kw12", body };
              commentsStore.push(newComment);
              return { data: newComment };
            }),
          },
        },
      };

      const result = await replaceSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 42,
        body: "Fresh Push 3 comment",
      });

      expect(result.action).toBe("created");
      expect(result.data.id).toBe(12);
      expect(deletedIds).toEqual([10, 11]);
      // Only the non-SecureFlow comment and the fresh comment remain
      expect(commentsStore.map((c) => c.id)).toEqual([99, 12]);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "repo",
        issue_number: 42,
        body: expect.stringContaining("Fresh Push 3 comment"),
      });
    });

    it("falls back gracefully when old comment was already deleted (404 on delete)", async () => {
      const mockOctokit = {
        rest: {
          issues: {
            listComments: vi.fn().mockResolvedValue({
              data: [
                { id: 10, node_id: "IC_kw10", body: `${SECUREFLOW_COMMENT_MARKER}\nReport 1` },
              ],
            }),
            deleteComment: vi.fn().mockRejectedValue({
              status: 404,
              message: "Not Found",
            }),
            createComment: vi.fn().mockResolvedValue({
              data: { id: 11, body: "New report" },
            }),
          },
        },
      };

      const result = await replaceSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 42,
        body: "Fresh scan report",
      });

      expect(result.action).toBe("created");
      expect(result.data.id).toBe(11);
      expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "repo",
        comment_id: 10,
      });
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    it("triggers replaceOldComments through upsertSecureFlowComment when option is set", async () => {
      const deleteComment = vi.fn().mockResolvedValue({});
      const createComment = vi.fn().mockResolvedValue({
        data: { id: 25, body: "created" },
      });
      const listComments = vi.fn().mockResolvedValue({
        data: [
          { id: 20, node_id: "IC_kw20", body: `${SECUREFLOW_COMMENT_MARKER}\nPrevious comment` },
        ],
      });

      const mockOctokit = {
        rest: {
          issues: {
            listComments,
            deleteComment,
            createComment,
          },
        },
      };

      const result = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 42,
        body: "Replaced comment body",
        replaceOldComments: true,
      });

      expect(result.action).toBe("created");
      expect(result.data.id).toBe(25);
      expect(deleteComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "repo",
        comment_id: 20,
      });
      expect(createComment).toHaveBeenCalledTimes(1);
    });
  });

  describe("minimizeOutdatedComment and extra comments minimization (#2012)", () => {
    it("calls GraphQL minimizeComment with OUTDATED classifier", async () => {
      const mockGraphql = vi.fn().mockResolvedValue({
        minimizeComment: {
          minimizedComment: {
            isMinimized: true,
            minimizedReason: "OUTDATED",
          },
        },
      });

      const mockOctokit = {
        graphql: mockGraphql,
      };

      const success = await minimizeOutdatedComment(mockOctokit, "IC_kwTest123", "OUTDATED");
      expect(success).toBe(true);
      expect(mockGraphql).toHaveBeenCalledTimes(1);
      expect(mockGraphql).toHaveBeenCalledWith(
        expect.stringContaining("minimizeComment"),
        expect.objectContaining({
          input: {
            subjectId: "IC_kwTest123",
            classifier: "OUTDATED",
          },
        }),
      );
    });

    it("minimizes extra comments as outdated when multiple SecureFlow comments exist", async () => {
      const mockGraphql = vi.fn().mockResolvedValue({});
      const updateComment = vi.fn().mockResolvedValue({
        data: { id: 101, body: "updated" },
      });
      const listComments = vi.fn().mockResolvedValue({
        data: [
          { id: 101, node_id: "IC_kw101", body: `${SECUREFLOW_COMMENT_MARKER}\nMain comment` },
          { id: 102, node_id: "IC_kw102", body: `${SECUREFLOW_COMMENT_MARKER}\nStale comment 1` },
          { id: 103, node_id: "IC_kw103", body: `${SECUREFLOW_COMMENT_MARKER}\nStale comment 2` },
        ],
      });

      const mockOctokit = {
        graphql: mockGraphql,
        rest: {
          issues: {
            listComments,
            updateComment,
            createComment: vi.fn(),
          },
        },
      };

      const result = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 42,
        body: "Updated latest scan report",
      });

      expect(result.action).toBe("updated");
      expect(result.data.id).toBe(101);
      // Both stale extra comments (102, 103) should be minimized as OUTDATED
      expect(mockGraphql).toHaveBeenCalledTimes(2);
      expect(mockGraphql).toHaveBeenCalledWith(
        expect.stringContaining("minimizeComment"),
        expect.objectContaining({ input: { subjectId: "IC_kw102", classifier: "OUTDATED" } }),
      );
      expect(mockGraphql).toHaveBeenCalledWith(
        expect.stringContaining("minimizeComment"),
        expect.objectContaining({ input: { subjectId: "IC_kw103", classifier: "OUTDATED" } }),
      );
    });

    it("minimizes extra comments if delete fails during replaceSecureFlowComment", async () => {
      const mockGraphql = vi.fn().mockResolvedValue({});
      const listComments = vi.fn().mockResolvedValue({
        data: [{ id: 201, node_id: "IC_kw201", body: `${SECUREFLOW_COMMENT_MARKER}\nStale 1` }],
      });
      const deleteComment = vi.fn().mockRejectedValue(new Error("Permission denied"));
      const createComment = vi.fn().mockResolvedValue({
        data: { id: 202, body: "New report" },
      });

      const mockOctokit = {
        graphql: mockGraphql,
        rest: {
          issues: {
            listComments,
            deleteComment,
            createComment,
          },
        },
      };

      const result = await replaceSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 42,
        body: "New scan report",
      });

      expect(result.action).toBe("created");
      expect(deleteComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "repo",
        comment_id: 201,
      });
      // Fallback minimization executed
      expect(mockGraphql).toHaveBeenCalledTimes(1);
      expect(mockGraphql).toHaveBeenCalledWith(
        expect.stringContaining("minimizeComment"),
        expect.objectContaining({ input: { subjectId: "IC_kw201", classifier: "OUTDATED" } }),
      );
    });

    it("handles findAllSecureFlowComments with pagination", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        body: i === 50 ? `${SECUREFLOW_COMMENT_MARKER}\nFound in page 1` : "Regular comment",
      }));
      const page2 = [
        { id: 101, body: `${SECUREFLOW_COMMENT_MARKER}\nFound in page 2` },
        { id: 102, body: "Regular comment in page 2" },
      ];

      const listComments = vi.fn().mockImplementation(async ({ page }) => {
        if (page === 1) return { data: page1 };
        if (page === 2) return { data: page2 };
        return { data: [] };
      });

      const mockOctokit = {
        rest: {
          issues: { listComments },
        },
      };

      const matches = await findAllSecureFlowComments(mockOctokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 42,
      });

      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.id)).toEqual([51, 101]);
      expect(listComments).toHaveBeenCalledTimes(2);
    });

    it("matches legacy comments containing 'SecureFlow AI Security Report' even without the hidden marker", async () => {
      const listComments = vi.fn().mockResolvedValue({
        data: [{ id: 88, body: "### 🛡️ SecureFlow AI Security Report\n\nInitial scan findings..." }],
      });
      const updateComment = vi.fn().mockResolvedValue({
        data: { id: 88, body: "updated" },
      });

      const mockOctokit = {
        rest: {
          issues: { listComments, updateComment },
        },
      };

      const result = await upsertSecureFlowComment(mockOctokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 174,
        body: "### 🛡️ SecureFlow AI Security Report\n\nSecond push findings...",
        commitSha: "sha-push-2",
        scanTime: "2026-11-25T22:30:00Z",
      });

      expect(result.action).toBe("updated");
      expect(updateComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "repo",
        comment_id: 88,
        body: expect.stringContaining("Scanned commit: `sha-push-2`"),
      });
      expect(updateComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "repo",
        comment_id: 88,
        body: expect.stringContaining(SECUREFLOW_COMMENT_MARKER),
      });
    });

    it("ensures a PR with several pushes maintains exactly one comment reflecting the latest scan", async () => {
      let currentComment: { id: number; body: string } | null = null;

      const listComments = vi.fn().mockImplementation(async () => ({
        data: currentComment ? [currentComment] : [],
      }));

      const createComment = vi.fn().mockImplementation(async ({ body }) => {
        currentComment = { id: 1, body };
        return { data: currentComment };
      });

      const updateComment = vi.fn().mockImplementation(async ({ body }) => {
        currentComment = { id: 1, body };
        return { data: currentComment };
      });

      const octokit = {
        rest: {
          issues: { listComments, createComment, updateComment },
        },
      };

      // Push 1
      const res1 = await upsertSecureFlowComment(octokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 174,
        body: "Scan 1",
        commitSha: "sha111",
        scanTime: "2026-11-25T10:00:00Z",
      });
      expect(res1.action).toBe("created");
      expect(currentComment?.body).toContain("Scanned commit: `sha111`");

      // Push 2
      const res2 = await upsertSecureFlowComment(octokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 174,
        body: "Scan 2",
        commitSha: "sha222",
        scanTime: "2026-11-25T11:00:00Z",
      });
      expect(res2.action).toBe("updated");
      expect(currentComment?.body).toContain("Scanned commit: `sha222`");
      expect(currentComment?.body).not.toContain("sha111");

      // Push 3
      const res3 = await upsertSecureFlowComment(octokit, {
        owner: "acme",
        repo: "repo",
        issueNumber: 174,
        body: "Scan 3",
        commitSha: "sha333",
        scanTime: "2026-11-25T12:00:00Z",
      });
      expect(res3.action).toBe("updated");
      expect(currentComment?.body).toContain("Scanned commit: `sha333`");
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(updateComment).toHaveBeenCalledTimes(2);
    });
  });
});
