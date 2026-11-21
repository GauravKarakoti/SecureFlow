import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  previewPolicyImpact,
  estimateFilesTokens,
  createEmptySeverityComparison,
  DEFAULT_PREVIEW_MAX_SCANS,
  DEFAULT_PREVIEW_MAX_TOKENS,
} from "./preview-impact";
import type { FileChange, ScanFinding, ScannerPolicy } from "@/lib/armor/scanner";

describe("Policy Impact Preview (src/lib/policies/preview-impact.ts) (#1892)", () => {
  const mockUserId = "user-123";
  const mockTemplateId = "tpl-secrets-1";

  const currentTemplate = {
    id: mockTemplateId,
    name: "Block Hardcoded Secrets",
    description: "Detect hardcoded API keys and credentials in code",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: true,
  };

  const sampleFiles: FileChange[] = [
    {
      filename: "auth.ts",
      patch: "@@ -0,0 +1,5 @@\n+const apiKey = 'gsk_12345';\n+export function login() {}\n",
    },
    {
      filename: "config.json",
      patch: "@@ -0,0 +1,3 @@\n+{\n+  'token': 'secret'\n+}\n",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates file token estimates accurately", () => {
    const tokens = estimateFilesTokens(sampleFiles);
    expect(tokens).toBeGreaterThan(0);
    // auth.ts patch length ~60 chars -> ~15 tokens, config.json ~30 chars -> ~8 tokens
    expect(tokens).toBe(
      Math.ceil(sampleFiles[0].patch.length / 4) + Math.ceil(sampleFiles[1].patch.length / 4),
    );
  });

  describe("empty history handling", () => {
    it("returns clear message when user has no repositories", async () => {
      const mockDb = {
        policyTemplate: {
          findUnique: vi.fn().mockResolvedValue(currentTemplate),
        },
        repository: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as any;

      const result = await previewPolicyImpact({
        userId: mockUserId,
        templateId: mockTemplateId,
        draftDescription: "Stricter secrets policy",
        db: mockDb,
      });

      expect(result.ok).toBe(true);
      expect(result.hasHistory).toBe(false);
      expect(result.replayedScans).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.message).toMatch(/No repositories found/i);
      expect(result.severityComparison.TOTAL.newCount).toBe(0);
    });

    it("returns clear message when repositories have no stored scan inputs or findings", async () => {
      const mockDb = {
        policyTemplate: {
          findUnique: vi.fn().mockResolvedValue(currentTemplate),
        },
        repository: {
          findMany: vi.fn().mockResolvedValue([{ id: "repo-1" }, { id: "repo-2" }]),
        },
        storedScanInput: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        scanResult: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as any;

      const result = await previewPolicyImpact({
        userId: mockUserId,
        templateId: mockTemplateId,
        draftDescription: "Stricter secrets policy",
        db: mockDb,
      });

      expect(result.ok).toBe(true);
      expect(result.hasHistory).toBe(false);
      expect(result.replayedScans).toBe(0);
      expect(result.message).toMatch(/Too little history exists for a meaningful preview/i);
    });
  });

  describe("capped history and token limits", () => {
    it("respects maxScans limit and caps replayed scans", async () => {
      const mockDb = {
        policyTemplate: {
          findUnique: vi.fn().mockResolvedValue(currentTemplate),
        },
        repository: {
          findMany: vi.fn().mockResolvedValue([{ id: "repo-1" }]),
        },
        storedScanInput: {
          findMany: vi.fn().mockImplementation(({ take }) => {
            // Generate 10 stored inputs
            const items = Array.from({ length: 10 }, (_, i) => ({
              id: `input-${i}`,
              repositoryId: "repo-1",
              filesJson: JSON.stringify(sampleFiles),
              tokenEstimate: 50,
            }));
            return Promise.resolve(items.slice(0, take));
          }),
        },
      } as any;

      const mockScanner = vi.fn().mockResolvedValue([]);

      const result = await previewPolicyImpact({
        userId: mockUserId,
        templateId: mockTemplateId,
        draftDescription: "Draft policy phrasing",
        maxScans: 3,
        db: mockDb,
        scannerFn: mockScanner,
      });

      expect(result.ok).toBe(true);
      expect(result.hasHistory).toBe(true);
      expect(result.replayedScans).toBe(3);
      // Scanner called twice per scan (current + draft): 3 * 2 = 6 calls
      expect(mockScanner).toHaveBeenCalledTimes(6);
    });

    it("caps execution when cumulative tokens reach maxTokens budget", async () => {
      const mockDb = {
        policyTemplate: {
          findUnique: vi.fn().mockResolvedValue(currentTemplate),
        },
        repository: {
          findMany: vi.fn().mockResolvedValue([{ id: "repo-1" }]),
        },
        storedScanInput: {
          findMany: vi.fn().mockResolvedValue([
            { id: "input-1", filesJson: JSON.stringify(sampleFiles), tokenEstimate: 400 },
            { id: "input-2", filesJson: JSON.stringify(sampleFiles), tokenEstimate: 400 },
            { id: "input-3", filesJson: JSON.stringify(sampleFiles), tokenEstimate: 400 },
          ]),
        },
      } as any;

      const mockScanner = vi.fn().mockResolvedValue([]);

      const result = await previewPolicyImpact({
        userId: mockUserId,
        templateId: mockTemplateId,
        draftDescription: "Draft policy phrasing",
        maxTokens: 500, // Budget allows 1 scan (400 tokens), 2nd scan (400+400=800) would exceed
        db: mockDb,
        scannerFn: mockScanner,
      });

      expect(result.ok).toBe(true);
      expect(result.replayedScans).toBe(1);
      expect(result.totalTokens).toBe(400);
      expect(result.tokensBudgetExceeded).toBe(true);
    });
  });

  describe("finding comparison & severity breakdown", () => {
    it("correctly identifies new, removed, and unchanged findings with severity counts", async () => {
      const mockDb = {
        policyTemplate: {
          findUnique: vi.fn().mockResolvedValue(currentTemplate),
        },
        repository: {
          findMany: vi.fn().mockResolvedValue([{ id: "repo-1" }]),
        },
        storedScanInput: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: "input-1", filesJson: JSON.stringify(sampleFiles), tokenEstimate: 50 },
            ]),
        },
      } as any;

      const currentFindings: ScanFinding[] = [
        {
          type: "Secret",
          severity: "HIGH",
          description: "High severity secret finding in auth.ts",
          fileLocation: "auth.ts",
          codeSnippet: "const apiKey = 'gsk_12345';",
          lineStart: 1,
        },
        {
          type: "Secret",
          severity: "MEDIUM",
          description: "Medium severity finding to be removed in draft",
          fileLocation: "config.json",
          codeSnippet: "token: 'secret'",
          lineStart: 2,
        },
      ];

      const draftFindings: ScanFinding[] = [
        {
          type: "Secret",
          severity: "HIGH",
          description: "High severity secret finding in auth.ts", // UNCHANGED
          fileLocation: "auth.ts",
          codeSnippet: "const apiKey = 'gsk_12345';",
          lineStart: 1,
        },
        {
          type: "Secret",
          severity: "CRITICAL",
          description: "Brand new critical severity finding caught by draft rule", // NEW
          fileLocation: "auth.ts",
          codeSnippet: "const master = 'root';",
          lineStart: 4,
        },
      ];

      const mockScanner = vi.fn().mockImplementation((_files, policies: ScannerPolicy[]) => {
        if (policies[0].description === currentTemplate.description) {
          return Promise.resolve(currentFindings);
        }
        return Promise.resolve(draftFindings);
      });

      const result = await previewPolicyImpact({
        userId: mockUserId,
        templateId: mockTemplateId,
        draftDescription: "Tighter regex rule catching master credentials",
        db: mockDb,
        scannerFn: mockScanner,
      });

      expect(result.ok).toBe(true);
      expect(result.hasHistory).toBe(true);
      expect(result.replayedScans).toBe(1);

      // Check categorized findings
      expect(result.findings.unchanged).toHaveLength(1);
      expect(result.findings.unchanged[0].description).toBe(
        "High severity secret finding in auth.ts",
      );

      expect(result.findings.new).toHaveLength(1);
      expect(result.findings.new[0].description).toBe(
        "Brand new critical severity finding caught by draft rule",
      );
      expect(result.findings.new[0].severity).toBe("CRITICAL");

      expect(result.findings.removed).toHaveLength(1);
      expect(result.findings.removed[0].description).toBe(
        "Medium severity finding to be removed in draft",
      );
      expect(result.findings.removed[0].severity).toBe("MEDIUM");

      // Check severity comparison counts
      expect(result.severityComparison.CRITICAL).toEqual({
        unchanged: 0,
        newCount: 1,
        removedCount: 0,
        netChange: 1,
      });
      expect(result.severityComparison.HIGH).toEqual({
        unchanged: 1,
        newCount: 0,
        removedCount: 0,
        netChange: 0,
      });
      expect(result.severityComparison.MEDIUM).toEqual({
        unchanged: 0,
        newCount: 0,
        removedCount: 1,
        netChange: -1,
      });
      expect(result.severityComparison.TOTAL).toEqual({
        unchanged: 1,
        newCount: 1,
        removedCount: 1,
        netChange: 0,
      });
    });
  });

  describe("zero side effects guarantee", () => {
    it("never calls database create/update or posts comments/check-runs", async () => {
      const mockFindingCreate = vi.fn();
      const mockScanResultCreate = vi.fn();
      const mockAuditLogCreate = vi.fn();

      const mockDb = {
        policyTemplate: {
          findUnique: vi.fn().mockResolvedValue(currentTemplate),
        },
        repository: {
          findMany: vi.fn().mockResolvedValue([{ id: "repo-1" }]),
        },
        storedScanInput: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: "input-1", filesJson: JSON.stringify(sampleFiles), tokenEstimate: 50 },
            ]),
        },
        finding: {
          create: mockFindingCreate,
        },
        scanResult: {
          create: mockScanResultCreate,
        },
        auditLog: {
          create: mockAuditLogCreate,
        },
      } as any;

      const mockScanner = vi.fn().mockResolvedValue([]);

      await previewPolicyImpact({
        userId: mockUserId,
        templateId: mockTemplateId,
        draftDescription: "Draft policy rule",
        db: mockDb,
        scannerFn: mockScanner,
      });

      expect(mockFindingCreate).not.toHaveBeenCalled();
      expect(mockScanResultCreate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });
  });
});
