import { describe, it, expect, vi } from "vitest";
import {
  buildFindingIssueTemplate,
  createGitHubIssue,
  GitHubPermissionError,
  isMissingIssuesPermissionError,
  type FindingIssueSourceData,
  type OctokitIssuesClient,
  type GitHubAppClientLike,
} from "./issue-creator";
import { REDACTION_PLACEHOLDER } from "@/lib/armor/secret-masking";

describe("Finding Issue Template Builder (#1987)", () => {
  const baseFinding: FindingIssueSourceData = {
    id: "finding-123",
    type: "SECRET",
    severity: "CRITICAL",
    fileLocation: "src/config/secrets.ts",
    lineStart: 42,
    lineEnd: 45,
    codeSnippet: "const apiKey = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';",
    explanation: "Detected active GitHub personal token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    remediation:
      "Store the secret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 in an environment variable.",
    policyDecision: "BLOCKED",
    repositoryFullName: "acme/corp",
    pullRequestNumber: 101,
    commitSha: "c0ffee1234567890abcdef",
  };

  it("builds pre-filled title and body with file links, policy, and explanation", () => {
    const template = buildFindingIssueTemplate(baseFinding);

    expect(template.title).toContain(
      "[Security] CRITICAL: SECRET in src/config/secrets.ts (L42-L45)",
    );
    expect(template.body).toContain("## Security Finding Details");
    expect(template.body).toContain("- **Severity:** CRITICAL");
    expect(template.body).toContain("- **Policy Decision:** BLOCKED");
    expect(template.body).toContain(
      "https://github.com/acme/corp/blob/c0ffee1234567890abcdef/src/config/secrets.ts#L42-L45",
    );
    expect(template.body).toContain("https://github.com/acme/corp/pull/101");
  });

  it("redacts secret values from title, explanation, and remediation advice", () => {
    const template = buildFindingIssueTemplate(baseFinding);

    // Secrets in explanation and remediation must be replaced with the redaction placeholder
    expect(template.body).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(template.body).toContain(REDACTION_PLACEHOLDER);

    // The raw code snippet must NOT be included in the issue body
    expect(template.body).not.toContain("const apiKey =");
  });
});

describe("GitHub Issue Creator (#1987)", () => {
  it("successfully creates an issue using the mocked GitHub client", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      data: {
        html_url: "https://github.com/acme/corp/issues/42",
        number: 42,
      },
    });

    const mockOctokit: OctokitIssuesClient = {
      rest: {
        issues: {
          create: mockCreate,
        },
      },
    };

    const result = await createGitHubIssue(
      {
        owner: "acme",
        repo: "corp",
        title: "Test Issue",
        body: "Test Body with secret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      },
      { octokitClient: mockOctokit },
    );

    expect(result).toEqual({
      url: "https://github.com/acme/corp/issues/42",
      number: 42,
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Ensure the dispatched body has secrets redacted
    const calledArgs = mockCreate.mock.calls[0][0];
    expect(calledArgs.body).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(calledArgs.body).toContain(REDACTION_PLACEHOLDER);
  });

  it("handles missing issues: write permission with a clear, descriptive error", async () => {
    const forbiddenError = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
    });

    const mockOctokit: OctokitIssuesClient = {
      rest: {
        issues: {
          create: vi.fn().mockRejectedValue(forbiddenError),
        },
      },
    };

    await expect(
      createGitHubIssue(
        {
          owner: "acme",
          repo: "corp",
          title: "Test Issue",
          body: "Test Body",
        },
        { octokitClient: mockOctokit },
      ),
    ).rejects.toThrow(
      "The SecureFlow GitHub App lacks 'issues: write' permission on acme/corp. Please grant 'Issues: Read and write' in the GitHub App settings.",
    );
  });

  it("handles missing permissions during app repo installation lookup", async () => {
    const forbiddenError = Object.assign(new Error("Forbidden"), { status: 403 });

    const mockAppClient: GitHubAppClientLike = {
      octokit: {
        rest: {
          apps: {
            getRepoInstallation: vi.fn().mockRejectedValue(forbiddenError),
          },
        },
      },
      getInstallationOctokit: vi.fn(),
    };

    await expect(
      createGitHubIssue(
        {
          owner: "acme",
          repo: "corp",
          title: "Test Issue",
          body: "Test Body",
        },
        { appClient: mockAppClient },
      ),
    ).rejects.toThrow(GitHubPermissionError);
  });

  it("correctly identifies missing issues permission errors", () => {
    expect(isMissingIssuesPermissionError({ status: 403 })).toBe(true);
    expect(isMissingIssuesPermissionError({ statusCode: 403 })).toBe(true);
    expect(
      isMissingIssuesPermissionError(new Error("Resource not accessible by integration")),
    ).toBe(true);
    expect(isMissingIssuesPermissionError(new Error("The App lacks issues:write permission"))).toBe(
      true,
    );
    expect(isMissingIssuesPermissionError(new Error("Not Found"))).toBe(false);
  });
});
