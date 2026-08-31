/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
  import FindingsPage from "./page";
import * as authModule from "@/auth";
import * as findingsActions from "@/lib/actions/findings";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// Mock the new server actions instead of Prisma
vi.mock("@/lib/actions/findings", () => ({
  getUserFindings: vi.fn(),
  getUserFindingFilters: vi.fn(),
}));

vi.mock("./findings-client", () => ({
  default: ({ findings, stats, total }: { findings: any[]; stats: any; total: number }) => (
    <div data-testid="findings-client">
      <div data-testid="critical-count">{stats.criticalSecrets}</div>
      <div data-testid="vuln-count">{stats.vulnerabilities}</div>
      <div data-testid="misconfig-count">{stats.misconfigs}</div>
      <div data-testid="other-count">{stats.other}</div>
      <div data-testid="total-count">{total}</div>
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

    vi.mocked(findingsActions.getUserFindingFilters).mockResolvedValue({} as any);
    vi.mocked(findingsActions.getUserFindings).mockResolvedValue({
      findings: [
        {
          id: "finding-1",
          type: "SECRET",
          severity: "CRITICAL",
          fileLocation: "src/auth.ts",
        },
        {
          id: "finding-2",
          type: "VULNERABILITY",
          severity: "HIGH",
          fileLocation: "src/api/users.ts",
        },
      ],
      stats: { criticalSecrets: 3, vulnerabilities: 7, misconfigs: 2, other: 0 },
      total: 2,
      page: 1,
      pageSize: 50,
      totalPages: 1,
    } as any);

    // Pass the required searchParams Promise to the server component
    const pageElement = await FindingsPage({ searchParams: Promise.resolve({}) });
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