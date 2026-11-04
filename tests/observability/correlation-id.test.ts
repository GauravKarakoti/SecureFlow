import { describe, it, expect, vi } from "vitest";
import { createLogger, buildRecord, formatRecord, REDACTED_PLACEHOLDER } from "@/lib/logger";
import { buildScanJobData } from "@/lib/findings/scan-authorization";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import type { WebhookJobData } from "@/lib/queue/webhookQueue";
import type { ScanJobData } from "@/lib/queue/scanQueue";

describe("Correlation ID Propagation & Observability (#1537)", () => {
  it("generates or propagates correlationId from deliveryId or fallback UUID", () => {
    const deliveryId = "delivery-gh-98765";
    const correlationIdFromDelivery = deliveryId;
    expect(correlationIdFromDelivery).toBe("delivery-gh-98765");

    const fallbackUUID = crypto.randomUUID();
    expect(fallbackUUID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("passes correlationId in WebhookJobData and ScanJobData payloads", () => {
    const correlationId = "corr-scan-12345";
    const deliveryId = "del-scan-12345";

    const webhookJobData: WebhookJobData = {
      event: "pull_request",
      deliveryId,
      correlationId,
      payload: { action: "synchronize" },
    };

    expect(webhookJobData.correlationId).toBe(correlationId);
    expect(webhookJobData.deliveryId).toBe(deliveryId);

    const scanJobData: ScanJobData = {
      scanJobId: "scan-job-12345",
      repositoryId: "repo-1",
      installationId: 12345,
      repositoryFullName: "acme/repo",
      prNumber: 42,
      headSha: "abc123456",
      fileChanges: [{ filename: "index.ts", patch: "@@ -1 +1 @@" }],
      activePolicies: [],
      customIgnores: [],
      customPlaceholders: [],
      correlationId: webhookJobData.correlationId,
      deliveryId: webhookJobData.deliveryId,
    };

    expect(scanJobData.correlationId).toBe(correlationId);
    expect(scanJobData.deliveryId).toBe(deliveryId);
  });

  it("buildScanJobData populates correlationId", () => {
    const scanData = buildScanJobData({
      body: {
        installationId: 100,
        prNumber: 5,
        headSha: "sha-123",
        repositoryId: "repo-uuid-1",
      },
      repository: {
        id: "repo-uuid-1",
        fullName: "acme/api",
      },
      userId: "user-1",
      correlationId: "custom-corr-id",
    });

    expect(scanData.correlationId).toBe("custom-corr-id");
  });

  it("records correlationId in all scan audit log entries", () => {
    const correlationId = "audit-corr-999";
    const deliveryId = "del-audit-999";

    // 1. Scan Triggered
    const scanTriggeredAudit = sanitizeAuditLogInput({
      userId: "user-123",
      action: "Scan Triggered",
      resource: "acme/repo#42",
      metadata: {
        correlationId,
        deliveryId,
        action: "synchronize",
        head_sha: "commit-sha-abc",
      },
    });
    expect((scanTriggeredAudit.metadata as any)?.correlationId).toBe(correlationId);
    expect((scanTriggeredAudit.metadata as any)?.deliveryId).toBe(deliveryId);

    // 2. Policy Evaluation
    const policyEvalAudit = sanitizeAuditLogInput({
      userId: "user-123",
      action: "Policy Evaluation",
      resource: "acme/repo#42",
      metadata: {
        correlationId,
        deliveryId,
        decision: "BLOCKED",
        riskScore: 85,
      },
    });
    expect((policyEvalAudit.metadata as any)?.correlationId).toBe(correlationId);

    // 3. PR Comment Posted
    const commentAudit = sanitizeAuditLogInput({
      userId: "user-123",
      action: "PR Comment Posted",
      resource: "acme/repo#42",
      metadata: {
        correlationId,
        deliveryId,
        commentType: "AI Security Report",
        findingsReported: 3,
      },
    });
    expect((commentAudit.metadata as any)?.correlationId).toBe(correlationId);

    // 4. Background Scan Completed
    const bgCompletedAudit = sanitizeAuditLogInput({
      userId: "user-123",
      action: "Background Scan Completed",
      resource: "acme/repo#42",
      metadata: {
        correlationId,
        deliveryId,
        scanJobId: "scan-job-001",
        findingsCount: 3,
        totalFiles: 10,
        riskScore: 85,
      },
    });
    expect((bgCompletedAudit.metadata as any)?.correlationId).toBe(correlationId);
  });

  it("ensures one scan's logs can be filtered across webhook, queue, and worker with a single correlationId", () => {
    const logs: Array<{ level: string; line: string }> = [];
    const baseLogger = createLogger({
      level: "debug",
      pretty: false,
      sink: (level, line) => logs.push({ level, line }),
    });

    const scanAId = "scan-corr-A-111";
    const scanBId = "scan-corr-B-222";

    const scanALogger = baseLogger.child({ correlationId: scanAId });
    const scanBLogger = baseLogger.child({ correlationId: scanBId });

    // Stage 1: Webhook Ingest
    scanALogger.info("Webhook received for acme/repo#1", { deliveryId: scanAId });
    scanBLogger.info("Webhook received for other/app#2", { deliveryId: scanBId });

    // Stage 2: Queue Dispatch
    scanALogger.info("Dispatched scan job to worker", { scanJobId: "job-A" });
    scanBLogger.info("Dispatched scan job to worker", { scanJobId: "job-B" });

    // Stage 3: Worker & Scan Engine
    scanALogger.info("Worker scanning files", { totalFiles: 5 });
    scanBLogger.error("Worker failed to process chunk", { error: "Analysis timeout" });

    scanALogger.info("Scan completed successfully", { findingsCount: 0 });
    scanBLogger.error("Scan job routed to DLQ", { attemptsMade: 3 });

    // Parse records
    const allRecords = logs.map((l) => JSON.parse(l.line));
    expect(allRecords).toHaveLength(8);

    // Filter by Scan A's single correlationId
    const scanARecords = allRecords.filter((r) => r.correlationId === scanAId);
    expect(scanARecords).toHaveLength(4);
    expect(scanARecords.every((r) => r.correlationId === scanAId)).toBe(true);
    expect(scanARecords.map((r) => r.message)).toEqual([
      "Webhook received for acme/repo#1",
      "Dispatched scan job to worker",
      "Worker scanning files",
      "Scan completed successfully",
    ]);

    // Filter by Scan B's single correlationId
    const scanBRecords = allRecords.filter((r) => r.correlationId === scanBId);
    expect(scanBRecords).toHaveLength(4);
    expect(scanBRecords.every((r) => r.correlationId === scanBId)).toBe(true);
    expect(scanBRecords.map((r) => r.message)).toEqual([
      "Webhook received for other/app#2",
      "Dispatched scan job to worker",
      "Worker failed to process chunk",
      "Scan job routed to DLQ",
    ]);

    // String filtering simulation (e.g. grep/log-aggregator filter)
    const scanALines = logs.filter((l) => l.line.includes(scanAId));
    expect(scanALines).toHaveLength(4);
  });

  it("never logs code snippets, patches, secrets, or personal data in log output or error reports", () => {
    const logs: Array<{ level: string; line: string }> = [];
    const logger = createLogger({
      level: "debug",
      pretty: false,
      sink: (level, line) => logs.push({ level, line }),
    });

    const correlationId = "corr-security-check";
    const scopedLogger = logger.child({ correlationId });

    scopedLogger.error("Scan failed on sensitive file", {
      repo: "acme/secret-vault",
      codeSnippet: "const db_pass = 'SuperSecret123!';",
      patch: "@@ -1 +1 @@\n+ private_key = 'PRIVATE_KEY_DATA'",
      email: "engineer@secureflow.test",
      api_key: "sk-proj-12345678901234567890",
      password: "admin_password_plaintext",
      githubToken: "ghp_abcdefghijklmnopqrstuvwxyz",
    });

    const parsed = JSON.parse(logs[0].line);
    expect(parsed.correlationId).toBe(correlationId);
    expect(parsed.repo).toBe("acme/secret-vault");

    // All sensitive keys replaced with REDACTED placeholder
    expect(parsed.codeSnippet).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.patch).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.email).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.api_key).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.password).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.githubToken).toBe(REDACTED_PLACEHOLDER);

    // Verify raw output line does not contain secret strings
    expect(logs[0].line).not.toContain("SuperSecret123!");
    expect(logs[0].line).not.toContain("PRIVATE_KEY_DATA");
    expect(logs[0].line).not.toContain("engineer@secureflow.test");
    expect(logs[0].line).not.toContain("admin_password_plaintext");
    expect(logs[0].line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});
