/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import FindingsPage from "./page";
import prisma from "@/lib/prisma";
import * as authModule from "@/auth";
import * as triageQueries from "@/lib/triage/queries";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/triage/queries", () => ({
  getUserTriage: vi.fn(),
  triageKey: (repoId: string, fp: string) => `${repoId}:${fp}`,
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("./findings-client", () => ({
  default: ({ findings, stats }: { findings: any[]; stats: any }) => (
    <div data-testid="findings-client">
      <div data-testid="critical-count">{stats.criticalSecrets}</div>
      <div data-testid="vuln-count">{stats.vulnerabilities}</div>
      <div data-testid="misconfig-count">{stats.misconfigs}</div>
      <div data-testid="other-count">{stats.other}</div>
      <div data-testid="findings-list">
        {findings.map((f) => (
          <div key={f.id} data-testid="finding-item">
            {f.type}:{f.severity}:{f.fileLocation}
          </div>
        ))}
      </div>
    </div>
  ),
}));

describe("Findings Page Server Component (#633)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("populates findings and stats from database accurately", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-123" },
    } as any);

    vi.mocked(triageQueries.getUserTriage).mockResolvedValue({
      suppressedFingerprints: [],
      byKey: new Map(),
    });

    vi.mocked(prisma.finding.count)
      .mockResolvedValueOnce(3) // critical secrets
      .mockResolvedValueOnce(7) // vulnerabilities
      .mockResolvedValueOnce(2); // misconfigs

    vi.mocked(prisma.finding.findMany).mockResolvedValue([
      {
        id: "finding-1",
        type: "SECRET",
        severity: "CRITICAL",
        fileLocation: "src/auth.ts",
        fingerprint: "fp-1",
        scanResult: {
          id: "scan-1",
          pullRequest: {
            id: "pr-1",
            repositoryId: "repo-1",
            githubId: BigInt(556677),
          },
        },
      },
      {
        id: "finding-2",
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: "src/api/users.ts",
        fingerprint: "fp-2",
        scanResult: {
          id: "scan-1",
          pullRequest: {
            id: "pr-1",
            repositoryId: "repo-1",
            githubId: BigInt(556677),
          },
        },
      },
    ] as any);

    const pageElement = await FindingsPage();
    render(pageElement);

    expect(screen.getByTestId("critical-count").textContent).toBe("3");
    expect(screen.getByTestId("vuln-count").textContent).toBe("7");
    expect(screen.getByTestId("misconfig-count").textContent).toBe("2");
    expect(screen.getByTestId("other-count").textContent).toBe("0");

    const items = screen.getAllByTestId("finding-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("SECRET:CRITICAL:src/auth.ts");
    expect(items[1].textContent).toContain("VULNERABILITY:HIGH:src/api/users.ts");
  });
});
