import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";

export interface ArmorIQAuditLogInput {
  scanJobId?: string | null;
  findingId?: string | null;
  agentId: string;
  toolName: string;
  decision: "ALLOW" | "BLOCK" | "HOLD";
  ruleMatched?: string | null;
  justification?: string | null;
  proofHash?: string | null;
  signature?: string | null;
  intentId?: string | null;
  frameworks?: string[];
  privacyLevel?: "REDACTED" | "METADATA_ONLY" | "FULL";
  userId?: string | null;
}

import { decodeCursor, encodeCursor, buildCursorWhere } from "@/lib/pagination/cursor";

export interface ArmorIQTraceQuery {
  /** Authenticated owner. Logs are scoped through their scan job or finding. */
  userId: string;
  scanJobId?: string;
  findingId?: string;
  decision?: string;
  agentId?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
}

/**
 * Caches an ArmorIQ cryptographic enforcement decision and audit record into Prisma.
 * Also synchronizes with the system AuditLog ledger for dashboard visibility.
 */
export async function recordArmorIQAuditLog(input: ArmorIQAuditLogInput) {
  try {
    const log = await prisma.armorIQEnforcementLog.create({
      data: {
        scanJobId: input.scanJobId || null,
        findingId: input.findingId || null,
        agentId: input.agentId,
        toolName: input.toolName,
        decision: input.decision,
        ruleMatched: input.ruleMatched || null,
        justification: input.justification || null,
        proofHash: input.proofHash || null,
        signature: input.signature || null,
        intentId: input.intentId || null,
        frameworks: input.frameworks || ["SOC 2 (CC6.1, CC6.8)", "ISO 27001 (A.12.1.2)"],
        privacyLevel: input.privacyLevel || "METADATA_ONLY",
      },
    });

    // Mirror to AuditLog for unified timeline rendering in audit-log-table.tsx
    if (input.userId) {
      await prisma.auditLog.create({
        data: {
          userId: input.userId,
          action: `ARMORIQ_TOOL_${input.decision}`,
          resource: input.toolName,
          decision: input.decision,
          metadata: {
            isArmorIQ: true,
            armorIQLogId: log.id,
            agentId: input.agentId,
            toolName: input.toolName,
            rule: input.ruleMatched,
            reason: input.justification,
            proofHash: input.proofHash,
            signature: input.signature,
            intentId: input.intentId,
            complianceFrameworks: log.frameworks,
            privacyLevel: log.privacyLevel,
            scanJobId: input.scanJobId,
            findingId: input.findingId,
          },
        },
      });
    }

    return log;
  } catch (error) {
    logger.error("Failed to record ArmorIQ audit trace:", { error });
    return null;
  }
}

/**
 * Confirms that any scan job or finding referenced by an audit record belongs
 * to the authenticated user.
 *
 * ArmorIQEnforcementLog has no owner column of its own. Ownership is inherited
 * from the linked ScanJob.repository or Finding.scanResult.pullRequest.repository.
 * A caller must not be able to attach a forged enforcement record to another
 * tenant's scan by guessing its ID.
 */
export async function verifyArmorIQAuditResourceOwnership(input: {
  userId: string;
  scanJobId?: string | null;
  findingId?: string | null;
}): Promise<boolean> {
  const { userId, scanJobId, findingId } = input;
  if (!scanJobId && !findingId) return true;

  const checks: Array<Promise<unknown>> = [];

  if (scanJobId) {
    checks.push(
      prisma.scanJob.findFirst({
        where: { id: scanJobId, repository: { is: { userId } } },
        select: { id: true },
      }),
    );
  }

  if (findingId) {
    checks.push(
      prisma.finding.findFirst({
        where: {
          id: findingId,
          scanResult: {
            is: {
              pullRequest: {
                is: { repository: { is: { userId } } },
              },
            },
          },
        },
        select: { id: true },
      }),
    );
  }

  const results = await Promise.all(checks);
  return results.every(Boolean);
}

/**
 * Retrieves enforcement metadata and execution traces with strict privacy filtering.
 * Sensitive fine-grained raw tokens are stripped, leaving only verifiable compliance metadata.
 *
 * The query is always scoped to the authenticated user through the owning scan
 * job or finding. Logs with neither relation cannot be attributed to a tenant
 * and are therefore not returned.
 */
export async function fetchArmorIQAuditTraces(query: ArmorIQTraceQuery) {
  const { userId, scanJobId, findingId, decision, agentId, limit = 50, offset = 0, cursor } = query;

  const baseWhere: any = {
    OR: [
      { scanJob: { is: { repository: { is: { userId } } } } },
      {
        finding: {
          is: {
            scanResult: {
              is: {
                pullRequest: { is: { repository: { is: { userId } } } },
              },
            },
          },
        },
      },
    ],
  };
  if (scanJobId) baseWhere.scanJobId = scanJobId;
  if (findingId) baseWhere.findingId = findingId;
  if (decision) baseWhere.decision = decision;
  if (agentId) baseWhere.agentId = agentId;

  const decodedCursor = decodeCursor(cursor);
  const where: any = {
    ...baseWhere,
    ...(cursor ? buildCursorWhere(decodedCursor, "createdAt") : {}),
  };

  const clampedLimit = Math.min(Math.max(1, limit), 100);

  const [rawTraces, total] = await Promise.all([
    prisma.armorIQEnforcementLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: cursor ? clampedLimit + 1 : clampedLimit,
      skip: cursor ? 0 : offset,
      select: {
        id: true,
        scanJobId: true,
        findingId: true,
        agentId: true,
        toolName: true,
        decision: true,
        ruleMatched: true,
        justification: true,
        proofHash: true,
        signature: true,
        intentId: true,
        frameworks: true,
        privacyLevel: true,
        timestamp: true,
        createdAt: true,
      },
    }),
    prisma.armorIQEnforcementLog.count({ where: baseWhere }),
  ]);

  let nextCursor: string | null = null;
  let traces = rawTraces;

  if (cursor) {
    if (rawTraces.length > clampedLimit) {
      traces = rawTraces.slice(0, clampedLimit);
      nextCursor = encodeCursor(traces[traces.length - 1]);
    }
  } else if (rawTraces.length > 0) {
    // If next page exists by offset
    if (offset + rawTraces.length < total) {
      nextCursor = encodeCursor(rawTraces[rawTraces.length - 1]);
    }
  }

  return { traces, total, nextCursor };
}

/**
 * Builds an export-ready compliance evidence report mapped to SOC 2 and ISO 27001.
 */
export function buildComplianceReport(
  traces: Array<{
    id: string;
    agentId: string;
    toolName: string;
    decision: string;
    ruleMatched: string | null;
    justification: string | null;
    proofHash: string | null;
    signature: string | null;
    frameworks: string[];
    timestamp: Date;
  }>,
  framework: "SOC2" | "ISO27001" | "ALL" = "ALL",
) {
  return traces.map((trace) => ({
    auditId: trace.id,
    timestamp: trace.timestamp.toISOString(),
    agentId: trace.agentId,
    toolInvoked: trace.toolName,
    policyDecision: trace.decision,
    ruleEnforced: trace.ruleMatched || "Default Zero-Trust Boundary",
    justification: trace.justification || "Action evaluated under ArmorIQ runtime policy engine",
    cryptographicProof: trace.proofHash || "UNVERIFIED",
    signatureProvenance: trace.signature || "UNVERIFIED",
    complianceControls:
      framework === "SOC2"
        ? ["SOC 2 CC6.1 (Logical Access Controls)", "SOC 2 CC6.8 (Malicious Behavior Prevention)"]
        : framework === "ISO27001"
          ? ["ISO 27001 A.12.1.2 (Change Management)", "ISO 27001 A.14.2.8 (Security Testing)"]
          : trace.frameworks,
  }));
}
